// Burnout's side panel: the everyday screen, next to Gmail.
//
// Flow: reads the open conversation (content.js fetches Gmail's print page), sends it
// to the person's AI (or their business's) with the profile, the memory and the writing
// style, and the reply shows up while it's being written. "Put in Gmail" puts the text in
// that conversation's reply box; the person is the one who clicks Send.
//
// Each conversation has its own job and its own reply: switching emails midway mixes
// nothing up (Sarah's reply never goes into Bob's email) and coming back to an email
// brings its reply back. "Learn" runs in a corner of the panel while the person keeps
// answering.

import { complete, originFor, shortName } from './lib/ai.js';
import { copyText, h, toast } from './lib/dom.js';
import { othersIn, ownerWroteLast, parsePrintView, partyOf, threadText } from './lib/gmail_parse.js';
import { errText, t } from './lib/i18n.js';
import { icon } from './lib/icons.js';
import { LEARN_DEFAULT, learnFromThreads } from './lib/learn.js';
import * as P from './lib/prompts.js';
import * as store from './lib/store.js';
import { cleanClientText, clip, hasUnknownMoney, isAutomatedSender, localMonth, pasteKeys, readyText, stripInvisible, stripReadyMarkers, timeZone } from './lib/text.js';

const app = document.getElementById('app');

// One-click adjustments: the request goes to the AI in English; the reply keeps the conversation's language.
const QUICK = {
  shorter: 'Make it shorter: keep only what matters.',
  formal: 'Make it more formal and polished.',
  warm: 'Make it warmer and friendlier, without overdoing it.',
};
const LEARN_COUNTS = [30, 60, 120, 200];

const st = {
  state: null,
  tabId: null,
  screen: 'loading',
  me: '',
  thread: null,
  reply: '',
  warning: false,
  truncated: false,
  result: null,
  view: 'main',
  chat: [],
  notes: [], // what the person asked for with Redo in this conversation (goes into the next replies)
  pendingQ: null,
  drafts: { change: '', ask: '', mem: '', memContact: false },
  learn: null,
  learnCount: LEARN_DEFAULT,
  error: '',
  shortcut: '',
};
const jobs = new Map(); // conversation -> running job: 'write', 'redo', 'quick:formal', 'explain', 'insert'...
const lives = new Map(); // conversation -> { target, text }: what the AI is writing right now
const replies = new Map(); // conversation -> { reply, warning, truncated }
let learnJob = null;

async function loadState() {
  st.state = await store.load();
  if (st.state.updatedTo) {
    st.notice = { kind: 'info', icon: 'check', text: t('updatedTo', { v: st.state.updatedTo }) };
    st.state.updatedTo = '';
    await store.save({ updatedTo: '' });
  }
}

// Gemini's free plan: the first time Auto-draft or Learn sends mail to it, say what that means
// (Burnout can't tell a free key from a paid one, so it says it once to everyone on Gemini).
async function freePlanReminder(what) {
  if (cfg().provider !== 'gemini' || st.state.freePlanSeen[what]) return;
  st.state.freePlanSeen = { ...st.state.freePlanSeen, [what]: true };
  await store.save({ freePlanSeen: st.state.freePlanSeen });
  st.notice = { kind: 'warn', icon: 'shield', text: t(what === 'learn' ? 'freePlanLearn' : 'freePlanAutoDraft') };
  paintNotice();
}

const cfg = () => {
  const s = st.state.settings;
  return { provider: s.provider, apiKey: s.apiKey, model: s.model, baseUrl: s.baseUrl };
};
const mine = () => store.ownAddresses(st.state, st.me);
const ctx = (thread) => ({ profile: st.state.profile, memory: st.state.memory, style: st.state.style, tz: timeZone(),
  party: thread ? thread.party : null, focus: thread ? thread.subject + '\n' + thread.text : '' });
const busyKey = () => (st.thread && jobs.get(st.thread.id)) || '';
const still = (thread) => !!st.thread && !!thread && st.thread.id === thread.id;
const learning = () => !!(st.learn && ['list', 'read', 'think'].includes(st.learn.stage));
const openSettings = () => chrome.runtime.openOptionsPage();

// ?tab=<id> opens the panel tied to one tab (automated tests, which can't open the
// real side panel); without it, the window's active tab counts.
const PINNED_TAB = Number(new URLSearchParams(location.search).get('tab')) || 0;

async function activeTab() {
  if (PINNED_TAB) return chrome.tabs.get(PINNED_TAB).catch(() => null);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

const isGmail = (tab) => !!(tab && tab.url && tab.url.startsWith('https://mail.google.com/'));
const toTab = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg);

// ── Screen state ────────────────────────────────────────────────────────
function leaveThread() {
  Object.assign(st, { thread: null, reply: '', warning: false, truncated: false, result: null, view: 'main', chat: [], notes: [], error: '' });
  st.drafts.change = '';
  st.drafts.ask = '';
  st.drafts.memContact = false; // "only for Sarah" doesn't carry over to the next email
}

