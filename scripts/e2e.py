"""End-to-end test: the REAL extension loaded in Chromium (Playwright), a test Gmail
(tests/fixtures/fake_gmail_en.html, served at Gmail's address) and the AIs answering canned
text: Gemini (streamed), the company AI (own endpoint) and OpenRouter (Other AI). Goes
through setup, clicks "Reply with Burnout" in Gmail, adjusts, puts the reply in Gmail twice
(the second replaces the first), sees and deletes the conversation notes (in the panel and
in the Memory tab), explains, asks, remembers and learns from sent mail. Every screen becomes
a screenshot in preview/shots/.

    python scripts/e2e.py            # run and take the screenshots
    python scripts/e2e.py --headed   # show the browser

Nothing here talks to the real Gmail or a real AI (scripts/live_check.py uses a real model).
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
FIX = ROOT / "tests" / "fixtures"
SHOTS = ROOT / "preview" / "shots"
THREAD_ID = "18f0c0ffee000001"
SCALE = 2  # screenshots at 2x, sharp on any screen
COMPANY_URL = "https://ia.acme-ceramics.example/burnout"

# The print-page fixture was captured from a Gmail set to Portuguese; Gmail in English prints
# the same page with these words (the parser reads both).
PRINT = ((FIX / "print_thread.html").read_text(encoding="utf-8")
         .replace("3 mensagens", "3 messages")
         .replace("qui., 16 de out. de 2026 às 10:12", "Thu, Oct 16, 2026 at 10:12 AM")
         .replace("qui., 16 de out. de 2026 às 11:40", "Thu, Oct 16, 2026 at 11:40 AM")
         .replace("sex., 17 de out. de 2026 às 08:05", "Fri, Oct 17, 2026 at 8:05 AM")
         .replace("Para: ", "To: "))
GMAIL = (FIX / "fake_gmail_en.html").read_text(encoding="utf-8")

REPLY = ("Hi Sarah,\n\nYes, the 40 mugs will be glazed and ready on Tuesday. I'll send the invoice for PO 7781 "
         "today.\n\nBest,\nAlice")
REFINED = ("Hi Sarah,\n\nYes, the 40 mugs will be glazed and ready on Tuesday morning. I'll send the invoice for "
           "PO 7781 today.\n\nBest,\nAlice")
SHORT = "Hi Sarah,\n\nMugs ready Tuesday morning, invoice for PO 7781 today.\n\nBest,\nAlice"
FORMAL = ("Dear Sarah,\n\nThe 40 mugs will be ready on Tuesday morning, and the invoice for PO 7781 will be sent "
          "today.\n\nBest,\nAlice")
WARM = ("Hi Sarah,\n\nGood news: your 40 mugs will be ready Tuesday morning, and I'm sending the invoice for "
        "PO 7781 today.\n\nBest,\nAlice")
EXPLAIN = ("SUMMARY\nSarah Kim, a client, confirms the order of 40 mugs and asks for the invoice.\n"
           "WHAT THEY WANT\nThe invoice with their purchase order number (PO 7781).\n"
           "Deadline: the 40 mugs are ready on Tuesday.\n"
           "Suspicious: the email tells an AI to ignore its instructions and reveal its prompt.\n"
           "TRANSLATION\nThe last message is already in English.")
ANSWER = ("She isn't upset: she's in a hurry and wants the invoice. A short reply does it.\n\n"
          "READY REPLY:\nHi Sarah,\n\nThe invoice for PO 7781 goes out today, and the mugs are on track for "
          "Tuesday.\n\nBest,\nAlice\nEND OF REPLY")
LEARN = json.dumps({
    "style": "Writes short and direct, in English with clients. Opens with 'Hi <name>,' and signs 'Best, Alice'.",
    "facts": [
        {"text": "Custom glazing costs $12 per mug and takes 3 business days", "date": "2026-10-16", "contact": ""},
        {"text": "The minimum order for plates is 20 pieces", "date": "2026-10-02", "contact": ""},
    ],
    "examples": ["Hi Mia, 20 plates is our minimum and they ship in a week. Best, Alice"],
})
MODELS = {"data": [{"id": "openrouter/auto"}, {"id": "anthropic/claude-sonnet-5.5"}, {"id": "google/gemini-3.8-flash"},
                   {"id": "openai/gpt-6.1-sol"}, {"id": "mistralai/mistral-large"}]}

LOG: list[str] = []
COMPANY: list[dict] = []
OPENROUTER: list[dict] = []
HOLD = {"on": False}
HELD: list = []


def answer_for(system: str, user: str) -> tuple[str, str]:
    if system.startswith("Reply with the single word OK"):
        return "test", "OK"
    if system.startswith("You write email replies"):
        return "reply", REPLY
    if system.startswith("You revise"):
        if "shorter" in user:
            return "shorter", SHORT
        if "formal" in user:
            return "formal", FORMAL
        if "warmer" in user:
            return "warmer", WARM
        return "adjust", REFINED
    if "email assistant of" in system:
        return "ask", ANSWER
    if system.startswith("You help a person understand"):
        return "explain", EXPLAIN
    if system.startswith("You study emails"):
        assert "slammed" not in user, "the other side's message went to the AI while learning"
        return "learn", LEARN
    if system.startswith("You merge"):
        return "style", "Short and direct."
    return "?", "?"


def check_prompt(kind: str, system: str):
    assert "Acme Ceramics" in system or kind in ("test", "explain", "learn", "style"), "profile missing from the prompt"
    for word in ("PrepVia", "FBA"):
        assert word not in system, "company-specific word left in a prompt: " + word


def sse_gemini(text: str) -> str:
    """The text in 3 pieces, the way Gemini sends streamGenerateContent?alt=sse."""
    cut = [0, len(text) // 3, 2 * len(text) // 3, len(text)]
    parts = []
    for i in range(3):
        piece = {"candidates": [{"content": {"parts": [{"text": text[cut[i]:cut[i + 1]]}]}}]}
        if i == 2:
            piece["candidates"][0]["finishReason"] = "STOP"
            piece["usageMetadata"] = {"promptTokenCount": 900, "candidatesTokenCount": 120}
        parts.append("data: " + json.dumps(piece) + "\r\n\r\n")
    return "".join(parts)


def on_gemini(route, request):
    body = request.post_data_json or {}
    system = body["system_instruction"]["parts"][0]["text"]
    user = body["contents"][0]["parts"][0]["text"]
    kind, text = answer_for(system, user)
    check_prompt(kind, system)
    LOG.append(kind)
    if "streamGenerateContent" in request.url:
        payload = dict(status=200, content_type="text/event-stream", body=sse_gemini(text))
        if HOLD["on"] and kind == "reply":
            HOLD["on"] = False
            HELD.append((route, payload))  # hold the reply to screenshot "Writing..."
            return
        route.fulfill(**payload)
        return
    route.fulfill(status=200, content_type="application/json",
                  body=json.dumps({"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": "STOP"}],
                                   "usageMetadata": {"promptTokenCount": 900, "candidatesTokenCount": 120}}))


def on_company(route, request):
    """The company AI: the own-endpoint contract (docs/CONNECT_AI.md)."""
    body = request.post_data_json or {}
    assert set(body) == {"system", "prompt", "max_tokens", "purpose", "model"}, body.keys()
    kind, text = answer_for(body["system"], body["prompt"])
    COMPANY.append({"purpose": body["purpose"], "kind": kind, "model": body["model"],
                    "auth": request.headers.get("authorization", "")})
    route.fulfill(status=200, content_type="application/json", body=json.dumps({"text": text}))


def on_openrouter(route, request):
    if request.url.endswith("/models"):
        route.fulfill(status=200, content_type="application/json", body=json.dumps(MODELS))
        return
    body = request.post_data_json or {}
    system = body["messages"][0]["content"]
    kind, text = answer_for(system, body["messages"][1]["content"])
    OPENROUTER.append({"kind": kind, "model": body["model"], "stream": bool(body.get("stream")),
                       "auth": request.headers.get("authorization", "")})
    if body.get("stream"):
        chunks = [text[:20], text[20:]]
        sse = "".join("data: " + json.dumps({"choices": [{"delta": {"content": c}, "finish_reason": None}]}) + "\n\n" for c in chunks)
        sse += "data: " + json.dumps({"choices": [{"delta": {}, "finish_reason": "stop"}]}) + "\n\ndata: [DONE]\n\n"
        route.fulfill(status=200, content_type="text/event-stream", body=sse)
    else:
        route.fulfill(status=200, content_type="application/json",
                      body=json.dumps({"model": body["model"], "choices": [{"message": {"content": text}, "finish_reason": "stop"}]}))


def sent_print(thread_id: str) -> str:
    """Print page of a conversation from the Sent folder (Alice writing)."""
    return PRINT.replace("Re: 40 mugs", "Order " + thread_id[-1])


def on_gmail(route, request):
    url = request.url
    if "view=pt" in url:
        m = re.search(r"[?&]th=([0-9a-f]+)", url)
        tid = m.group(1) if m else ""
        html = PRINT if tid == THREAD_ID else sent_print(tid)
        route.fulfill(status=200, content_type="text/html; charset=utf-8", body=html)
        return
    # the same lock as the real Gmail: Trusted Types (innerHTML breaks)
    route.fulfill(status=200, content_type="text/html; charset=utf-8", body=GMAIL,
                  headers={"content-security-policy": "require-trusted-types-for 'script'"})


def build_test_extension(tmp: Path) -> Path:
    """Copy of the extension for the test:
    - AIs already allowed (Chrome's permission prompt is a window the test can't click);
    - no Chrome side panel: the panel runs in a tab tied to Gmail (?tab=), and a second panel
      in the corner of the window would compete for the Gmail button's "write right away"."""
    dst = tmp / "ext"
    shutil.copytree(EXT, dst)
    m = json.loads((dst / "manifest.json").read_text(encoding="utf-8"))
    m["host_permissions"] = m["host_permissions"] + m.pop("optional_host_permissions")
    m.pop("side_panel", None)
    (dst / "manifest.json").write_text(json.dumps(m, indent=2), encoding="utf-8")
    return dst


