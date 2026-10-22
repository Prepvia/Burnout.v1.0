// Everything Burnout keeps stays in the person's browser (chrome.storage.local).
// Nothing goes to any server. Backup = a JSON file they download and can import
// back (on the same computer or another one).

import { keywords, localDate, localMonth, oneLine } from './text.js';

// Each reply only gets the memory that matters for the open email, so the lists can be long.
export const MEMORY_MAX = { manual: 300, learned: 3000 };
// The owner's own emails kept to write like them (their part only): a few MB in the browser.
export const VOICE_MAX = 3000;
const VOICE_TEXT = 1200;
export const NOTES_PER_THREAD = 10;
const CHAT_TURNS = 10;
const CHAT_ANSWER_MAX = 4000;
export const NOTE_THREADS_KEPT = 200;
const SUBJECT_MAX = 200;
const CHAT_THREADS_KEPT = 100;
const SEEN_KEPT = 50000;
const PENDING_KEPT = 20000;
const ALIASES_MAX = 20;
const AUTO_DRAFTS_KEPT = 500;
export const BACKUP_KIND = 'burnout-backup';
export const BACKUP_VERSION = 2;
const PROVIDER_IDS = ['gemini', 'openai', 'anthropic', 'compatible', 'custom'];
const KEYLESS = ['compatible', 'custom']; // a self-hosted server may not need a key

export const DEFAULTS = {
  // unconfirmed = the AI came from a backup file and the person hasn't clicked Test and save yet
  settings: { provider: 'gemini', apiKey: '', model: '', baseUrl: '', preset: '', unconfirmed: false },
  profile: { name: '', about: '', services: '', hours: '', booking: '', signature: '', never: '', tone: '', emails: '' },
  memory: [],
  style: { summary: '', examples: [], learnedAt: '', emails: 0 },
  // seen = conversations already learned; pending = [id, day] listed but not learned yet;
  // range = the stretch of the Sent folder already listed, in days since 1970 ({ hi, lo, end })
  // bytes = [hour, bytes] Learn downloaded from Gmail in the last 24 hours (it stays under Gmail's limits)
  learn: { seen: [], lastRun: '', lastCount: 0, pending: [], range: null, bytes: [] },
  identity: { aliases: [] },
  notes: {},
  chats: {},
  autoDraft: false, // the panel's Auto-draft switch
  autoDrafted: [], // "<thread>:<message count>" already auto-drafted
  usage: { month: '', calls: 0, input: 0, output: 0 },
  onboarded: false,
  freePlanSeen: {}, // free-Gemini reminders already shown: { autoDraft, learn }
  updatedTo: '', // version set by background.js after an update; the panel says it once
};