let refreshSeq = 0;
async function refresh() {
  // while Sent is being listed Gmail runs through searches: the panel doesn't follow (it comes back at the end)
  if (st.learn && st.learn.stage === 'list') return;
  const seq = ++refreshSeq;
  await loadState();
  if (seq !== refreshSeq) return;
  if (!store.isReady(st.state)) return show('setup');
  const tab = await activeTab();
  if (seq !== refreshSeq) return;
  st.tabId = tab ? tab.id : null;
  if (!isGmail(tab)) return show('notGmail');
  let ping;
  try {
    ping = await toTab(st.tabId, { type: 'jm:ping' });
  } catch (e) {
    if (seq !== refreshSeq) return;
    // tab still loading: the end of loading calls again; loaded without Burnout in it: reload
    return show(tab.status === 'loading' ? 'loadingThread' : 'reload');
  }
  if (seq !== refreshSeq) return;
  st.me = (ping && ping.me) || st.me;
  if (!ping || !ping.threadId) {
    leaveThread();
    return show('home');
  }
  if (st.thread && st.thread.id === ping.threadId) {
    // same conversation: don't redraw (redrawing takes the cursor out of the field the person is typing in)
    if (st.screen !== 'thread') show('thread');
    return;
  }
  leaveThread();
  show('loadingThread');
  try {
    const r = await toTab(st.tabId, { type: 'jm:getThread' });
    if (seq !== refreshSeq) return;
    if (!r || !r.ok) throw new Error((r && r.error) || 'no_thread');
    let parsed = r.html ? parsePrintView(r.html) : null;
    // print page with no messages at all (format changed): use what is open on screen
    if (!parsed || !parsed.messages.length) {
      parsed = r.dom && r.dom.messages.length
        ? { account: '', ...r.dom, messages: r.dom.messages.map((m) => ({ ...m, text: stripInvisible(m.text) })) } : null;
    }
    if (!parsed) throw new Error('no_messages');
    // who the owner is: the account in the print page's header; the tab title is only the fallback
    st.me = String(parsed.account || r.me || st.me || '').toLowerCase();
    const me = mine();
    const party = partyOf(parsed, me);
    st.thread = { id: r.threadId, tabId: st.tabId, subject: parsed.subject, messages: parsed.messages, text: threadText(parsed),
      party, others: othersIn(parsed, me, party), ownerLast: ownerWroteLast(parsed, me) };
    Object.assign(st, replies.get(r.threadId) || { reply: '', warning: false, truncated: false });
    const [chat, notes] = await Promise.all([store.chatFor(r.threadId), store.notesFor(r.threadId)]);
    if (seq !== refreshSeq) return;
    st.chat = chat;
    st.notes = notes;
    show('thread');
    checkAutoWrite();
    checkAutoDraft();
  } catch (e) {
    if (seq !== refreshSeq) return;
    st.error = t('err_gmail');
    show('home');
  }
}

function show(screen) {
  st.screen = screen;
  render();
}

// A click on "Reply with Burnout" in Gmail: the panel opens and writes the reply right away.
async function checkAutoWrite() {
  const thread = st.thread;
  if (!thread || st.reply || jobs.has(thread.id) || !chrome.storage.session) return;
  let got = null;
  try {
    got = (await chrome.storage.session.get('autoWrite')).autoWrite;
  } catch (e) {
    return;
  }
  if (!got || got.tabId !== thread.tabId || got.threadId !== thread.id || Date.now() - got.at > 30000) return;
  await chrome.storage.session.remove('autoWrite').catch(() => {});
  if (still(thread) && !st.reply && st.screen === 'thread') writeReply();
}

// Auto-draft: with the switch on, opening an email (with this panel open) writes the reply and puts
// it in Gmail as a draft, once per conversation and message count. Not when the owner sent the last
// message (nothing to answer) or the sender is a robot (no-reply, notifications), and never into a
// reply box that is already open.
async function checkAutoDraft() {
  const thread = st.thread;
  if (!thread || !st.state.autoDraft || st.reply || jobs.has(thread.id) || thread.ownerLast || !thread.party) return;
  if (isAutomatedSender(thread.party.email)) return;
  const key = thread.id + ':' + thread.messages.length;
  if (await store.wasAutoDrafted(key)) return;
  if (!still(thread) || st.reply || jobs.has(thread.id)) return;
  await writeReply();
  if (!still(thread) || !st.reply) return; // the AI failed (the error is on screen) or the person moved on
  await store.markAutoDrafted(key);
  await putInGmail({ auto: true });
}

async function toggleAutoDraft() {
  const autoDraft = !st.state.autoDraft;
  st.state.autoDraft = autoDraft;
  await store.save({ autoDraft });
  paintBar();
  toast(autoDraft ? t('autoDraftOn') : t('autoDraftOff'), 5000);
  if (autoDraft) await freePlanReminder('autoDraft');
  if (autoDraft && st.screen === 'thread' && st.view === 'main') checkAutoDraft();
}

// ── AI calls ────────────────────────────────────────────────────────────
async function ai(system, user, { maxTokens = 1500, purpose = 'fast', onText } = {}) {
  const r = await complete(cfg(), { system, user, maxTokens, purpose, onText });
  st.state.usage = await store.bumpUsage(r.usage);
  return r;
}

