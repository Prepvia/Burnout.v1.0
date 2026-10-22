// Burnout for Gmail: the part that runs INSIDE Gmail.
//
// It only does what needs the Gmail page:
//   - tells which conversation is open and fetches all of it through the print page
//     (?view=pt), which includes the collapsed messages too;
//   - lists the conversations in the Sent folder for "Learn" (runs Gmail's search
//     quickly, without filling Back, and returns to where the person was);
//   - puts the reply in the reply box of the right conversation (the person reviews and
//     sends; Burnout never clicks Send). Putting it in again replaces the previous one;
//   - shows the "Reply with Burnout" button next to the subject: it opens the panel and
//     starts writing right away.
// The AI, the memory and the screens live in the panel (panel.js). Gmail selectors
// checked live on Oct 17, 2026.
(() => {
  if (window.__burnoutLoaded === true) return; // === true: an element with that id can't switch Burnout off
  window.__burnoutLoaded = true;

  const SEL = {
    subject: 'h2.hP',
    reply: 'span.ams.bkH',
    replyAll: 'span.ams.bkI',
    box: 'div[contenteditable="true"][role="textbox"]',
    row: 'tr.zA',
    rowId: '[data-legacy-thread-id]',
    chip: '.jm-chip',
  };
  const ID_RE = /^[0-9a-f]{12,20}$/i;
  const EMAIL_RE = /[A-Za-z0-9._%+\-']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  const FORWARD_RE = /-{5,}\s*(?:Forwarded message|Mensagem encaminhada|Mensaje reenviado|Message transféré|Weitergeleitete Nachricht)/i;

  const visible = (el) => !!el && el.getClientRects().length > 0;
  // Gmail's own controls, never something inside an email's body (div.a3s)
  const gmailOwn = (el) => !(typeof el.closest === 'function' && el.closest('.a3s'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (key, fallback) => {
    try {
      return (chrome.i18n && chrome.i18n.getMessage(key)) || fallback;
    } catch (e) {
      return fallback;
    }
  };
  // extension updated or removed: this copy loses its connection and steps aside
  const alive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  };

  // a button left by an old copy (from before an update) no longer talks to Burnout
  for (const old of document.querySelectorAll(SEL.chip)) old.remove();

  function accountPath() {
    const m = location.pathname.match(/^\/mail\/u\/(\d+)\//);
    return '/mail/u/' + (m ? m[1] : '0') + '/';
  }

  let ikCache = '';
  function ik() {
    if (ikCache) return ikCache;
    for (const s of document.querySelectorAll('script')) {
      const m = (s.textContent || '').match(/GLOBALS=\[(?:[^,]*,){9}"([0-9a-f]{6,12})"/);
      if (m) return (ikCache = m[1]);
    }
    return '';
  }

  // The title is "<folder or subject> - <account> - Gmail" (on Workspace it ends with the
  // company name instead): the account is the LAST email. The subject may hold a client's
  // email before it.
  function myEmail() {
    const all = (document.title || '').match(EMAIL_RE) || [];
    return all.length ? all[all.length - 1].toLowerCase() : '';
  }

  function visibleSubject() {
    return [...document.querySelectorAll(SEL.subject)].find(visible) || null;
  }

  function currentThreadId() {
    const h2 = visibleSubject();
    const id = h2 ? h2.getAttribute('data-legacy-thread-id') || '' : '';
    return ID_RE.test(id) ? id : '';
  }

  async function fetchPrint(id, timeoutMs = 15000) {
    if (!ID_RE.test(id || '')) throw new Error('bad_id');
    const url = accountPath() + '?ik=' + encodeURIComponent(ik()) + '&view=pt&search=all&th=' + encodeURIComponent(id);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, { credentials: 'include', signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error('http_' + res.status);
      const html = await res.text();
      if (!/class="?message/.test(html)) throw new Error('not_a_thread');
      return html;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── Sent folder ─────────────────────────────────────────────────────────
  function visibleRowIds() {
    const ids = [];
    for (const row of document.querySelectorAll(SEL.row)) {
      if (!visible(row)) continue;
      const el = row.querySelector(SEL.rowId);
      const id = el ? el.getAttribute('data-legacy-thread-id') : '';
      if (ID_RE.test(id || '') && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  // New list = visible rows that differ from the previous ones and stay the same for two
  // reads in a row (right after switching folders Gmail still shows the old list).
  async function readNewRows(previousSig, timeoutMs, stop) {
    const t0 = Date.now();
    await sleep(900);
    let last = '';
    while (Date.now() - t0 < timeoutMs && !stop()) {
      const ids = visibleRowIds();
      const sig = ids.join(',');
      if (ids.length && sig !== previousSig && sig === last) return ids;
      last = sig;
      await sleep(300);
    }
    return [];
  }

  // Today's Gmail doesn't open page 2 by address (#sent/p2 comes up empty, checked
  // Oct 17). Instead of pages, search by period: each search brings up to 50
  // conversations and learning still covers the whole year, not just the last month.
  // Search operators are the same in every Gmail language.
  const SENT_WINDOWS = ['newer_than:7d', 'older_than:7d newer_than:30d', 'older_than:30d newer_than:90d',
    'older_than:90d newer_than:180d', 'older_than:180d newer_than:1y', 'older_than:1y newer_than:2y', 'older_than:2y'];

  function searchHash(query) {
    return '#search/' + encodeURIComponent(query).replace(/%20/g, '+');
  }

  let listCancel = false;

  // location.replace: the searches stay out of the browser's Back. If the person moves
  // around Gmail midway, it stops right away and doesn't pull them back.
  async function listSent(max) {
    listCancel = false;
    const limit = Math.max(1, Math.min(Number(max) || 60, 400));
    const original = location.hash;
    const ids = [];
    let previousSig = visibleRowIds().join(',');
    let expected = original;
    let moved = false;
    const stop = () => listCancel || location.hash !== expected;
    try {
      for (const period of SENT_WINDOWS) {
        if (ids.length >= limit || listCancel) break;
        if (location.hash !== expected) {
          moved = true;
          break;
        }
        expected = searchHash('in:sent ' + period);
        location.replace(expected);
        const got = await readNewRows(previousSig, 7000, stop); // a period with no email: wait, then move on
        if (location.hash !== expected) {
          moved = true;
          break;
        }
        if (!got.length) continue;
        previousSig = got.join(',');
        for (const id of got) if (!ids.includes(id)) ids.push(id);
      }
    } finally {
      if (!moved && location.hash === expected && location.hash !== original) location.replace(original || '#inbox');
    }
    return { ids: ids.slice(0, limit), cancelled: listCancel, moved };
  }

  // ── Reply box ───────────────────────────────────────────────────────────
  // Looks only inside the open conversation (the visible subject's), never in a stray draft.
  function visibleReplyBox() {
    const h2 = visibleSubject();
    const root = h2 && typeof h2.closest === 'function' ? h2.closest('[role="main"]') : null;
    const roots = root ? [root] : [...document.querySelectorAll('div[role="main"]')].filter(visible);
    for (const r of roots) {
      const box = [...r.querySelectorAll(SEL.box)].reverse().find((el) => visible(el) && gmailOwn(el));
      if (box) return box;
    }
    return null;
  }

  function visibleButton(selector) {
    return [...document.querySelectorAll(selector)].reverse().find((el) => visible(el) && gmailOwn(el)) || null;
  }

  async function waitFor(fn, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(150);
    }
    return null;
  }

  // no spaces or line breaks: Gmail's editor turns each line into a block
  const bare = (s) => String(s || '').replace(/\s+/g, '');

  function caretAtStart(box, sel) {
    const range = document.createRange();
    range.setStart(box, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // The start of the box that is exactly the text Burnout put in last time (letter by
  // letter, ignoring spaces and line breaks). If the person edited it in Gmail it won't
  // match, and nothing is deleted.
  function previousRange(box, prev) {
    const want = bare(prev);
    if (!want || typeof document.createTreeWalker !== 'function') return null;
    const walker = document.createTreeWalker(box, 4); // 4 = NodeFilter.SHOW_TEXT
    let n = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const s = node.nodeValue || '';
      for (let i = 0; i < s.length; i++) {
        if (/\s/.test(s[i])) continue;
        if (s[i] !== want[n]) return null;
        n += 1;
        if (n === want.length) {
          const range = document.createRange();
          range.setStart(box, 0);
          range.setEnd(node, i + 1);
          return range;
        }
      }
    }
    return null;
  }

  let lastInsert = null; // { threadId, text }: what Burnout put in the box last time

  async function insertReply(textValue, replyAll, threadId, onlyIfClosed = false) {
    const body = String(textValue || '').replace(/\r\n/g, '\n').trim();
    if (!body) return { ok: false, error: 'empty' };
    // the reply belongs to this conversation: if another one is open now, don't paste it there
    if (threadId && threadId !== currentThreadId()) return { ok: false, error: 'other_thread' };
    let box = visibleReplyBox();
    // auto-draft never writes into a reply box that is already open: a draft the person started,
    // or one Gmail brought back for this conversation
    if (box && onlyIfClosed) return { ok: false, error: 'box_open' };
    if (box && FORWARD_RE.test(box.innerText || '')) return { ok: false, error: 'forward_open' };
    if (!box) {
      const btn = (replyAll && visibleButton(SEL.replyAll)) || visibleButton(SEL.reply);
      if (!btn) return { ok: false, error: 'no_reply_button' };
      btn.click();
      box = await waitFor(visibleReplyBox, 4000);
      // the person may have opened another conversation while the box was opening
      if (threadId && threadId !== currentThreadId()) return { ok: false, error: 'other_thread' };
    }
    if (!box) return { ok: false, error: 'no_box' };
    box.focus();
    const sel = window.getSelection();
    const prev = lastInsert && lastInsert.threadId === (threadId || currentThreadId()) ? lastInsert.text : '';
    const before = bare(box.innerText || box.textContent);
    const old = prev ? previousRange(box, prev) : null;
    const replaced = !!old;
    if (old) {
      sel.removeAllRanges();
      sel.addRange(old); // the new text takes the old one's place
    } else {
      caretAtStart(box, sel);
    }
    // insertText goes into Gmail's undo and keeps Gmail's signature below
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, replaced ? body : body + '\n\n');
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      // no execCommand (tab without focus, newer browser): build the lines by hand
      const nodes = [];
      for (const line of (body + '\n').split('\n')) {
        const div = document.createElement('div');
        if (line) div.textContent = line;
        else div.append(document.createElement('br'));
        nodes.push(div);
      }
      box.prepend(...nodes);
    }
    box.dispatchEvent(new Event('input', { bubbles: true }));
    lastInsert = { threadId: threadId || currentThreadId(), text: body };
    // the previous version is still there (the person edited it in Gmail): warn them to delete it
    const stacked = !replaced && !!prev && before.includes(bare(prev).slice(0, 30));
    return { ok: true, replaced, stacked };
  }

  // innerText already leaves out display:none and visibility:hidden. This also takes out text the
  // reader can't see because it's tiny or see-through (the usual way to hide orders for an AI),
  // like the print page reader does.
  function shownText(body) {
    let out = String(body.innerText || body.textContent || '');
    const hidden = [];
    for (const el of body.querySelectorAll('*')) {
      if (hidden.some((x) => x.contains(el))) continue;
      const cs = getComputedStyle(el);
      if (parseFloat(cs.fontSize) < 2 || parseFloat(cs.opacity) < 0.1 || /^rgba\(\d+,\d+,\d+,0(?:\.0+)?\)$/.test(cs.color.replace(/\s/g, ''))) hidden.push(el);
    }
    for (const el of hidden) {
      const s = String(el.innerText || el.textContent || '').trim();
      if (s) out = out.replace(s, '');
    }
    return out.trim();
  }

  // Fallback when the print page fails: the messages open on screen (collapsed ones are
  // left out, but the last one, the one that matters, is always open).
  function domThread() {
    const h2 = visibleSubject();
    const messages = [];
    for (const m of document.querySelectorAll('div.adn.ads')) {
      if (!visible(m)) continue;
      const who = m.querySelector('span.gD');
      const when = m.querySelector('span.g3');
      const body = m.querySelector('div.a3s');
      messages.push({
        fromName: who ? String(who.getAttribute('name') || who.textContent || '').trim() : '',
        fromEmail: who ? String(who.getAttribute('email') || '').toLowerCase() : '',
        date: when ? String(when.getAttribute('title') || when.textContent || '').trim() : '',
        to: '',
        cc: '',
        text: body ? shownText(body).slice(0, 6000) : '',
      });
    }
    return { subject: h2 ? String(h2.textContent || '').trim() : '', messages };
  }

  // ── Messages from the panel ─────────────────────────────────────────────
  const HANDLERS = {
    'jm:ping': async () => ({ ok: true, threadId: currentThreadId(), me: myEmail() }),
    'jm:getThread': async () => {
      const id = currentThreadId();
      if (!id) return { ok: false, error: 'no_thread', me: myEmail() };
      const dom = domThread();
      try {
        return { ok: true, threadId: id, me: myEmail(), html: await fetchPrint(id), dom };
      } catch (e) {
        if (!dom.messages.length) throw e;
        return { ok: true, threadId: id, me: myEmail(), dom };
      }
    },
    'jm:printThread': async (msg) => ({ ok: true, html: await fetchPrint(msg.id) }),
    'jm:listSent': async (msg) => ({ ok: true, ...(await listSent(msg.max)), me: myEmail() }),
    'jm:cancel': async () => {
      listCancel = true;
      return { ok: true };
    },
    'jm:insertReply': async (msg) => insertReply(msg.text, !!msg.replyAll, msg.threadId || '', !!msg.onlyIfClosed),
    'jm:getSelection': async () => ({ ok: true, text: String(window.getSelection() || '').trim().slice(0, 600) }),
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const handler = msg && typeof msg.type === 'string' && Object.hasOwn(HANDLERS, msg.type) ? HANDLERS[msg.type] : null;
    if (!handler) return false;
    handler(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e).slice(0, 120) }));
    return true;
  });

  // ── "Reply with Burnout" button + conversation-change notice ───────────
  let lastId = null;
  let timer = 0;

  const chipLabel = () => [text('chipLabel', 'Reply with Burnout'), text('chipTitle', 'Opens Burnout and writes the reply to this email')];

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      // no connection: the next tick turns this copy off
    }
  }

  function ensureChip() {
    const h2 = visibleSubject();
    if (!h2 || !h2.parentElement || h2.parentElement.querySelector(SEL.chip)) return;
    const [label, title] = chipLabel();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'jm-chip';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // open the panel and ask for this conversation's reply right away
      send({ type: 'jm:openPanel', write: true, threadId: currentThreadId() });
    });
    h2.insertAdjacentElement('afterend', b);
  }

  function tick() {
    if (!alive()) {
      clearInterval(timer);
      for (const c of document.querySelectorAll(SEL.chip)) c.remove();
      return;
    }
    ensureChip();
    const id = currentThreadId();
    if (id !== lastId) {
      lastId = id;
      send({ type: 'jm:threadChanged', threadId: id });
    }
  }

  window.addEventListener('hashchange', () => setTimeout(tick, 400));
  timer = setInterval(tick, 1000);
  tick();
})();