function area() {
  return globalThis.chrome.storage.local;
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

export async function load(keys = Object.keys(DEFAULTS)) {
  const got = await area().get(keys);
  const out = {};
  for (const k of keys) {
    const def = clone(DEFAULTS[k]);
    const v = got[k];
    out[k] = v === undefined ? def : (def && typeof def === 'object' && !Array.isArray(def) ? { ...def, ...v } : v);
  }
  return out;
}

export async function save(partial) {
  await area().set(partial);
}

/** The AI has what it needs: a key, or an address for a self-hosted server (Ollama needs no key). */
function hasAi(s) {
  return !!(String(s.apiKey || '').trim() || (KEYLESS.includes(s.provider) && String(s.baseUrl || '').trim()));
}

/**
 * The AI is connected: it has what it needs and the person set it up here. An AI that came in a
 * backup file waits for Test and save, so a file can never send someone's email to a server
 * they didn't pick themselves.
 */
export function connected(settings) {
  const s = settings || {};
  return !s.unconfirmed && hasAi(s);
}

export function isReady(state) {
  const p = state.profile || {};
  return !!(connected(state.settings) && String(p.name || '').trim() && String(p.about || '').trim());
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAILS_IN = /[A-Za-z0-9._%+\-']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

/** The person's own addresses: the account, the ones in the profile and the ones Learn found. */
export function ownAddresses(state, account = '') {
  const out = new Set();
  const add = (e) => {
    const v = String(e || '').trim().toLowerCase();
    if (EMAIL_RE.test(v)) out.add(v);
  };
  add(account);
  for (const e of String((state.profile && state.profile.emails) || '').match(EMAILS_IN) || []) add(e);
  for (const e of (state.identity && Array.isArray(state.identity.aliases) ? state.identity.aliases : [])) add(e);
  return [...out];
}

export async function removeAlias(email) {
  const { identity } = await load(['identity']);
  const drop = String(email || '').trim().toLowerCase();
  const aliases = (Array.isArray(identity.aliases) ? identity.aliases : []).filter((a) => a !== drop);
  await save({ identity: { ...identity, aliases } });
  return aliases;
}

export async function addAliases(emails) {
  const { identity } = await load(['identity']);
  const set = new Set(Array.isArray(identity.aliases) ? identity.aliases : []);
  for (const e of emails || []) {
    const v = String(e || '').trim().toLowerCase();
    if (EMAIL_RE.test(v)) set.add(v);
  }
  const aliases = [...set].slice(0, ALIASES_MAX);
  await save({ identity: { ...identity, aliases } });
  return aliases;
}

let seq = 0;
function newId() {
  seq += 1;
  return Date.now().toString(36) + '-' + seq.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

// Same text ignoring case and punctuation; but the separator between digits counts ($1.50 is not $15.0).
const norm = (s) => oneLine(s, 400).toLowerCase().replace(/(?<=\d)[.,](?=\d)/g, '#').replace(/[^\p{L}\p{N}# ]/gu, '');
const numbersOf = (s) => (oneLine(s, 400).match(/\d[\d.,]*/g) || []).map((n) => n.replace(/[.,]+$/, '')).sort().join(' ');
const kindOf = (m) => (m.source === 'learned' ? 'learned' : 'manual');

function scopeOf(contact) {
  const who = String(contact || '').trim().toLowerCase();
  return EMAIL_RE.test(who) ? who : '';
}

const factKey = (text) => ({ n: norm(text), k: keywords(text), nums: numbersOf(text) });

/** The same fact in other words: the same numbers and almost the same words ($1.40 and $1.50 are two facts). */
function sameFact(a, b) {
  if (a.n === b.n) return true;
  if (a.nums !== b.nums || a.k.size < 3 || b.k.size < 3) return false;
  let both = 0;
  for (const w of a.k) if (b.k.has(w)) both += 1;
  return both / (a.k.size + b.k.size - both) >= 0.8;
}

/** Over the limit: the learned facts from the oldest emails leave first (manual ones never leave on their own). */
function trimLearned(memory) {
  const learned = memory.map((m, i) => ({ m, i })).filter((x) => kindOf(x.m) === 'learned');
  const extra = learned.length - MEMORY_MAX.learned;
  if (extra <= 0) return memory;
  learned.sort((a, b) => String(a.m.date || '').localeCompare(String(b.m.date || '')) || a.i - b.i);
  const drop = new Set(learned.slice(0, extra).map((x) => x.m));
  return memory.filter((m) => !drop.has(m));
}

/**
 * Saves a memory. contact = one person's email: the memory only goes into replies to
 * them ("Sarah wants the invoice as a PDF"). Returns the saved item, or { dup: true }
 * when it already existed (with the same scope), or { full: true } when the list of what
 * the person taught is full.
 */
export async function addMemory(text, { source = 'manual', date = localDate(), contact = '' } = {}) {
  const clean = oneLine(text, 400);
  if (!clean) return null;
  const kind = source === 'learned' ? 'learned' : 'manual';
  const scope = scopeOf(contact);
  const { memory } = await load(['memory']);
  if (memory.some((m) => norm(m.text) === norm(clean) && (m.contact || '') === scope)) return { dup: true };
  if (kind === 'manual' && memory.filter((m) => kindOf(m) === 'manual').length >= MEMORY_MAX.manual) return { full: true };
  const item = { id: newId(), text: clean, date: String(date || localDate()).slice(0, 10), source: kind };
  if (scope) item.contact = scope;
  memory.push(item);
  await save({ memory: trimLearned(memory) });
  return item;
}

/**
 * Saves many learned facts at once, with one read and one write: [{ text, date, contact }].
 * A fact that is already there, in the same or other words, doesn't come in twice; when it
 * shows up again in a newer email, the one already there takes the newer date (it is still
 * true). Returns how many new facts stayed.
 */
export async function addMemories(items, { source = 'learned' } = {}) {
  const kind = source === 'learned' ? 'learned' : 'manual';
  const { memory } = await load(['memory']);
  const byScope = new Map();
  const index = (m) => {
    const s = m.contact || '';
    if (!byScope.has(s)) byScope.set(s, []);
    byScope.get(s).push({ m, ...factKey(m.text) });
  };
  memory.forEach(index);
  const fresh = [];
  let changed = false;
  for (const it of items || []) {
    const clean = oneLine(it && it.text, 400);
    if (!clean) continue;
    const scope = scopeOf(it.contact);
    const date = DAY_RE.test(String(it.date || '')) && it.date <= localDate() ? it.date : localDate();
    const key = factKey(clean);
    const same = (byScope.get(scope) || []).find((x) => sameFact(x, key));
    if (same) {
      if (kindOf(same.m) === 'learned' && date > String(same.m.date || '')) {
        same.m.date = date;
        changed = true;
      }
      continue;
    }
    const item = { id: newId(), text: clean, date, source: kind };
    if (scope) item.contact = scope;
    memory.push(item);
    index(item);
    fresh.push(item);
  }
  if (!fresh.length && !changed) return 0;
  const kept = trimLearned(memory);
  await save({ memory: kept });
  const stayed = new Set(kept);
  return fresh.filter((m) => stayed.has(m)).length;
}

export async function removeMemory(ids) {
  const drop = new Set([].concat(ids));
  const { memory } = await load(['memory']);
  const kept = memory.filter((m) => !drop.has(m.id));
  await save({ memory: kept });
  return memory.length - kept.length;
}

function trimThreads(map, max) {
  const ids = Object.keys(map);
  if (ids.length <= max) return map;
  ids.sort((a, b) => String(map[a].at || '').localeCompare(String(map[b].at || '')));
  for (const id of ids.slice(0, ids.length - max)) delete map[id];
  return map;
}

// Notes change from more than one place on the same screen (Redo saves, the trash button
// deletes): one change at a time, or the second write overwrites the first. fn returns
// whether it changed anything.
let notesQueue = Promise.resolve();
function editNotes(fn) {
  const run = notesQueue.then(async () => {
    const { notes } = await load(['notes']);
    if (fn(notes)) await save({ notes });
  });
  notesQueue = run.catch(() => {});
  return run;
}

/**
 * Conversation note: what the person asked Burnout for in this thread, with its date.
 * subject = the conversation's subject, so they can find it in the Memory tab (old notes have none).
 */
export async function addNote(threadId, kind, text, { subject } = {}) {
  if (!threadId || !String(text || '').trim()) return;
  await editNotes((notes) => {
    const entry = notes[threadId] || { at: '', items: [] };
    entry.items.push({ date: localDate(), kind, text: oneLine(text, 600) });
    entry.items = entry.items.slice(-NOTES_PER_THREAD);
    entry.at = new Date().toISOString();
    if (typeof subject === 'string') entry.subject = oneLine(subject, SUBJECT_MAX);
    notes[threadId] = entry;
    trimThreads(notes, NOTE_THREADS_KEPT);
    return true;
  });
}

export async function notesFor(threadId) {
  const { notes } = await load(['notes']);
  return ((notes[threadId] || {}).items || []).slice();
}

/** Deletes one note of the conversation (the one with the same date and text). A conversation left with no notes leaves the list. Returns 1 or 0. */
export async function removeNote(threadId, note) {
  if (!threadId || !note) return 0;
  let removed = 0;
  await editNotes((notes) => {
    const entry = notes[threadId];
    const i = entry && Array.isArray(entry.items) ? entry.items.findIndex((n) => n.date === note.date && n.text === note.text) : -1;
    if (i < 0) return false;
    entry.items.splice(i, 1);
    if (!entry.items.length) delete notes[threadId];
    removed = 1;
    return true;
  });
  return removed;
}

/** Deletes all notes of a conversation. Returns how many there were. */
export async function clearNotes(threadId) {
  if (!threadId) return 0;
  let removed = 0;
  await editNotes((notes) => {
    if (!notes[threadId]) return false;
    removed = Array.isArray(notes[threadId].items) ? notes[threadId].items.length : 0;
    delete notes[threadId];
    return true;
  });
  return removed;
}

/** Conversations that have notes, newest first. subject null = an old note, saved before subjects were kept. */
export function noteThreads(notes) {
  return Object.entries(isObj(notes) ? notes : {})
    .filter(([, v]) => isObj(v) && Array.isArray(v.items) && v.items.length)
    .map(([id, v]) => ({ id, at: String(v.at || ''), subject: typeof v.subject === 'string' ? v.subject : null, items: v.items.slice() }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// Auto-draft runs once per conversation and message count: reopening the email doesn't draft it
// again, a new message in the thread does.
export async function wasAutoDrafted(key) {
  const { autoDrafted } = await load(['autoDrafted']);
  return Array.isArray(autoDrafted) && autoDrafted.includes(key);
}

export async function markAutoDrafted(key) {
  const { autoDrafted } = await load(['autoDrafted']);
  const list = Array.isArray(autoDrafted) ? autoDrafted.filter((k) => k !== key) : [];
  await save({ autoDrafted: [...list, key].slice(-AUTO_DRAFTS_KEPT) });
}

export async function addChat(threadId, q, a) {
  if (!threadId) return;
  const { chats } = await load(['chats']);
  const entry = chats[threadId] || { at: '', turns: [] };
  entry.turns.push({ date: localDate(), q: String(q || '').slice(0, 1000), a: String(a || '').slice(0, CHAT_ANSWER_MAX) });
  entry.turns = entry.turns.slice(-CHAT_TURNS);
  entry.at = new Date().toISOString();
  chats[threadId] = entry;
  await save({ chats: trimThreads(chats, CHAT_THREADS_KEPT) });
}

export async function chatFor(threadId) {
  const { chats } = await load(['chats']);
  return ((chats[threadId] || {}).turns || []).slice();
}

/** Counts this month's request. Never breaks the action: the AI already answered, the count is just informative. */
export async function bumpUsage(usage) {
  try {
    const { usage: cur } = await load(['usage']);
    const month = localMonth();
    const base = cur.month === month ? cur : { month, calls: 0, input: 0, output: 0 };
    base.calls += 1;
    base.input += (usage && usage.input) || 0;
    base.output += (usage && usage.output) || 0;
    await save({ usage: base });
    return base;
  } catch (e) {
    return { month: localMonth(), calls: 0, input: 0, output: 0 };
  }
}

/** Conversations Learn finished: they leave the waiting list and are never read again. */
export async function markSeen(ids) {
  if (!ids || !ids.length) return;
  const { learn } = await load(['learn']);
  const seen = new Set(learn.seen);
  for (const id of ids) seen.add(id);
  learn.seen = [...seen].slice(-SEEN_KEPT);
  const done = new Set(ids);
  learn.pending = (Array.isArray(learn.pending) ? learn.pending : []).filter((p) => !done.has(Array.isArray(p) ? p[0] : p));
  await save({ learn });
}

/** What Learn downloaded from Gmail ({ t, n } in ms and bytes), kept by hour for the last 24 hours. */
export async function saveLearnBytes(events) {
  const since = Date.now() - 24 * 3600000;
  const byHour = new Map();
  for (const e of events || []) {
    if (!(e && e.t >= since && e.n > 0)) continue;
    const hour = Math.floor(e.t / 3600000) * 3600000;
    byHour.set(hour, (byHour.get(hour) || 0) + e.n);
  }
  const { learn } = await load(['learn']);
  learn.bytes = [...byHour].sort((a, b) => a[0] - b[0]);
  await save({ learn });
}

/**
 * What the Sent folder listing found: the conversations waiting to be learned ([id, day]) and
 * the stretch of the folder already gone through, so the next Learn picks up from there.
 */
export async function saveLearnPlan({ pending, range, account = '' }) {
  const { learn } = await load(['learn']);
  learn.account = String(account || '').toLowerCase();
  learn.pending = (Array.isArray(pending) ? pending : [])
    .filter((p) => Array.isArray(p) && THREAD_RE.test(String(p[0])))
    .map(([id, day]) => [id, Number.isFinite(Number(day)) ? Math.floor(Number(day)) : 0])
    .slice(0, PENDING_KEPT);
  learn.range = range && Number.isFinite(range.hi) && Number.isFinite(range.lo) ? { hi: range.hi, lo: range.lo, end: !!range.end } : null;
  await save({ learn });
}

// ── The owner's own emails, to write like them ──────────────────────────
// Kept apart from the rest: it is big, only the replies and Learn use it, and a backup
// leaves it out (on another computer, Learn fills it again). Each one:
// { t: conversation, d: 'YYYY-MM-DD' ('' when unknown), to: [addresses], s: subject, x: the owner's text }.
const ADDRESSES_IN = /[A-Za-z0-9._%+\-']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

export async function loadVoice() {
  const got = await area().get(['voice']);
  return Array.isArray(got.voice) ? got.voice : [];
}

/**
 * Adds the owner's emails ({ threadId, date, to, subject, text }) from one Gmail account. Over the
 * limit, the oldest leave. Returns how many came in.
 */
export async function addVoice(emails, { account = '' } = {}) {
  const acct = EMAIL_RE.test(String(account || '').toLowerCase()) ? String(account).toLowerCase() : '';
  const voice = await loadVoice();
  const key = (v) => v.t + ':' + oneLine(v.x, 80);
  const have = new Set(voice.map(key));
  let added = 0;
  for (const e of emails || []) {
    const x = String((e && e.text) || '').replace(/\r\n/g, '\n').trim().slice(0, VOICE_TEXT);
    if (x.length < 40) continue;
    const item = { t: String(e.threadId || ''), d: DAY_RE.test(String(e.date || '')) ? e.date : '',
      to: [...new Set((String(e.to || '').match(ADDRESSES_IN) || []).map((a) => a.toLowerCase()))].slice(0, 20),
      s: oneLine(e.subject, SUBJECT_MAX), x };
    if (acct) item.a = acct;
    if (have.has(key(item))) continue;
    have.add(key(item));
    voice.push(item);
    added += 1;
  }
  if (!added) return 0;
  let kept = voice;
  if (voice.length > VOICE_MAX) {
    const keep = new Set(voice.map((v, i) => ({ v, i })).sort((a, b) => String(b.v.d).localeCompare(String(a.v.d)) || b.i - a.i)
      .slice(0, VOICE_MAX).map((x) => x.v));
    kept = voice.filter((v) => keep.has(v));
  }
  await save({ voice: kept });
  return added;
}

export async function clearVoice() {
  await save({ voice: [] });
}

// ── Backup ──────────────────────────────────────────────────────────────
/** JSON backup. The AI key (and a key inside the address, ?code=...) only goes along if the person asks for it. */
export async function exportBackup({ includeKey = false } = {}) {
  const state = await load();
  const settings = { ...state.settings };
  if (!includeKey) {
    settings.apiKey = '';
    settings.baseUrl = String(settings.baseUrl || '').split('?')[0];
  }
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings,
    profile: state.profile,
    memory: state.memory,
    style: state.style,
    identity: state.identity,
    notes: state.notes,
    chats: state.chats,
    autoDraft: state.autoDraft,
  };
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const THREAD_RE = /^[0-9a-f]{12,20}$/i;

function cleanProfile(p) {
  const out = {};
  if (!isObj(p)) return out;
  for (const k of Object.keys(DEFAULTS.profile)) if (typeof p[k] === 'string') out[k] = p[k].slice(0, 4000);
  return out;
}

function cleanStyle(s) {
  if (!isObj(s)) return null;
  const examples = (Array.isArray(s.examples) ? s.examples : []).filter((x) => typeof x === 'string' && x.trim());
  return {
    summary: str(s.summary, 900),
    examples: examples.slice(0, 3).map((x) => x.slice(0, 600)),
    learnedAt: DAY_RE.test(s.learnedAt) ? s.learnedAt : '',
    emails: Number.isFinite(Number(s.emails)) ? Math.max(0, Math.floor(Number(s.emails))) : 0,
  };
}

function cleanSettings(s) {
  if (!isObj(s) || !PROVIDER_IDS.includes(s.provider)) return null;
  const out = { provider: s.provider, apiKey: str(s.apiKey, 400).trim(), model: str(s.model, 200).trim(),
    baseUrl: str(s.baseUrl, 500).trim(), preset: str(s.preset, 40) };
  return out;
}

function cleanThreads(map, key, max) {
  const out = {};
  if (!isObj(map)) return out;
  for (const [id, v] of Object.entries(map)) {
    if (!THREAD_RE.test(id) || !isObj(v) || !Array.isArray(v[key])) continue;
    const items = v[key].filter(isObj).map((x) => (key === 'items'
      ? { date: str(x.date, 10), kind: str(x.kind, 20) || 'change', text: str(x.text, 600) }
      : { date: str(x.date, 10), q: str(x.q, 1000), a: str(x.a, CHAT_ANSWER_MAX) }))
      .filter((x) => (key === 'items' ? x.text : x.q || x.a));
    if (!items.length) continue;
    out[id] = { at: str(v.at, 40), [key]: items.slice(key === 'items' ? -NOTES_PER_THREAD : -CHAT_TURNS) };
    if (key === 'items' && typeof v.subject === 'string') out[id].subject = oneLine(v.subject, SUBJECT_MAX);
  }
  return trimThreads(out, max);
}

/**
 * Imports a backup.
 *   'merge' (Memory tab): adds to the memory; profile and style only fill what is empty.
 *           Someone else's file never brings their own email addresses.
 *   'restore' (new computer): the backup becomes all of Burnout (profile, memory, style,
 *           notes, chats and your addresses).
 * The file's AI only comes in when no AI is connected here, and even then it waits for Test
 * and save (connected() is false until then). Auto-draft never comes from a file.
 * Every field is checked: a hand-edited file doesn't break the replies. Backups saved
 * before the rename import the same way.
 * Returns { added, restored }: memories that came in and whether the AI came along.
 */
export async function importBackup(data, { mode = 'merge' } = {}) {
  const plan = await planImport(data, mode);
  await save(plan.out);
  return { added: plan.added, restored: !!plan.ai };
}

/**
 * What importing the file would change, without saving anything, so the screen can ask first:
 * { added, scoped (memories only for one person), profile (fields that change), ai (or null),
 *   addresses (new ones that would count as yours: only a restore brings them) }.
 */
export async function previewBackup(data, { mode = 'merge' } = {}) {
  const { added, scoped, profile, ai, addresses } = await planImport(data, mode);
  return { added, scoped, profile, ai, addresses };
}

async function planImport(data, mode) {
  if (!isObj(data) || data.kind !== BACKUP_KIND) throw new Error('not_a_backup');
  const restore = mode === 'restore';
  const cur = await load();
  const out = {};
  const profile = cleanProfile(data.profile);
  if (!restore) delete profile.emails; // the addresses of whoever made the file are not yours
  out.profile = restore ? { ...DEFAULTS.profile, ...profile } : { ...profile, ...nonEmpty(cur.profile) };
  const changed = Object.keys(DEFAULTS.profile).filter((k) => String(out.profile[k] || '').trim() && out.profile[k] !== cur.profile[k]);
  const style = cleanStyle(data.style);
  if (style && (restore || !cur.style.summary)) out.style = style;

  const incoming = (Array.isArray(data.memory) ? data.memory : []).filter((m) => isObj(m) && typeof m.text === 'string' && m.text.trim());
  const memory = restore ? [] : cur.memory.slice();
  const have = new Set(memory.map((x) => norm(x.text) + '|' + (x.contact || '')));
  let added = 0;
  let scoped = 0;
  for (const m of incoming) {
    const contact = scopeOf(m.contact);
    const key = norm(m.text) + '|' + contact;
    if (have.has(key)) continue;
    have.add(key);
    const item = { id: newId(), text: oneLine(m.text, 400), date: DAY_RE.test(m.date) && m.date <= localDate() ? m.date : '', source: m.source === 'learned' ? 'learned' : 'manual' };
    if (contact) {
      item.contact = contact;
      scoped += 1;
    }
    memory.push(item);
    added += 1;
  }
  const manual = memory.filter((m) => m.source !== 'learned').slice(-MEMORY_MAX.manual);
  out.memory = trimLearned([...manual, ...memory.filter((m) => m.source === 'learned')]);

  if (restore) {
    const aliases = isObj(data.identity) && Array.isArray(data.identity.aliases) ? data.identity.aliases : [];
    out.identity = { aliases: [...new Set(aliases.filter((e) => EMAIL_RE.test(String(e))).map((e) => String(e).toLowerCase()))].slice(0, ALIASES_MAX) };
    out.notes = cleanThreads(data.notes, 'items', NOTE_THREADS_KEPT);
    out.chats = cleanThreads(data.chats, 'turns', CHAT_THREADS_KEPT);
  }
  const settings = cleanSettings(data.settings);
  let ai = null;
  if (settings && hasAi(settings) && !connected(cur.settings)) {
    out.settings = { ...cur.settings, ...settings, unconfirmed: true };
    ai = { provider: settings.provider, preset: settings.preset, baseUrl: settings.baseUrl.split('?')[0], key: !!settings.apiKey };
  }
  if (restore && isReady({ settings: out.settings || cur.settings, profile: out.profile })) out.onboarded = true;
  const before = new Set(ownAddresses(cur));
  const addresses = restore ? ownAddresses({ profile: out.profile, identity: out.identity }).filter((e) => !before.has(e)) : [];
  return { out, added, scoped, profile: changed, ai, addresses };
}

function nonEmpty(obj) {
  const o = {};
  for (const [k, v] of Object.entries(obj || {})) if (String(v || '').trim()) o[k] = v;
  return o;
}

export async function wipe() {
  await area().clear();
}