// The AI writing: shows the text in the right place without redrawing the whole panel.
function live(thread, target) {
  return (text) => {
    if (!jobs.has(thread.id)) return;
    lives.set(thread.id, { target, text });
    if (!still(thread)) return;
    const el = app.querySelector(`[data-live="${target}"]`);
    if (!el) return render();
    if (target === 'reply') {
      el.value = text;
      el.scrollTop = el.scrollHeight;
    } else if (target === 'result') {
      el.replaceChildren(...resultLines(text));
    } else {
      el.textContent = stripReadyMarkers(text);
    }
  };
}

async function showError(e) {
  if (e && (e.code === 'network' || e.code === 'unreachable')) {
    const origin = originFor(cfg());
    const granted = origin ? await chrome.permissions.contains({ origins: [origin] }).catch(() => true) : true;
    return toast(granted ? errText(e) : t('err_permission'), 6000);
  }
  return toast(e && e.code ? errText(e) : t('err_down'), 6000);
}

/** One job per conversation. An error in one conversation doesn't show up in another. */
async function run(key, fn, onError) {
  const thread = st.thread;
  if (!thread || jobs.has(thread.id)) return;
  jobs.set(thread.id, key);
  lives.delete(thread.id);
  render();
  try {
    await fn(thread);
  } catch (e) {
    if (onError) onError(e, thread);
    if (still(thread)) await showError(e);
  } finally {
    jobs.delete(thread.id);
    lives.delete(thread.id);
    if (still(thread)) render();
  }
}

// Where a money amount may come from: the conversation, the profile, the memory that
// applies to this conversation and what the person asked for. A previous draft doesn't
// count (or an invented amount would become "known" on Redo), nor does another client's memory.
function knownText(thread, extra) {
  const party = String((thread.party && thread.party.email) || '').toLowerCase();
  const memory = st.state.memory.filter((m) => !m.contact || m.contact === party).map((m) => m.text);
  return [thread.text, ...Object.values(st.state.profile), ...memory, ...extra];
}

function setReply(thread, text, truncated, extra = []) {
  const entry = { reply: text, warning: hasUnknownMoney(text, ...knownText(thread, extra)), truncated: !!truncated };
  replies.set(thread.id, entry);
  if (still(thread)) Object.assign(st, entry);
}

// Only the person's change requests become notes for the model.
async function ownerNotes(threadId) {
  return (await store.notesFor(threadId)).filter((n) => n.kind === 'change');
}

async function writeReply() {
  await run('write', async (thread) => {
    const notes = await ownerNotes(thread.id);
    const r = await ai(P.replySystem(ctx(thread)), P.replyUser(thread, thread.party, { notes, tz: timeZone(), ownerLast: thread.ownerLast }),
      { purpose: 'reply', onText: live(thread, 'reply') });
    setReply(thread, cleanClientText(r.text), r.truncated, notes.map((n) => n.text));
  });
}

async function redo(quickKey) {
  const change = quickKey ? QUICK[quickKey] : st.drafts.change.trim();
  if (!change) return toast(t('needChange'));
  const current = st.reply.trim();
  await run(quickKey ? 'quick:' + quickKey : 'redo', async (thread) => {
    const notes = await ownerNotes(thread.id);
    const onText = live(thread, 'reply');
    const r = current
      ? await ai(P.refineSystem(ctx(thread)), P.refineUser(current, change, thread.text), { purpose: 'reply', onText })
      : await ai(P.replySystem(ctx(thread)), P.replyUser(thread, thread.party, { instruction: change, notes, tz: timeZone(), ownerLast: thread.ownerLast }),
        { purpose: 'reply', onText });
    // a typed request becomes a conversation note (the next reply remembers it), saved with the
    // subject so the person can find the conversation in the Memory tab; one-click adjustments don't
    if (!quickKey) {
      await store.addNote(thread.id, 'change', change, { subject: thread.subject });
      const notes = await store.notesFor(thread.id);
      if (still(thread)) st.notes = notes;
    }
    setReply(thread, cleanClientText(r.text), r.truncated, [quickKey ? '' : change, ...notes.map((n) => n.text)]);
    if (!quickKey && still(thread)) st.drafts.change = '';
  });
}

// auto = the auto-draft put it there, not a click: an open reply box is left alone, and nothing is
// copied to the clipboard behind the person's back.
async function putInGmail({ auto = false } = {}) {
  const text = st.reply.trim();
  if (!text) return;
  await run('insert', async (thread) => {
    let res = null;
    try {
      res = await toTab(thread.tabId, { type: 'jm:insertReply', text, replyAll: thread.others.length > 0, threadId: thread.id, onlyIfClosed: auto });
    } catch (e) {
      res = null;
    }
    if (res && res.ok) return toast(res.replaced ? t('insertReplaced') : res.stacked ? t('insertStacked') : auto ? t('autoDrafted') : t('inserted'), 6500);
    if (res && res.error === 'other_thread') return toast(t('insertOtherThread'), 6500);
    if (auto) return toast(t(res && res.error === 'box_open' ? 'autoDraftBoxOpen' : 'autoDraftKept'), 7000);
    await copyText(text);
    toast(t(res && res.error === 'forward_open' ? 'insertForward' : 'insertFailed', { paste: pasteKeys() }), 7000);
  });
}

