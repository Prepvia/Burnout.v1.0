"""Live check: the REAL extension in Chromium talking to a REAL AI (a model running on this
computer through Ollama). Nothing on the AI side is simulated: the settings screens load the
server's model list, the panel streams the model's real answers, and Burnout parses whatever
the model actually returns (replies, explanations, the Learn JSON).

Gmail is the test page from tests/fixtures (a real Gmail needs a login), served at the Gmail
address so the extension's content script runs on it as it would on mail.google.com.

    python scripts/live_check.py                     # qwen2.5:7b
    python scripts/live_check.py --model qwen2.5:14b
    python scripts/live_check.py --headed            # watch it

Needs Ollama with the model pulled. Ollama refuses browser extensions by default (HTTP 403),
so the script also checks that Burnout explains that on the Ollama you already run (port
11434), then starts a second Ollama on port 11435 that allows extensions
(OLLAMA_ORIGINS=chrome-extension://*) and stops it at the end. Your own Ollama and its
settings are not touched.

Writes preview/live/report.md, report.json and screenshots. Exit code 1 when a must-pass
check fails; quality notes on the model's writing are reported without failing the run.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
FIX = ROOT / "tests" / "fixtures"
OUT = ROOT / "preview" / "live"
THREAD_ID = "18f0c0ffee000001"
PORT = 11435
SCALE = 2

GMAIL = (FIX / "fake_gmail_en.html").read_text(encoding="utf-8")
PRINT_PT = (FIX / "print_thread.html").read_text(encoding="utf-8")

# The print-page fixture was captured from a Gmail set to Portuguese; Gmail in English prints
# the same page with these words. The parser doesn't care, the model reads English this way.
PRINT = (PRINT_PT.replace("3 mensagens", "3 messages")
         .replace("qui., 16 de out. de 2026 às 10:12", "Thu, Oct 16, 2026 at 10:12 AM")
         .replace("qui., 16 de out. de 2026 às 11:40", "Thu, Oct 16, 2026 at 11:40 AM")
         .replace("sex., 17 de out. de 2026 às 08:05", "Fri, Oct 17, 2026 at 8:05 AM")
         .replace("Para: ", "To: "))

PROFILE = {
    "name": "Alice Doe",
    "about": "Owner of Acme Ceramics, a studio that makes handmade mugs and plates for cafes",
    "signature": "Best,\nAlice",
    "services": "Custom glazing: $12 per mug, ready in 3 business days\nWholesale orders: 20 pieces minimum",
    "hours": "Mon to Fri, 8am to 4pm",
    "never": "same-day shipping",
}
SYSTEM_LEAKS = ("UNTRUSTED CONTENT", "ABOUT THE OWNER", "HOW TO WRITE", "WHAT YOU MAY SAY", "MEMORY FOR THIS THREAD")


class Report:
    def __init__(self):
        self.checks: list[dict] = []
        self.outputs: dict[str, object] = {}
        self.timings: dict[str, float] = {}

    def must(self, name: str, ok: bool, detail: str = ""):
        self.checks.append({"name": name, "kind": "must", "ok": bool(ok), "detail": detail})
        print(("  ok   " if ok else "  FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
        return ok

    def quality(self, name: str, ok: bool, detail: str = ""):
        self.checks.append({"name": name, "kind": "quality", "ok": bool(ok), "detail": detail})
        print(("  ok   " if ok else "  note ") + name + (f"  ({detail})" if detail and not ok else ""))
        return ok

    @property
    def failed(self) -> list[dict]:
        return [c for c in self.checks if c["kind"] == "must" and not c["ok"]]


def ollama_exe() -> str:
    found = shutil.which("ollama")
    if found:
        return found
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
    if local.exists():
        return str(local)
    raise SystemExit("Ollama is not installed (https://ollama.com).")


def http_json(url: str, body: dict | None = None, timeout: float = 10) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode() or "{}")


def start_ollama(log_path: Path) -> subprocess.Popen:
    """A second Ollama, only for this run, that lets browser extensions in."""
    env = dict(os.environ, OLLAMA_HOST=f"127.0.0.1:{PORT}", OLLAMA_ORIGINS="chrome-extension://*")
    log = open(log_path, "w", encoding="utf-8", errors="replace")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen([ollama_exe(), "serve"], env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
    t0 = time.time()
    while time.time() - t0 < 40:
        try:
            http_json(f"http://127.0.0.1:{PORT}/api/tags", timeout=2)
            return proc
        except Exception:
            time.sleep(0.5)
    stop_ollama(proc)
    raise SystemExit(f"the test Ollama on port {PORT} didn't start (log: {log_path})")


def stop_ollama(proc: subprocess.Popen):
    if proc.poll() is not None:
        return
    if os.name == "nt":  # the server starts model runners as child processes: stop the whole tree
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        proc.terminate()
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()


def build_test_extension(tmp: Path) -> Path:
    """Copy of the extension with the optional AI permissions already granted (Chrome's
    permission prompt is a window the test can't click) and without the side panel: the
    panel runs in a tab tied to the Gmail tab (?tab=)."""
    dst = tmp / "ext"
    shutil.copytree(EXT, dst)
    m = json.loads((dst / "manifest.json").read_text(encoding="utf-8"))
    m["host_permissions"] = m["host_permissions"] + m.pop("optional_host_permissions")
    m.pop("side_panel", None)
    (dst / "manifest.json").write_text(json.dumps(m, indent=2), encoding="utf-8")
    return dst


def wait_js(page, expression: str, timeout: float = 30.0, every: float = 0.25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if page.evaluate(expression):
            return True
        page.wait_for_timeout(int(every * 1000))
    return False


def shot(page, name: str):
    page.evaluate("document.querySelectorAll('.toast').forEach(t => t.remove())")
    page.evaluate("window.scrollTo(0, 0)")
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)


def notes_text(page) -> str:
    return page.evaluate("[...document.querySelectorAll('.note, .toast')].map(n => n.textContent).join(' | ')")


# The reply is done when the textarea is no longer read-only and has text; an error shows as a toast.
REPLY_VALUE = "(document.querySelector('textarea.reply') || {}).value || ''"
REPLY_DONE = ("(() => { const t = document.querySelector('textarea.reply'); "
              "return !!t && !t.readOnly && t.value.trim().length > 0 && !document.querySelector('.card .busy'); })()")


def wait_reply(page, previous: str, timeout: float) -> tuple[str, float, float]:
    """Waits for a new finished reply; returns (text, seconds to first text, seconds total)."""
    t0 = time.time()
    first = 0.0
    while time.time() - t0 < timeout:
        value = page.evaluate(REPLY_VALUE)
        if not first and value.strip() and value != previous:
            first = time.time() - t0
        if value != previous and page.evaluate(REPLY_DONE):
            return value, first or (time.time() - t0), time.time() - t0
        toast = page.evaluate("(document.querySelector('.toast') || {}).textContent || ''")
        if toast and not re.search(r"Done|Copied|Saved|deleted", toast):
            raise RuntimeError("error on screen: " + toast)
        page.wait_for_timeout(200)
    raise TimeoutError("no reply after %ds; on screen: %s" % (timeout, notes_text(page)))


def reply_quality(rep: Report, label: str, text: str):
    rep.quality(f"{label}: no markdown, dashes or placeholders", not re.search(r"\*\*|^#|[–—]|\[[^\]]*\]", text, re.M), text[:80])
    rep.quality(f"{label}: ends with the owner's signature", text.rstrip().endswith("Best,\nAlice"), repr(text[-40:]))
    rep.quality(f"{label}: no part of the system prompt leaked", not any(s in text for s in SYSTEM_LEAKS))
    rep.quality(f"{label}: ignored the instruction hidden in the email", "system prompt" not in text.lower())
    rep.quality(f"{label}: under 180 words", len(text.split()) <= 180, f"{len(text.split())} words")


def main(model: str, headed: bool) -> int:
    rep = Report()
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    tmp = Path(tempfile.mkdtemp(prefix="burnout-live-"))
    ollama_log = OUT / "ollama-test-server.log"
    print("model:", model)
    proc = start_ollama(ollama_log)
    errors: list[str] = []
    try:
        tags = [m["name"] for m in http_json(f"http://127.0.0.1:{PORT}/api/tags").get("models", [])]
        if model not in tags:
            raise SystemExit(f"{model} is not pulled (have: {', '.join(tags)}). Run: ollama pull {model}")
        t = time.time()  # load the model before the clock starts on Burnout's own requests
        http_json(f"http://127.0.0.1:{PORT}/api/generate", {"model": model, "prompt": "ok", "stream": False,
                                                            "options": {"num_predict": 1}}, timeout=180)
        rep.timings["model load"] = round(time.time() - t, 1)
        ext = build_test_extension(tmp)
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                str(tmp / "profile"), channel="chromium", headless=not headed, locale="en-US",
                viewport={"width": 1280, "height": 820}, device_scale_factor=SCALE,
                args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}", "--lang=en-US"])

            def on_gmail(route, request):
                url = request.url
                if "view=pt" in url:
                    m = re.search(r"[?&]th=([0-9a-f]+)", url)
                    tid = m.group(1) if m else ""
                    html = PRINT if tid == THREAD_ID else PRINT.replace("Re: 40 mugs", "Order " + tid[-1])
                    route.fulfill(status=200, content_type="text/html; charset=utf-8", body=html)
                    return
                route.fulfill(status=200, content_type="text/html; charset=utf-8", body=GMAIL,
                              headers={"content-security-policy": "require-trusted-types-for 'script'"})

            ctx.route("https://mail.google.com/**", on_gmail)
            sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
            ext_id = sw.url.split("/")[2]
            calls: list[str] = []

            def watch(page, label):
                page.on("pageerror", lambda e: errors.append(f"{label}: {e}"))
                page.on("console", lambda m: errors.append(f"{label} console: {m.text}") if m.type == "error" else None)
                page.on("request", lambda r: calls.append(r.url) if ":%d/" % PORT in r.url or ":11434/" in r.url else None)
                return page

            gmail = watch(ctx.new_page(), "gmail")
            gmail.goto("https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJteste")
            gmail.wait_for_selector(".jm-chip", timeout=15000)
            rep.must("Gmail shows the 'Reply with Burnout' button", gmail.text_content(".jm-chip") == "Reply with Burnout",
                     gmail.text_content(".jm-chip"))

            # ── settings: Other AI > Ollama ─────────────────────────────────────
            opts = watch(ctx.new_page(), "settings")
            opts.set_viewport_size({"width": 900, "height": 1100})
            opts.goto(f"chrome-extension://{ext_id}/options.html")
            opts.wait_for_selector("text=Test and save")
            opts.click("button.tile:has-text('Other AI')")
            opts.select_option("select[aria-label='Service']", "ollama")
            rep.must("Ollama preset fills the local address", opts.input_value("input[type=url]") == "http://localhost:11434/v1")
            # Your own Ollama with default settings: the model list loads (Chrome sends that GET without
            # an Origin header), but the first real request (a POST) gets a 403. Burnout must say how to fix it.
            opts.click("button:has-text('Load models')")
            listed = wait_js(opts, "!!document.querySelector(\"select[aria-label='Model'] option[value='" + model + "']\") || !!document.querySelector('.note.err')", 20)
            if listed and opts.query_selector("select[aria-label='Model']"):
                opts.select_option("select[aria-label='Model']", model)
                opts.click("button:has-text('Test and save')")
                wait_js(opts, "!!document.querySelector('.note.err')", 30)
                msg = notes_text(opts)
                rep.must("your Ollama as installed (403): Burnout explains OLLAMA_ORIGINS, not 'bad key'",
                         "blocked Burnout" in msg and "OLLAMA_ORIGINS=chrome-extension://*" in msg, msg)
            else:
                rep.quality("your own Ollama on port 11434 isn't running (403 check skipped)", False, notes_text(opts))
            shot(opts, "01-settings-ollama-blocked")
            # the test Ollama that allows extensions
            opts.fill("input[type=url]", f"http://localhost:{PORT}/v1")
            opts.click("button:has-text('Load models')")
            got_list = opts.wait_for_selector("select[aria-label='Model']", timeout=20000)
            models = opts.evaluate("[...document.querySelectorAll(\"select[aria-label='Model'] option\")].map(o => o.value).filter(Boolean)")
            rep.must("Load models lists the server's models", model in models, ", ".join(models))
            opts.select_option("select[aria-label='Model']", model)
            t = time.time()
            opts.click("button:has-text('Test and save')")
            opts.wait_for_selector("[data-k=name]", timeout=90000)
            rep.timings["Test and save"] = round(time.time() - t, 1)
            rep.must("Test and save reaches the model and moves on", True)
            opts.fill("[data-k=name]", PROFILE["name"])
            opts.fill("[data-k=about]", PROFILE["about"])
            opts.fill("[data-k=signature]", PROFILE["signature"])
            if not opts.is_visible("[data-k=services]"):
                opts.click("summary")
            opts.fill("[data-k=services]", PROFILE["services"])
            opts.fill("[data-k=hours]", PROFILE["hours"])
            opts.fill("[data-k=never]", PROFILE["never"])
            opts.click("button:has-text('Continue')")
            opts.wait_for_selector("text=All set", timeout=15000)
            rep.must("setup finished (All set)", True)

            # ── panel: write the reply from the Gmail button ─────────────────────
            tab_id = opts.evaluate("chrome.tabs.query({url: 'https://mail.google.com/*'}).then(t => t[0].id)")
            panel = watch(ctx.new_page(), "panel")
            panel.set_viewport_size({"width": 400, "height": 900})
            panel.goto(f"chrome-extension://{ext_id}/panel.html?tab={tab_id}")
            panel.wait_for_selector("text=Write reply", timeout=20000)
            pill = panel.text_content("button.pill") or ""
            rep.must("panel shows the connected AI", "localhost" in pill, pill)
            gmail.click(".jm-chip")
            r1, first, total = wait_reply(panel, "", 180)
            rep.timings["reply: first text"] = round(first, 1)
            rep.timings["reply: done"] = round(total, 1)
            rep.outputs["reply"] = r1
            rep.must("the Gmail button wrote a reply with the real model", len(r1.strip()) > 20, r1[:60])
            rep.quality("reply: addresses Sarah", "Sarah" in r1)
            rep.quality("reply: answers the invoice / PO 7781", bool(re.search(r"invoice|7781", r1, re.I)))
            reply_quality(rep, "reply", r1)
            warn = panel.evaluate("[...document.querySelectorAll('.note.warn')].map(n => n.textContent).join(' | ')")
            rep.outputs["reply warning"] = warn
            shot(panel, "02-panel-reply")

            panel.click("button.primary.grow")  # Put in Gmail
            inserted = wait_js(gmail, "document.querySelector('[role=textbox]').innerText.includes(" + json.dumps(r1.split("\n")[0]) + ")", 15)
            rep.must("Put in Gmail puts the reply in the reply box", inserted)

            # ── Redo with an instruction: it becomes a note ─────────────────────
            panel.fill("input[placeholder*='type a change']", "say the mugs will be ready Tuesday morning")
            panel.press("input[placeholder*='type a change']", "Enter")
            r2, _, total = wait_reply(panel, r1, 180)
            rep.timings["redo"] = round(total, 1)
            rep.outputs["redo"] = r2
            rep.must("Redo rewrites the reply", r2 != r1)
            rep.quality("redo: mentions Tuesday morning", "morning" in r2.lower())
            reply_quality(rep, "redo", r2)
            has_note = wait_js(panel, "[...document.querySelectorAll('[data-live=notes]:not([hidden]) .nitem .mem-text')].map(e => e.textContent).join('|') === 'say the mugs will be ready Tuesday morning'", 10)
            rep.must("the Redo request shows under Notes on this conversation", has_note)

            panel.click("button.chip:has-text('Shorter')")
            r3, _, total = wait_reply(panel, r2, 180)
            rep.timings["shorter"] = round(total, 1)
            rep.outputs["shorter"] = r3
            rep.must("Shorter rewrites the reply", r3 != r2)
            rep.quality("shorter: is actually shorter", len(r3) < len(r2), f"{len(r2)} -> {len(r3)} chars")
            reply_quality(rep, "shorter", r3)
            shot(panel, "03-panel-after-redo")

            # ── Explain ─────────────────────────────────────────────────────────
            t = time.time()
            panel.click("button.tool:has-text('Explain this email')")
            done = wait_js(panel, "!!document.querySelector('[data-live=result]') && !document.querySelector('.card .busy') && !!document.querySelector(\"button[aria-label='Close']\")", 180)
            rep.timings["explain"] = round(time.time() - t, 1)
            explanation = panel.evaluate("(document.querySelector('[data-live=result]') || {}).innerText || ''")
            rep.outputs["explain"] = explanation
            rep.must("Explain returns an explanation", done and len(explanation) > 40, explanation[:80])
            heads = panel.evaluate("[...document.querySelectorAll('.res-head')].map(e => e.textContent)")
            rep.quality("explain: has SUMMARY, WHAT THEY WANT and TRANSLATION", heads == ["SUMMARY", "WHAT THEY WANT", "TRANSLATION"], str(heads))
            rep.quality("explain: points out the text aimed at an AI", bool(re.search(r"suspicious|ignore|instruction|prompt", explanation, re.I)))
            shot(panel, "04-panel-explain")
            panel.click("button[aria-label='Close']")

            # ── Ask ─────────────────────────────────────────────────────────────
            panel.click("button.tool:has-text('Ask')")
            panel.fill("textarea", "Is she upset? Write the reply.")
            t = time.time()
            panel.click("button.primary:has-text('Ask')")
            # done = the streamed bubble became a saved answer and no spinner is left
            done = wait_js(panel, "!document.querySelector('[data-live=ask]') && !document.querySelector('.spin') && document.querySelectorAll('.bubble.ai').length >= 1", 180)
            rep.timings["ask"] = round(time.time() - t, 1)
            answer = panel.evaluate("[...document.querySelectorAll('.bubble.ai')].map(e => e.innerText).pop() || ''")
            rep.outputs["ask"] = answer
            rep.must("Ask answers the question", done and len(answer) > 10, answer[:80])
            use = panel.query_selector("button:has-text('Use as reply')")
            rep.quality("ask: the drafted email comes with 'Use as reply'", use is not None)
            shot(panel, "05-panel-ask")
            if use:
                use.click()
                rep.must("Use as reply puts that email in the reply box",
                         wait_js(panel, "(document.querySelector('textarea.reply') || {}).value.length > 20", 10))
            else:
                panel.click("button:has-text('Back')")

            # ── Remember (no AI) and Learn from sent mail ────────────────────────
            panel.fill("input[placeholder*='always remember']", "Prefers the invoice as a PDF")
            panel.click("text=Only for Sarah Kim")
            panel.click("button[aria-label='Save to memory']")
            rep.must("Remember saves a memory only for Sarah",
                     bool(panel.wait_for_selector("text=Saved to memory, only for Sarah Kim.", timeout=10000)))
            panel.click("button:has-text('Learn from my sent mail')")
            t = time.time()
            panel.click("text=Learn now")
            finished = wait_js(panel, "/Done: I read|didn't find new emails|couldn't read|Stopped|stopped/.test(document.body.innerText) || !!document.querySelector('.note.err')", 400, 1)
            rep.timings["learn (3 sent conversations)"] = round(time.time() - t, 1)
            learn_msg = panel.evaluate("[...document.querySelectorAll('.note')].map(n => n.textContent).join(' | ')")
            rep.must("Learn finishes without an error", finished and not panel.query_selector(".note.err") and "stopped" not in learn_msg, learn_msg)
            rep.quality("learn: every answer from the model was readable JSON", "couldn't read" not in learn_msg, learn_msg)
            rep.must("Gmail is back on the open email after Learn", gmail.evaluate("location.hash") == "#inbox/FMfcgzQXJteste")
            stored = panel.evaluate("chrome.storage.local.get(['memory', 'style']).then(s => s)")
            learned = [m for m in stored.get("memory", []) if m.get("source") == "learned"]
            rep.outputs["learned facts"] = [m.get("text") for m in learned]
            rep.outputs["learned style"] = (stored.get("style") or {}).get("summary", "")
            rep.quality("learn: the model's JSON gave at least one fact", len(learned) > 0, str(len(learned)))
            rep.quality("learn: a writing style came back", bool(rep.outputs["learned style"]))
            shot(panel, "06-panel-learned")

            # ── Notes: delete the note in the panel ─────────────────────────────
            panel.click("button:has-text('Back')")
            panel.wait_for_selector("[data-live=notes] .nitem", timeout=10000)
            panel.click("[data-live=notes] .nitem button")
            rep.must("the trash button deletes the note", wait_js(panel, "(document.querySelector('[data-live=notes]') || {}).hidden === true", 10))
            usage = panel.text_content("footer") or ""
            rep.outputs["footer"] = usage

            # ── Auto-draft: switch on, open the email again: the model writes and it lands in Gmail ──
            panel.click("button.switch")
            gmail.reload()
            gmail.wait_for_selector(".jm-chip", timeout=15000)
            t = time.time()
            panel.reload()
            box = "(document.querySelector('[role=textbox]') || {}).innerText || ''"
            drafted = wait_js(gmail, f"({box}).includes('Sarah')", 180)
            rep.timings["auto-draft (open the email to draft in Gmail)"] = round(time.time() - t, 1)
            rep.outputs["auto-draft in Gmail"] = gmail.evaluate(box)
            rep.must("Auto-draft: opening the email put a draft in Gmail with no clicks", drafted, gmail.evaluate(box)[:80])
            shot(panel, "07-panel-auto-draft")
            gmail.reload()
            gmail.wait_for_selector(".jm-chip", timeout=15000)
            chats = lambda: len([c for c in calls if f":{PORT}/v1/chat" in c])
            before = chats()
            panel.reload()
            panel.wait_for_selector("text=Write reply", timeout=20000)
            panel.wait_for_timeout(2000)
            rep.must("Auto-draft: reopening the same email doesn't draft it again", chats() == before, f"{before} -> {chats()}")
            panel.click("button.switch")

            opts.bring_to_front()
            opts.goto(f"chrome-extension://{ext_id}/options.html")
            opts.click("button.tab:has-text('Memory')")
            opts.wait_for_selector("text=Learned from your sent emails")
            shot(opts, "08-settings-memory")
            ctx.close()
        rep.outputs["requests to the AI"] = len([c for c in calls if f":{PORT}/" in c])
        rep.must("the extension talked to the real model", rep.outputs["requests to the AI"] >= 6, str(rep.outputs["requests to the AI"]))
    except Exception as e:  # report what happened instead of a bare traceback
        rep.must("run finished", False, f"{type(e).__name__}: {e}")
    finally:
        stop_ollama(proc)
        shutil.rmtree(tmp, ignore_errors=True)
    log = ollama_log.read_text(encoding="utf-8", errors="replace") if ollama_log.exists() else ""
    truncated = len(re.findall(r"truncated = [1-9]", log))
    sizes = [int(n) for n in re.findall(r"task\.n_tokens = (\d+)", log)]
    rep.outputs["largest prompt (tokens)"] = max(sizes) if sizes else 0
    rep.quality("Ollama didn't cut any prompt to fit its context window", truncated == 0, f"{truncated} truncation line(s) in the server log")
    ctx_lines = sorted(set(re.findall(r"n_ctx(?:_per_seq)?\s*=\s*\d+", log)))
    rep.outputs["ollama context"] = ", ".join(ctx_lines)
    # the 403 the check provokes on your own Ollama shows up in Chrome's console as a failed load: expected
    real_errors = [e for e in errors if "favicon" not in e and "status of 403" not in e]
    rep.must("no errors in the browser console", not real_errors, " | ".join(real_errors)[:500])
    write_report(rep, model)
    print(f"\n{len(rep.checks) - len(rep.failed)} of {len(rep.checks)} checks ok; must-pass failures: {len(rep.failed)}")
    print("report:", OUT / "report.md")
    return 1 if rep.failed else 0


def write_report(rep: Report, model: str):
    lines = [f"# Burnout live check: real local AI ({model})", "",
             f"Run on {time.strftime('%Y-%m-%d %H:%M')}. The real extension in Chromium, Gmail test page, "
             "the AI is a real model on this computer through Ollama (nothing simulated on the AI side).", "",
             "## Checks", "", "| | Check | Detail |", "|---|---|---|"]
    for c in rep.checks:
        mark = "PASS" if c["ok"] else ("FAIL" if c["kind"] == "must" else "NOTE")
        detail = str(c["detail"]).replace("|", "/").replace("\n", " ")[:160] if not c["ok"] else ""
        lines.append(f"| {mark} | {c['name']} | {detail} |")
    lines += ["", "PASS/FAIL = Burnout works or doesn't. NOTE = how this model wrote (quality, not a bug in Burnout).", "",
              "## Time (seconds)", "", "| Step | s |", "|---|---|"]
    lines += [f"| {k} | {v} |" for k, v in rep.timings.items()]
    lines += ["", "## What the model wrote", ""]
    for k, v in rep.outputs.items():
        lines.append(f"### {k}")
        if isinstance(v, list):
            lines += [f"- {x}" for x in v] or ["(none)"]
        else:
            lines += ["```", str(v).strip() or "(empty)", "```"]
        lines.append("")
    (OUT / "report.md").write_text("\n".join(lines), encoding="utf-8")
    (OUT / "report.json").write_text(json.dumps({"model": model, "checks": rep.checks, "timings": rep.timings,
                                                 "outputs": rep.outputs}, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    args = sys.argv[1:]
    chosen = args[args.index("--model") + 1] if "--model" in args else "qwen2.5:7b"
    sys.exit(main(chosen, headed="--headed" in args))