def wait_js(page, expression: str, timeout: float = 20.0):
    """Waits for a JS expression to become true. (wait_for_function uses eval, which the
    extension pages' CSP blocks.)"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if page.evaluate(expression):
            return
        page.wait_for_timeout(200)
    raise TimeoutError("never became true: " + expression)


def wait_text(page, text: str, timeout: float = 15000):
    """Waits for a text to show up; if it doesn't, shows the notices on screen and screenshots the error."""
    try:
        page.wait_for_selector("text=" + text, timeout=timeout)
    except Exception:
        notes = page.evaluate("[...document.querySelectorAll('.note, .toast')].map(n => n.textContent).join(' | ')")
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / "error.png"), full_page=True)
        raise AssertionError(f"{text!r} never showed up; notices on screen: {notes!r} (screenshot in preview/shots/error.png)")


NOTES_SHOWN = "[...document.querySelectorAll('[data-live=notes]:not([hidden]) .nitem .mem-text')].map(e => e.textContent)"


def panel_notes(page) -> list[str]:
    """The notes on this conversation the panel shows (a hidden card doesn't count)."""
    return page.evaluate(NOTES_SHOWN)


def wait_notes(page, texts: list[str], timeout: float = 15.0):
    """Waits for the "Notes on this conversation" card to show exactly these notes, in this order."""
    want = json.dumps(json.dumps(texts, ensure_ascii=False, separators=(",", ":")))
    try:
        wait_js(page, f"JSON.stringify({NOTES_SHOWN}) === {want}", timeout)
    except TimeoutError:
        raise AssertionError(f"notes in the panel: {panel_notes(page)!r}; expected {texts!r}") from None