function setResult(thread, result) {
  if (still(thread)) st.result = result;
}

async function explain() {
  await run('explain', async (thread) => {
    setResult(thread, { title: t('explain'), text: '' });
    const r = await ai(P.explainSystem(), P.explainUser(thread), { maxTokens: 2500, onText: live(thread, 'result') });
    setResult(thread, { title: t('explain'), text: r.text });
  }, (e, thread) => setResult(thread, null));
}

async function phrase() {
  let sel = '';
  try {
    sel = ((await toTab(st.tabId, { type: 'jm:getSelection' })) || {}).text || '';
  } catch (e) {
    sel = '';
  }
  if (sel.length < 2) return toast(t('phraseNone'), 5000);
  await run('phrase', async (thread) => {
    const title = '“' + clip(sel, 90) + '”';
    setResult(thread, { title, text: '' });
    const last = thread.messages[thread.messages.length - 1];
    const r = await ai(P.phraseSystem(), P.phraseUser(sel, last ? last.text : '', thread.subject), { maxTokens: 600, onText: live(thread, 'result') });
    setResult(thread, { title, text: r.text });
  }, (e, thread) => setResult(thread, null));
}

async function ask() {
  const q = st.drafts.ask.trim();
  if (!q) return;
  await run('ask', async (thread) => {
    st.pendingQ = { threadId: thread.id, q };
    render();
    const history = (await store.chatFor(thread.id)).slice(-5).map((c) => ({ q: c.q, a: clip(c.a, 1500), date: c.date }));
    const r = await ai(P.askSystem(ctx(thread)), P.askUser(thread, thread.party, { history, question: q, tz: timeZone() }),
      { maxTokens: 2000, onText: live(thread, 'ask') });
    await store.addChat(thread.id, q, r.text); // the chat is saved even if the person already switched emails
    if (st.pendingQ && st.pendingQ.threadId === thread.id) st.pendingQ = null;
    if (!still(thread)) return;
    st.chat = await store.chatFor(thread.id);
    st.drafts.ask = '';
  }, (e, thread) => {
    if (st.pendingQ && st.pendingQ.threadId === thread.id) st.pendingQ = null;
  });
}

function useAsReply(answer) {
  const body = cleanClientText(readyText(answer, st.state.profile.signature));
  if (!body || !st.thread) return;
  setReply(st.thread, body, false, st.chat.map((c) => c.q));
  st.view = 'main';
  render();
}

async function remember() {
  const text = st.drafts.mem.trim();
  if (!text) return;
  const party = st.thread && st.thread.party;
  const contact = st.drafts.memContact && party ? party.email : '';
  const r = await store.addMemory(text, { contact });
  if (r && r.full) toast(t('rememberFull'));
  else if (r && r.dup) toast(t('rememberDup'));
  else if (r && r.id) {
    st.drafts.mem = '';
    toast(contact ? t('rememberedFor', { who: party.name || contact }) : t('remembered'));
  }
  await loadState();
  render();
}

// ── Learn (runs in a corner; the rest of the panel keeps working) ───────
async function startLearn() {
  if (learnJob) return;
  const tabId = st.tabId;
  let cancelled = false;
  learnJob = {
    cancel: () => {
      cancelled = true;
      toTab(tabId, { type: 'jm:cancel' }).catch(() => {});
      st.learn = { ...st.learn, stopping: true };
      paintLearn();
    },
  };
  st.learn = { stage: 'list', done: 0, total: 0 };
  render();
  await freePlanReminder('learn');
  try {
    const listed = await toTab(tabId, { type: 'jm:listSent', max: st.learnCount });
    if (!listed || !listed.ok) throw new Error('list');
    st.learn = { stage: 'read', done: 0, total: listed.ids.length };
    refresh(); // Gmail is back where it was: the panel follows the open conversation again
    const res = await learnFromThreads({
      cfg: cfg(),
      ids: cancelled ? [] : listed.ids,
      me: store.ownAddresses(st.state, listed.me || st.me),
      isCancelled: () => cancelled,
      fetchThread: async (id) => {
        const r = await toTab(tabId, { type: 'jm:printThread', id });
        if (!r || !r.ok) throw new Error((r && r.error) || 'print');
        return r.html;
      },
      onProgress: (p) => {
        st.learn = { ...st.learn, ...p };
        paintLearn();
      },
    });
    st.learn = { stage: 'done', ...res, stopped: res.stopped || cancelled };
  } catch (e) {
    st.learn = { stage: 'error', message: e && e.code ? errText(e) : t('err_gmail') };
  }
  learnJob = null;
  await loadState();
  render();
  refresh();
}

function learnProgress() {
  const l = st.learn;
  const pct = l.total ? Math.round((l.done / l.total) * 100) : 4;
  const label = l.stopping ? t('learnStopping')
    : l.stage === 'list' ? t('learnListing')
      : l.stage === 'read' ? t('learnReading', { done: l.done, total: l.total })
        : t('learnThinking', { done: l.done, total: l.total });
  return [h('div', { class: 'progress' }, h('div', { style: `width:${Math.max(4, pct)}%` })), h('p', { class: 'hint' }, label)];
}

function paintLearn() {
  const el = app.querySelector('[data-live="learn"]');
  if (el) el.replaceChildren(...learnProgress());
  else render();
}

function learnCard() {
  const l = st.learn;
  const style = st.state.style;
  const learnedN = st.state.memory.filter((m) => m.source === 'learned').length;
  const head = h('div', { class: 'ttl' }, t('learnTitle'), h('span', { class: 'grow' }),
    l && !learning() ? h('button', { class: 'btn ghost icon sm', title: t('close'), 'aria-label': t('close'),
      onclick: () => { st.learn = null; if (st.view === 'learn') st.view = 'main'; render(); } }, icon('x', 14)) : null);
  if (learning()) {
    return h('section', { class: 'card' }, head,
      h('div', { 'data-live': 'learn' }, learnProgress()),
      h('p', { class: 'hint' }, t('learnKeepOpen')),
      h('button', { class: 'btn sm', onclick: () => learnJob && learnJob.cancel(), disabled: !!l.stopping }, t('learnCancel')));
  }
  const body = [head];
  if (l && l.stage === 'done') {
    if (l.emails || !l.unreadable) {
      body.push(h('div', { class: 'note ' + (l.emails ? 'ok' : 'info') }, icon(l.emails ? 'check' : 'info', 14),
        h('span', null, l.emails ? t('learnDone', { emails: l.emails, facts: l.facts }) : t('learnNone'))));
    }
    if (l.unreadable) body.push(h('div', { class: 'note warn' }, icon('alert', 14), h('span', null, t('learnUnreadable', { n: l.unreadable }))));
    if (l.stopped || l.error) {
      body.push(h('div', { class: 'note warn' }, icon('alert', 14), h('span', null, t('learnStopped') + (l.error ? ' ' + errText({ code: l.error }) : ''))));
    }
    if (l.truncated) body.push(h('div', { class: 'note warn' }, icon('alert', 14), h('span', null, t('learnTruncated'))));
    if (l.aliases && l.aliases.length) body.push(h('div', { class: 'note info' }, icon('user', 14), h('span', null, t('learnAliases', { list: l.aliases.join(', ') }))));
  } else if (l && l.stage === 'error') {
    body.push(h('div', { class: 'note err' }, icon('alert', 14), h('span', null, l.message)));
  } else {
    body.push(h('p', { class: 'muted small' }, t('learnText')));
  }
  body.push(h('div', { class: 'stats' },
    h('div', { class: 'stat' }, h('b', null, String(learnedN)), h('span', null, t('learnStatMem'))),
    h('div', { class: 'stat' }, h('b', null, String(style.emails || 0)), h('span', null, t('learnStatEmails')))));
  if (style.summary) {
    body.push(h('div', { class: 'ttl sub' }, t('learnedStyle')), h('p', { class: 'small result' }, style.summary),
      style.learnedAt ? h('p', { class: 'hint' }, t('learnLast', { date: style.learnedAt, n: style.emails })) : null);
  }
  body.push(h('div', { class: 'ttl sub' }, t('learnCount')),
    h('div', { class: 'chips' }, LEARN_COUNTS.map((n) => h('button', { class: 'chip' + (n === st.learnCount ? ' on' : ''),
      'aria-pressed': n === st.learnCount ? 'true' : 'false', onclick: () => { st.learnCount = n; render(); } }, String(n)))),
    h('button', { class: 'btn primary', onclick: startLearn }, icon('learn', 15), style.summary ? t('learnAgain') : t('learnStart')));
  return h('section', { class: 'card' }, body);
}

// ── Screens ─────────────────────────────────────────────────────────────
const spin = (label) => h('span', { class: 'busy' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), label || null);
const skeleton = (n = 4) => h('div', { class: 'skel', 'aria-hidden': 'true' }, Array.from({ length: n }, () => h('span')));
const note = (kind, ic, text) => h('div', { class: 'note ' + kind }, icon(ic, 14), h('span', null, text));

function initials(s) {
  const parts = String(s || '').trim().split(/[\s@._-]+/).filter(Boolean);
  return (((parts[0] || '?')[0] || '?') + ((parts[1] || '')[0] || '')).toUpperCase();
}

function bar() {
  const ready = !!st.state && store.isReady(st.state);
  const name = ready ? shortName(cfg()) : '';
  const on = !!(st.state && st.state.autoDraft);
  return h('header', { class: 'bar' },
    h('img', { class: 'mark', src: 'icons/icon32.png', alt: '' }),
    h('span', { class: 'brand' }, t('brandName')),
    name ? h('button', { class: 'pill', title: t('aiConnected'), onclick: openSettings }, h('span', { class: 'pill-name' }, name)) : null,
    h('span', { class: 'grow' }),
    ready ? h('button', { class: 'switch' + (on ? ' on' : ''), type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false',
      title: t('autoDraftTip'), onclick: toggleAutoDraft }, h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-knob' })),
      t('autoDraft')) : null,
    h('button', { class: 'btn ghost icon', title: t('settings'), 'aria-label': t('settings'), onclick: openSettings }, icon('sliders', 16)));
}