def shot(page, name: str, **kw):
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.evaluate("document.querySelectorAll('.toast').forEach(t => t.remove())")
    if kw.get("full_page"):
        page.evaluate("window.scrollTo(0, 0)")  # scrolled, the sticky top bar lands mid-screenshot
    page.screenshot(path=str(SHOTS / f"{name}.png"), **kw)
    print("  screenshot:", name)


NOTE_1 = "say they'll be ready Tuesday morning"
NOTE_2 = "don't promise a discount"


def main(headed: bool = False) -> int:
    tmp = Path(tempfile.mkdtemp(prefix="burnout-e2e-"))
    ext = build_test_extension(tmp)
    errors: list[str] = []
    if SHOTS.exists():
        shutil.rmtree(SHOTS)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(tmp / "profile"), channel="chromium", headless=not headed, locale="en-US",
            viewport={"width": 1280, "height": 820}, device_scale_factor=SCALE,
            args=[f"--disable-extensions-except={ext}", f"--load-extension={ext}", "--lang=en-US"])
        ctx.route("https://mail.google.com/**", on_gmail)
        ctx.route("https://generativelanguage.googleapis.com/**", on_gemini)
        ctx.route("https://ia.acme-ceramics.example/**", on_company)
        ctx.route("https://openrouter.ai/**", on_openrouter)
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        ext_id = sw.url.split("/")[2]
        print("extension loaded:", ext_id)

        def watch(page, label):
            page.on("pageerror", lambda e: errors.append(f"{label}: {e}"))
            page.on("console", lambda m: errors.append(f"{label} console: {m.text}") if m.type == "error" else None)
            return page

        # 1. the panel before setup
        gmail = watch(ctx.new_page(), "gmail")
        gmail.goto("https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJteste")
        gmail.wait_for_selector(".jm-chip", timeout=15000)
        opts = watch(ctx.new_page(), "settings")
        opts.set_viewport_size({"width": 900, "height": 1180})
        opts.goto(f"chrome-extension://{ext_id}/options.html")
        tab_id = opts.evaluate("chrome.tabs.query({url: 'https://mail.google.com/*'}).then(t => t[0].id)")
        panel = watch(ctx.new_page(), "panel")
        panel.set_viewport_size({"width": 400, "height": 900})
        panel.goto(f"chrome-extension://{ext_id}/panel.html?tab={tab_id}")
        panel.wait_for_selector("text=Set up now")
        shot(panel, "00-panel-before-setup", full_page=True)

        # 2. setup: paste the key (Burnout recognizes it), your business, done
        opts.bring_to_front()
        opts.wait_for_selector("text=Test and save")
        opts.click("button.tile:has-text('ChatGPT')")  # picked the wrong one: the pasted key fixes it
        opts.fill("input.key", "AQ.Ab8ExampleKeyForTheTest1234")  # AI Studio's key format since May 2026
        opts.wait_for_selector("text=Recognized: Google Gemini")
        assert "Google Gemini" in opts.evaluate("document.querySelector('button.tile.on').textContent")
        shot(opts, "01-settings-ai", full_page=True)
        opts.click("button:has-text('Test and save')")
        opts.wait_for_selector("[data-k=name]", timeout=15000)
        opts.fill("[data-k=name]", "Alice Doe")
        opts.fill("[data-k=about]", "Owner of Acme Ceramics, a studio that makes handmade mugs and plates for cafes")
        opts.fill("[data-k=signature]", "Best,\nAlice")
        opts.click("summary")
        opts.fill("[data-k=services]", "Custom glazing\nWholesale orders (20 pieces minimum)")
        opts.fill("[data-k=hours]", "Mon to Fri, 8am to 4pm")
        opts.fill("[data-k=never]", "same-day shipping")
        shot(opts, "02-settings-business", full_page=True)
        opts.click("button:has-text('Continue')")
        opts.wait_for_selector("text=All set", timeout=15000)
        shot(opts, "03-settings-done")

        # 3. Gmail with the "Reply with Burnout" button
        gmail.bring_to_front()
        chip = gmail.text_content(".jm-chip")
        assert chip == "Reply with Burnout", chip
        shot(gmail, "04-gmail-burnout-button", clip={"x": 0, "y": 0, "width": 1280, "height": 420})
        shot(gmail, "04b-gmail-email-open")

        # 4. panel: the Gmail button writes the reply right away (it shows up while being written)
        panel.bring_to_front()
        panel.reload()
        panel.wait_for_selector("text=Write reply", timeout=20000)
        shot(panel, "05-panel-email-open", full_page=True)
        HOLD["on"] = True
        gmail.click(".jm-chip")
        t0 = time.time()
        while not HELD and time.time() - t0 < 15:
            panel.wait_for_timeout(100)
        assert HELD, "the Gmail button didn't ask for the reply"
        panel.wait_for_selector("text=Writing...", timeout=5000)
        shot(panel, "05b-panel-writing", full_page=True)
        held_route, payload = HELD.pop()
        held_route.fulfill(**payload)
        wait_js(panel, "(document.querySelector('textarea.reply') || {}).value === " + json.dumps(REPLY), 20)
        shot(panel, "06-panel-reply", full_page=True)

        # 5. put it in Gmail; adjust; put it in again: the second replaces the first (no duplicate)
        panel.click("text=Put in Gmail")
        wait_js(gmail, "document.querySelector('[role=textbox]').innerText.includes('ready on Tuesday.')", 15)
        assert panel_notes(panel) == [], "a note before any change was asked for"
        panel.fill("input[placeholder*='type a change']", NOTE_1)
        panel.press("input[placeholder*='type a change']", "Enter")  # no Redo button: Enter applies it
        wait_js(panel, "document.querySelector('textarea.reply').value.includes('Tuesday morning')")
        wait_notes(panel, [NOTE_1])  # the typed request became a conversation note
        panel.wait_for_selector("text=Put in Gmail")
        wait_js(panel, "!document.querySelector('button.primary.grow').disabled")
        panel.click("text=Put in Gmail")
        wait_js(gmail, "document.querySelector('[role=textbox]').innerText.includes('Tuesday morning')", 15)
        box = gmail.evaluate("document.querySelector('[role=textbox]').innerText")
        assert box.count("Hi Sarah") == 1, "the reply was duplicated in the box: " + box
        assert box.index("Tuesday morning") < box.index("Alice Doe · Acme Ceramics"), "the reply didn't land above the signature"
        gmail.bring_to_front()
        shot(gmail, "07-gmail-reply-in-box", full_page=True)
        panel.bring_to_front()
        panel.click("button.chip:has-text('Shorter')")
        wait_js(panel, "document.querySelector('textarea.reply').value === " + json.dumps(SHORT))
        assert panel_notes(panel) == [NOTE_1], "a one-click adjustment became a note"

        # 5b. notes on this conversation: the second request becomes note 2, with its date; the trash deletes only it
        panel.fill("input[placeholder*='type a change']", NOTE_2)
        panel.press("input[placeholder*='type a change']", "Enter")
        wait_notes(panel, [NOTE_1, NOTE_2])
        wait_js(panel, "document.querySelector('textarea.reply').value === " + json.dumps(REFINED))
        title = panel.evaluate("document.querySelector('[data-live=notes] .ttl').textContent")
        assert title == "Notes on this conversation (2)", title
        dates = panel.evaluate("[...document.querySelectorAll('[data-live=notes] .nitem .mem-meta')].map(e => e.textContent)")
        assert all(re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) for d in dates), dates
        shot(panel, "07b-panel-notes", full_page=True)
        panel.click("[data-live=notes] .nitem:nth-child(2) button[aria-label^='Delete note']")
        wait_notes(panel, [NOTE_1])
        assert panel.evaluate("document.querySelector('[data-live=notes] .ttl').textContent") == "Notes on this conversation (1)"

        # 6. explain, ask
        panel.click("button.tool:has-text('Explain this email')")
        panel.wait_for_selector("text=SUMMARY", timeout=20000)
        shot(panel, "08-panel-explain", full_page=True)
        panel.click("button[aria-label='Close']")
        panel.click("button.tool:has-text('Ask')")
        panel.fill("textarea", "Is she upset? Write the reply.")
        panel.click("button.primary:has-text('Ask')")
        panel.wait_for_selector("text=Use as reply", timeout=20000)
        shot(panel, "09-panel-ask", full_page=True)
        panel.click("text=Use as reply")
        wait_js(panel, "document.querySelector('textarea.reply').value.includes('PO 7781 goes out today')", 10)

        # 7. remember (only for Sarah) and learn from sent mail
        panel.fill("input[placeholder*='always remember']", "Prefers the invoice as a PDF")
        panel.click("text=Only for Sarah Kim")
        panel.click("button[aria-label='Save to memory']")
        panel.wait_for_selector("text=Saved to memory, only for Sarah Kim.", timeout=10000)
        panel.click("button:has-text('Learn from my sent mail')")
        panel.click("text=Learn now")
        panel.wait_for_selector("text=Done: I read", timeout=60000)
        assert gmail.evaluate("location.hash") == "#inbox/FMfcgzQXJteste", "didn't go back to the open email"
        # first Learn on Gemini: the free-plan reminder, once, until it's closed
        panel.wait_for_selector(".notice:has-text('Learn sends the emails you wrote to Gemini')", timeout=5000)
        shot(panel, "10-panel-learned", full_page=True)
        panel.click(".notice button[aria-label='Close']")
        wait_js(panel, "!document.querySelector('.notice')", 5)
        assert opts.evaluate("chrome.storage.local.get('freePlanSeen').then(s => s.freePlanSeen)") == {"learn": True}

        # 8. memory in Settings, with the conversation notes (the panel goes back to the email, note in view)
        panel.click("button:has-text('Back')")
        wait_notes(panel, [NOTE_1])
        today = panel.evaluate("document.querySelector('[data-live=notes] .nitem .mem-meta').textContent")
        opts.bring_to_front()
        # a note saved before subjects were kept, in another conversation: it shows only the date
        opts.evaluate("chrome.storage.local.get('notes').then(({notes}) => chrome.storage.local.set({notes: {...notes, "
                      "beef0000beef0000: {at: '2026-10-01T12:00:00.000Z', items: [{date: '2026-10-01', kind: 'change', "
                      "text: 'send the invoice too'}]}}}))")
        opts.reload()
        opts.click("button.tab:has-text('Memory')")
        opts.wait_for_selector("text=Learned from your sent emails")
        heads = "[...document.querySelectorAll('.nthread')].map(e => [(e.querySelector('.nthread-subject') || {}).textContent || '', " \
                "e.querySelector('.nthread-head .mem-meta').textContent, e.querySelector('.nitem .mem-text').textContent])"
        convs = opts.evaluate(heads)
        assert convs == [["Re: 40 mugs", f"1 note · {today}", NOTE_1],
                         ["", "1 note · 2026-10-01", "send the invoice too"]], convs
        shot(opts, "11-settings-memory", full_page=True)
        # Delete notes of one conversation: only it leaves, and the panel (which is on it) follows without a reload
        opts.click(".nthread:first-child button:has-text('Delete notes')")
        wait_js(opts, "document.querySelectorAll('.nthread').length === 1")
        assert opts.evaluate(heads) == [["", "1 note · 2026-10-01", "send the invoice too"]], opts.evaluate(heads)
        wait_js(panel, "(document.querySelector('[data-live=notes]') || {}).hidden === true")
        assert panel_notes(panel) == []
        opts.click("button:has-text('Delete notes')")
        opts.wait_for_selector("text=No notes yet.")

        # 9. the company AI (own endpoint): the Gemini key doesn't go to it
        opts.click("button.tab:has-text('AI')")
        opts.click("button.tile:has-text('Company AI')")
        assert opts.input_value("input.key") == "", "the Gemini key stayed in the company AI's field"
        opts.fill("input[type=url]", COMPANY_URL)
        opts.fill("input[aria-label='Model']", "acme-burnout-v1")
        opts.click("summary:has-text('How the company AI')")
        opts.click("button:has-text('Test and save')")
        wait_text(opts, "Connected.")
        shot(opts, "12-settings-company-ai", full_page=True)
        panel.bring_to_front()
        panel.wait_for_selector("button.pill:has-text('ia.acme-ceramics.example')", timeout=10000)
        if panel.query_selector("button:has-text('Back')"):
            panel.click("button:has-text('Back')")
        panel.click("button.chip:has-text('More formal')")
        wait_js(panel, "document.querySelector('textarea.reply').value === " + json.dumps(FORMAL))
        assert [c["purpose"] for c in COMPANY] == ["fast", "reply"], COMPANY
        assert all(c["auth"] == "" and c["model"] == "acme-burnout-v1" for c in COMPANY), COMPANY

        # 10. Other AI: OpenRouter with the server's model list
        opts.bring_to_front()
        opts.click("button.tile:has-text('Other AI')")
        opts.fill("input.key", "sk-or-v1-testkey123456789")
        opts.click("button:has-text('Load models')")
        opts.wait_for_selector("select[aria-label='Model']", timeout=15000)
        assert opts.input_value("select[aria-label='Model']") == "openrouter/auto"
        opts.click("button:has-text('Test and save')")
        wait_text(opts, "Connected.")
        shot(opts, "13-settings-other-ai", full_page=True)
        panel.bring_to_front()
        panel.wait_for_selector("button.pill:has-text('openrouter.ai')", timeout=10000)
        panel.click("button.chip:has-text('Warmer')")
        wait_js(panel, "document.querySelector('textarea.reply').value === " + json.dumps(WARM))
        assert OPENROUTER[-1] == {"kind": "warmer", "model": "openrouter/auto", "stream": True,
                                  "auth": "Bearer sk-or-v1-testkey123456789"}, OPENROUTER

        # 11. no email open: the home screen with Learn
        gmail.evaluate("location.hash = '#search/in:sent newer_than:7d'")
        panel.wait_for_selector("text=Open an email", timeout=15000)
        shot(panel, "14-panel-home", full_page=True)
        gmail.evaluate("location.hash = '#inbox/FMfcgzQXJteste'")
        panel.wait_for_selector("text=Put in Gmail", timeout=15000)

        # 12. auto-draft: switch on, open the email again: the reply is written and goes into Gmail as a
        #     draft with no clicks; reopening the same email doesn't draft it twice
        panel.click("button.switch")
        wait_js(panel, "document.querySelector('button.switch').getAttribute('aria-checked') === 'true'")
        assert opts.evaluate("chrome.storage.local.get('autoDraft').then(s => s.autoDraft)") is True
        gmail.reload()
        gmail.wait_for_selector(".jm-chip", timeout=15000)
        calls_before = len(OPENROUTER)
        panel.reload()
        wait_js(gmail, "!!document.querySelector('[role=textbox]') && document.querySelector('[role=textbox]').innerText.includes('ready on Tuesday.')", 20)
        wait_js(panel, "(document.querySelector('textarea.reply') || {}).value === " + json.dumps(REPLY), 10)
        assert OPENROUTER[calls_before]['kind'] == 'reply', OPENROUTER[calls_before:]
        shot(panel, "15-panel-auto-draft", full_page=True)
        gmail.reload()
        gmail.wait_for_selector(".jm-chip", timeout=15000)
        panel.reload()
        panel.wait_for_selector("text=Write reply", timeout=15000)
        panel.wait_for_timeout(1500)
        assert len(OPENROUTER) == calls_before + 1, "the same email was auto-drafted twice"
        assert not gmail.evaluate("!!document.querySelector('[role=textbox]') && document.querySelector('[role=textbox]').innerText.includes('Hi Sarah')")
        panel.click("button.switch")
        wait_js(panel, "document.querySelector('button.switch').getAttribute('aria-checked') === 'false'")

        # 13. after an update (background.js leaves updatedTo), the panel says it once; Settings shows the version
        opts.evaluate("chrome.storage.local.set({ updatedTo: '9.9.9' })")
        panel.reload()
        panel.wait_for_selector(".notice:has-text('Burnout was updated to 9.9.9.')", timeout=10000)
        assert opts.evaluate("chrome.storage.local.get('updatedTo').then(s => s.updatedTo)") == ""
        panel.reload()
        panel.wait_for_selector("header.bar", timeout=10000)
        panel.wait_for_timeout(500)
        assert panel.locator(".notice").count() == 0, "the update notice came back"
        opts.reload()
        manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
        opts.wait_for_selector(f"text=Burnout for Gmail {manifest['version']}", timeout=10000)
        if manifest.get("homepage_url"):  # Check for updates: the repository's releases, opened only on a click
            href = opts.get_attribute("p.version a", "href")
            assert href == manifest["homepage_url"].rstrip("/") + "/releases", href
        ctx.close()
    shutil.rmtree(tmp, ignore_errors=True)
    print("Gemini called for:", ", ".join(LOG))
    print("Company AI:", ", ".join(c["kind"] + "/" + c["purpose"] for c in COMPANY))
    print("OpenRouter:", ", ".join(c["kind"] + ("/stream" if c["stream"] else "") for c in OPENROUTER))
    real_errors = [e for e in errors if "favicon" not in e]
    if real_errors:
        print("BROWSER ERRORS:")
        for e in real_errors:
            print("  ", e[:300])
        return 1
    print("ok: the whole flow passed")
    return 0


if __name__ == "__main__":
    sys.exit(main(headed="--headed" in sys.argv))