// Only the top bar (the switch changed): a full redraw would take the cursor away from whoever is typing.
function paintBar() {
  const el = app.querySelector('header.bar');
  if (el) el.replaceWith(bar());
}

// A notice at the top of the panel (an update, the free-plan reminder) that stays until it's closed.
function noticeEl() {
  const n = st.notice;
  if (!n) return null;
  const close = () => {
    st.notice = null;
    paintNotice();
  };
  return h('div', { class: 'note notice ' + n.kind, role: 'status' }, icon(n.icon, 14), h('span', null, n.text),
    h('button', { class: 'btn ghost icon sm', type: 'button', title: t('close'), 'aria-label': t('close'), onclick: close }, icon('x', 12)));
}

// Same reason as paintBar: only the notice changes, nothing else is redrawn.
function paintNotice() {
  const main = app.querySelector('main.wrap');
  if (!main) return;
  const old = main.querySelector(':scope > .notice');
  const el = noticeEl();
  if (old) old.replaceWith(...(el ? [el] : []));
  else if (el) main.prepend(el);
}

function footer() {
  const n = st.state.memory.length;
  const usage = st.state.usage.month === localMonth() ? st.state.usage.calls : 0;
  return h('footer', { class: 'foot' },
    h('span', null, t('memoryCount', { n }), ' · ', usage === 1 ? t('usageLine1') : t('usageLine', { n: usage })));
}

function hero(ic, title, text, button) {
  return h('section', { class: 'card hero' }, h('h1', null, title),
    h('p', { class: 'muted' }, text), button || null);
}

function threadHead() {
  const th = st.thread;
  const p = th.party || {};
  const who = p.name || p.email;
  return h('section', { class: 'card' },
    h('div', { class: 'subject', title: th.subject || '' }, th.subject || t('noSubject')),
    who ? h('div', { class: 'who-row' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(who)),
      h('div', { class: 'who-text' }, h('div', { class: 'who-name' }, who), p.name && p.email ? h('div', { class: 'who-mail' }, p.email) : null),
      h('span', { class: 'count' }, th.messages.length === 1 ? t('msgs1') : t('msgsN', { n: th.messages.length }))) : null);
}

function replyCard() {
  const th = st.thread;
  const key = busyKey();
  const writing = key === 'write' || key === 'redo' || key.startsWith('quick:');
  const lv = lives.get(th.id);
  const liveText = lv && lv.target === 'reply' ? lv.text : '';
  if (!st.reply && !writing) {
    return h('section', { class: 'card hero-write' },
      h('button', { class: 'btn primary xl', onclick: writeReply, disabled: !!key }, t('write')),
      h('p', { class: 'hint center' }, th.ownerLast ? t('writeHintFollowUp') : t('writeHint')));
  }
  const head = h('div', { class: 'ttl' }, t('replyTitle'), h('span', { class: 'grow' }),
    writing ? spin(t('writing')) : null);
  let body;
  if (writing && !liveText && !st.reply) {
    body = skeleton(5);
  } else {
    body = h('textarea', { class: 'reply', 'data-live': 'reply', 'aria-label': t('replyTitle'), readonly: writing || null,
      oninput: (e) => {
        st.reply = e.target.value;
        replies.set(th.id, { reply: st.reply, warning: st.warning, truncated: st.truncated });
      } });
    body.value = writing && liveText ? liveText : st.reply;
  }
  const change = h('input', { type: 'text', placeholder: t('changeHint'), 'aria-label': t('changeHint'), value: st.drafts.change,
    oninput: (e) => { st.drafts.change = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) redo(); } });
  return h('section', { class: 'card' }, head, body,
    st.warning && !writing ? note('warn', 'alert', t('warnNumbers')) : null,
    st.truncated && !writing ? note('warn', 'alert', t('truncated')) : null,
    // the fewest buttons (the owner, Oct 17): Put in Gmail is the way out, Enter applies a typed change;
    // the text can still be selected and copied by hand
    h('div', { class: 'row nowrap' },
      h('button', { class: 'btn primary grow', onclick: () => putInGmail(), disabled: !!key || !st.reply }, key === 'insert' ? h('span', { class: 'spin' }) : icon('insert', 15), t('putInGmail'))),
    h('p', { class: 'hint' }, t('trustLine')),
    h('div', { class: 'ttl sub' }, t('adjustTitle')),
    h('div', { class: 'chips' }, Object.keys(QUICK).map((k) => h('button', { class: 'chip', onclick: () => redo(k), disabled: !!key || !st.reply },
      key === 'quick:' + k ? h('span', { class: 'spin' }) : null, t('quick_' + k)))),
    h('div', { class: 'row nowrap' }, change));
}

// Notes on this conversation: what the person asked for with Redo. They stay in sight and each one
// can be deleted. With no notes the card is hidden (and takes no space), ready to appear without a redraw.
function notesCard() {
  const n = st.notes.length;
  return h('section', { class: 'card', 'data-live': 'notes', hidden: !n }, n ? [
    h('div', { class: 'ttl' }, t('notesTitle', { n })),
    h('p', { class: 'hint' }, t('notesHint')),
    h('div', { class: 'list' }, st.notes.map((note) => h('div', { class: 'nitem' },
      h('span', { class: 'mem-meta' }, note.date || ''),
      h('span', { class: 'mem-text' }, note.text),
      h('button', { class: 'btn ghost icon sm', title: t('noteDelete'), 'aria-label': `${t('noteDelete')}: ${clip(note.text, 60)}`,
        onclick: () => deleteNote(note) }, icon('trash', 13))))),
  ] : null);
}

// Swaps only the notes card (redrawing everything takes the cursor away from whoever is typing).
function paintNotes() {
  const el = app.querySelector('[data-live="notes"]');
  if (!el) return; // another view (Ask, Learn): going back to the panel draws it right
  const at = [...el.querySelectorAll('button')].indexOf(document.activeElement);
  const fresh = notesCard();
  el.replaceWith(fresh);
  // on the keyboard, deleting a note moves focus to the next note's trash button
  const btns = fresh.querySelectorAll('button');
  if (at >= 0 && btns.length) btns[Math.min(at, btns.length - 1)].focus();
}

async function deleteNote(note) {
  const thread = st.thread;
  if (!thread) return;
  await store.removeNote(thread.id, note);
  const notes = await store.notesFor(thread.id);
  if (!still(thread)) return;
  st.notes = notes;
  paintNotes();
  toast(t('noteDeleted'));
}

function toolsCard() {
  const key = busyKey();
  // words only, so the three fit on one line of the panel
  const tool = (label, fn, busy, title) => h('button', { class: 'tool', onclick: fn, disabled: !!key, title: title || label },
    key === busy ? h('span', { class: 'spin' }) : null, h('span', null, label));
  return h('section', { class: 'card' }, h('div', { class: 'ttl' }, t('understandTitle')),
    h('div', { class: 'tools3' },
      tool(t('explain'), explain, 'explain'),
      tool(t('phrase'), phrase, 'phrase', t('phraseTip')),
      tool(t('ask'), openAsk, 'ask')));
}

// Ask: the cursor goes straight to the question box (one click fewer).
function openAsk() {
  st.view = 'ask';
  render();
  const box = app.querySelector('textarea');
  if (box) box.focus();
}

// The explanation's headings (an all-caps line, e.g. SUMMARY) become headers.
function resultLines(text) {
  return String(text || '').split('\n').map((line) => (/^[A-ZÀ-ÖØ-Þ ]{4,40}$/.test(line.trim())
    ? h('div', { class: 'res-head' }, line.trim())
    : h('div', null, line || ' ')));
}

function resultCard() {
  if (!st.result) return null;
  const th = st.thread;
  const lv = lives.get(th.id);
  const streaming = lv && lv.target === 'result';
  const text = streaming ? lv.text : st.result.text;
  const busy = ['explain', 'phrase'].includes(busyKey());
  return h('section', { class: 'card' },
    h('div', { class: 'ttl' }, h('span', { class: 'grow' }, st.result.title),
      busy ? spin('') : h('button', { class: 'btn ghost icon sm', title: t('close'), 'aria-label': t('close'), onclick: () => { st.result = null; render(); } }, icon('x', 14))),
    text ? h('div', { class: 'result', 'data-live': 'result' }, resultLines(text)) : skeleton(4));
}

function memoryCard() {
  const input = h('input', { type: 'text', placeholder: t('rememberHint'), 'aria-label': t('rememberHint'), value: st.drafts.mem,
    oninput: (e) => { st.drafts.mem = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) remember(); } });
  const party = st.thread && st.thread.party;
  const who = party && (party.name || party.email);
  return h('section', { class: 'card' }, h('div', { class: 'ttl' }, t('rememberTitle')),
    h('div', { class: 'row nowrap' }, input, h('button', { class: 'btn icon', title: t('rememberAdd'), 'aria-label': t('rememberAdd'), onclick: remember }, icon('plus', 15))),
    party && party.email ? h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: st.drafts.memContact, onchange: (e) => { st.drafts.memContact = e.target.checked; } }),
      t('rememberOnlyFor', { who })) : null,
    st.learn ? null : h('button', { class: 'btn ghost sm teach', onclick: () => { st.view = 'learn'; render(); } }, icon('learn', 14), t('teach')));
}

function askView() {
  const th = st.thread;
  const key = busyKey();
  const lv = lives.get(th.id);
  const items = [];
  for (const c of st.chat) {
    items.push(h('div', { class: 'who me' }, `${t('you')} · ${c.date}`), h('div', { class: 'bubble me' }, c.q),
      h('div', { class: 'who' }, t('brandName')), h('div', { class: 'bubble ai' }, stripReadyMarkers(c.a)));
    if (readyText(c.a, st.state.profile.signature)) items.push(h('button', { class: 'btn primary sm', style: 'justify-self:start', onclick: () => useAsReply(c.a) }, icon('insert', 13), t('useAsReply')));
  }
  if (key === 'ask' && st.pendingQ && st.pendingQ.threadId === th.id) {
    items.push(h('div', { class: 'who me' }, t('you')), h('div', { class: 'bubble me' }, st.pendingQ.q), h('div', { class: 'who' }, t('brandName')),
      lv && lv.text ? h('div', { class: 'bubble ai', 'data-live': 'ask' }, stripReadyMarkers(lv.text)) : h('div', { class: 'bubble ai' }, spin(t('askThinking'))));
  }
  const input = h('textarea', { placeholder: t('askHint'), 'aria-label': t('askHint'), rows: 3,
    oninput: (e) => { st.drafts.ask = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask(); } });
  input.value = st.drafts.ask;
  return [
    h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: () => { st.view = 'main'; render(); } }, icon('back', 14), t('back'))),
    threadHead(),
    h('section', { class: 'card' }, h('div', { class: 'ttl' }, t('askTitle')),
      items.length ? h('div', { class: 'msgs' }, items) : h('p', { class: 'hint' }, t('askEmpty')),
      input,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: ask, disabled: !!key }, key === 'ask' ? h('span', { class: 'spin' }) : icon('send', 14), t('askBtn'))),
      h('p', { class: 'hint' }, t('noTools'))),
  ];
}

function render() {
  if (!st.state) return;
  const body = [];
  switch (st.screen) {
    case 'setup':
      body.push(hero('plug', t('setupTitle'), t('setupText'), h('button', { class: 'btn primary xl', onclick: openSettings }, t('setupBtn'))));
      break;
    case 'notGmail':
      body.push(hero('mail', t('notGmailTitle'), t('notGmailText'),
        h('button', { class: 'btn primary', onclick: () => chrome.tabs.create({ url: 'https://mail.google.com/' }) }, icon('external', 14), t('openGmail'))));
      break;
    case 'reload':
      body.push(hero('refresh', t('reloadTitle'), t('reloadText'),
        h('button', { class: 'btn primary', onclick: () => chrome.tabs.reload(st.tabId) }, icon('refresh', 14), t('reloadBtn'))));
      break;
    case 'loadingThread':
      body.push(h('section', { class: 'card' }, h('div', { class: 'ttl' }, spin(t('readingEmail'))), skeleton(3)));
      break;
    case 'home':
      body.push(hero('mail', t('homeTitle'), t('homeText'),
        st.shortcut ? h('p', { class: 'hint' }, t('shortcutHint'), ' ', h('kbd', null, st.shortcut)) : null));
      if (st.error) body.push(note('err', 'alert', st.error));
      body.push(learnCard());
      break;
    case 'thread':
      if (st.view === 'ask') {
        body.push(...askView());
      } else if (st.view === 'learn') {
        body.push(h('div', { class: 'row' }, h('button', { class: 'btn ghost sm', onclick: () => { st.view = 'main'; render(); } }, icon('back', 14), t('back'))),
          threadHead(), learnCard());
      } else {
        body.push(threadHead(), replyCard(), notesCard(), toolsCard(), resultCard(), memoryCard());
        if (st.learn) body.push(learnCard()); // learning (or just learned): stays at the bottom, out of the way
      }
      break;
    default:
      body.push(h('section', { class: 'card' }, skeleton(3)));
  }
  const out = [bar(), h('main', { class: 'wrap' }, [noticeEl(), ...body].filter(Boolean))];
  if (st.screen !== 'loading') out.push(footer());
  app.replaceChildren(...out);
}

// ── Chrome events ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'jm:threadChanged' && sender.tab && sender.tab.id === st.tabId) refresh();
  return false;
});
chrome.tabs.onActivated.addListener(() => refresh());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === st.tabId && (info.status === 'complete' || info.url)) refresh();
});
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'session') {
    if (changes.autoWrite && changes.autoWrite.newValue) checkAutoWrite();
    return;
  }
  if (area !== 'local') return;
  if (changes.notes && st.thread) {
    // deleted in the Memory tab (or a backup replaced everything): the notes card follows
    const thread = st.thread;
    const notes = await store.notesFor(thread.id);
    if (still(thread) && JSON.stringify(notes) !== JSON.stringify(st.notes)) {
      st.notes = notes;
      paintNotes();
    }
  }
  if (changes.autoDraft && st.state) {
    // switched in another window: the switch here follows
    st.state.autoDraft = !!changes.autoDraft.newValue;
    paintBar();
  }
  if (changes.settings || changes.profile || changes.onboarded) {
    await refresh();
    render(); // the AI changed: the name at the top changes
  } else if (changes.memory || changes.style || changes.identity) {
    // Learn saves batch by batch: update the numbers without redrawing (nobody loses their cursor)
    await loadState();
  }
});

if (chrome.commands && chrome.commands.getAll) {
  chrome.commands.getAll().then((cmds) => {
    const c = cmds.find((x) => x.name === '_execute_action');
    st.shortcut = (c && c.shortcut) || '';
  }).catch(() => {});
}

refresh();
