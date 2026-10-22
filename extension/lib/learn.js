// Learn from the emails the user HAS ALREADY SENT: how they write and the
// recurring facts about their work (what they offer, prices, how the process
// works). This becomes "learned memory" and "writing style".
//
// Only the messages the user wrote go to their AI (with date, recipient and
// subject); the other side of the thread is left out. The AI is told to skip
// passwords, cards, ID documents and health, and to keep a client's price or
// terms for that client only. Everything stays in the browser and shows up on
// the memory screen, where anything that isn't useful can be deleted.
//
// Progress is saved batch by batch: closing the panel midway doesn't lose what was
// already learned, and only threads that went through the AI get marked as read.

import { complete } from './ai.js';
import { mineSet, parsePrintView } from './gmail_parse.js';
import { learnSystem, learnUser, mergeStyleSystem } from './prompts.js';
import { addAliases, addMemory, bumpUsage, load, markSeen, save } from './store.js';
import { localDate, oneLine } from './text.js';

export const LEARN_BATCH = 12;
export const LEARN_DEFAULT = 60;
const MIN_CHARS = 40;
const SECRET_RE = /\b(?:senha|password|passcode|pin|cvv|cvc|ssn|cpf|rg|passport|passaporte)\b|\b(?:\d[ -]?){13,19}\b/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reads the JSON the AI returns, even with text or a code fence around it. */
export function parseLearnJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (e) {
    return null;
  }
}

// A plain-text reply quotes the other person under "On <date>, <name> wrote:" and with "> " lines.
// That part is theirs, so it stays out of Learn (Gmail's own quote blocks are already gone).
const QUOTE_HEAD_RE = /^\s*(?:On\b.{4,200}\bwrote:|Em\b.{4,200}\bescreveu:|El\b.{4,200}\bescribió:|-{2,}\s*Original Message\s*-{2,}|-{2,}\s*Mensagem original\s*-{2,})\s*$/i;

export function ownPart(text) {
  const lines = String(text || '').split('\n');
  const cut = lines.findIndex((l) => QUOTE_HEAD_RE.test(l));
  return (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !/^\s*>/.test(l)).join('\n').trim();
}

/** The messages the user wrote in a thread (me = their address or a list of their addresses). */
export function ownMessages(thread, me) {
  const mine = mineSet(me instanceof Set ? [...me] : me);
  if (!mine.size && thread.account) mine.add(String(thread.account).toLowerCase());
  if (!mine.size) return [];
  return (thread.messages || [])
    .filter((m) => mine.has(m.fromEmail))
    .map((m) => ({ date: m.date, to: m.to, subject: thread.subject, text: ownPart(m.text).slice(0, 1500) }))
    .filter((e) => e.text.length >= MIN_CHARS);
}

const firstName = (s) => String(s || '').trim().toLowerCase().split(/\s+/)[0] || '';

/**
 * The "Send mail as" addresses (contact@shop.com sending through the ana@gmail.com account).
 * Every thread in the Sent folder has the user as a sender: a thread where none of their
 * known addresses wrote was written by an alias. The alias is the sender that shows up
 * in almost all of those threads and signs with the user's name.
 */
export function detectAliases(threads, me, ownerName = '') {
  const known = mineSet(me);
  const names = new Set();
  if (firstName(ownerName)) names.add(firstName(ownerName));
  for (const th of threads) for (const m of th.messages || []) if (known.has(m.fromEmail) && firstName(m.fromName)) names.add(firstName(m.fromName));
  const found = [];
  for (let round = 0; round < 3; round++) {
    const uncovered = threads.filter((th) => !(th.messages || []).some((m) => known.has(m.fromEmail)));
    if (uncovered.length < 2) break;
    const count = new Map();
    const nameOf = new Map();
    for (const th of uncovered) {
      for (const m of th.messages || []) if (m.fromEmail && m.fromName && !nameOf.has(m.fromEmail)) nameOf.set(m.fromEmail, firstName(m.fromName));
      for (const s of new Set((th.messages || []).map((m) => m.fromEmail).filter(Boolean))) count.set(s, (count.get(s) || 0) + 1);
    }
    const ranked = [...count].filter(([addr]) => !known.has(addr)).sort((a, b) => b[1] - a[1]);
    const need = Math.ceil(uncovered.length * 0.8);
    const pick = names.size
      ? ranked.find(([addr, n]) => n >= need && names.has(nameOf.get(addr)))
      : ranked[0] && ranked[0][1] >= need && (!ranked[1] || ranked[1][1] < ranked[0][1]) ? ranked[0] : null; // no name to check against: only a clear leader
    if (!pick) break;
    known.add(pick[0]);
    found.push(pick[0]);
  }
  return found;
}

function validDate(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : localDate();
}

/**
 * ids: threads from the Sent folder (legacy Gmail id, 16 hex).
 * fetchThread(id) -> print page HTML.
 * me: the user's addresses (the account and the aliases already known).
 * onProgress({stage, done, total}) so the UI can show progress.
 * Pauses: between threads (so we don't hammer Gmail) and between batches
 * (Gemini's free tier allows about 10 requests per minute). AI limit hit: wait
 * and try once more; if that fails, stop and keep what was already learned.
 * Returns { threads, emails, facts, style, error, stopped, truncated, unreadable, aliases }:
 *   emails = emails the AI actually read; error = AI error code when it stopped midway;
 *   stopped = the user clicked Stop; truncated = batches the AI cut off at the limit;
 *   unreadable = emails whose answer wasn't the JSON asked for, even on a second try (they
 *   stay unmarked, so the next Learn reads them again).
 */
export async function learnFromThreads({ cfg, ids, fetchThread, me = [], onProgress = () => {}, isCancelled = () => false,
  fetchImpl, readDelayMs = 250, batchDelayMs = 4000, quotaWaitMs = 20000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const state = await load(['learn', 'style', 'profile']);
  const seen = new Set(state.learn.seen);
  const todo = ids.filter((id) => !seen.has(id));
  const read = [];
  for (let i = 0; i < todo.length; i++) {
    if (isCancelled()) break;
    onProgress({ stage: 'read', done: i, total: todo.length });
    try {
      read.push({ id: todo[i], thread: parsePrintView(await fetchThread(todo[i])) });
    } catch (e) {
      // a thread that didn't open is left for next time
    }
    if (i < todo.length - 1) await sleep(readDelayMs);
  }
  onProgress({ stage: 'read', done: todo.length, total: todo.length });

  const mine = mineSet(me);
  const aliases = detectAliases(read.map((r) => r.thread), [...mine], state.profile.name);
  for (const a of aliases) mine.add(a);
  if (aliases.length) await addAliases(aliases);

  // the user's emails, remembering which thread each one came from
  const emails = [];
  const left = new Map(); // thread -> its emails not yet read by the AI
  const empty = [];
  for (const { id, thread } of read) {
    const own = ownMessages(thread, [...mine]);
    if (!own.length) {
      empty.push(id);
      continue;
    }
    left.set(id, own.length);
    for (const e of own) emails.push({ ...e, threadId: id });
  }

  const styles = [];
  const examples = [];
  let facts = 0;
  let done = 0;
  let truncated = 0;
  let unreadable = 0;
  let stopped = null;
  let cancelled = isCancelled();
  let summary = state.style.summary || '';
  const batches = [];
  for (let i = 0; i < emails.length; i += LEARN_BATCH) batches.push(emails.slice(i, i + LEARN_BATCH));
  for (let b = 0; b < batches.length; b++) {
    if (isCancelled()) {
      cancelled = true;
      break;
    }
    onProgress({ stage: 'think', done: b, total: batches.length });
    const ask = () => complete(cfg, { system: learnSystem(), user: learnUser(batches[b]), maxTokens: 3000, timeoutMs: 120000, purpose: 'learn', fetchImpl });
    let r;
    try {
      r = await ask();
    } catch (e) {
      if (e && e.code === 'quota') {
        await sleep(quotaWaitMs);
        try {
          r = await ask();
        } catch (e2) {
          stopped = e2;
        }
      } else {
        stopped = e;
      }
    }
    if (stopped) break;
    await bumpUsage(r.usage);
    let out = parseLearnJson(r.text);
    if (!out && !r.truncated) {
      // an answer that isn't the JSON asked for (small local models slip now and then): ask once more
      try {
        r = await ask();
        await bumpUsage(r.usage);
        out = parseLearnJson(r.text);
      } catch (e) {
        r = { text: '', truncated: false };
      }
    }
    if (!out && !r.truncated) {
      // still unreadable: nothing learned here, and its threads stay unmarked for the next Learn
      unreadable += batches[b].length;
      if (b < batches.length - 1) await sleep(batchDelayMs);
      continue;
    }
    if (!out && r.truncated) truncated += 1;
    if (out) {
      if (typeof out.style === 'string' && out.style.trim()) styles.push(out.style.trim());
      for (const f of Array.isArray(out.facts) ? out.facts.slice(0, 15) : []) {
        const text = oneLine(f && f.text, 300);
        if (!text || SECRET_RE.test(text)) continue;
        const contact = String((f && f.contact) || '').trim().toLowerCase();
        const saved = await addMemory(text, { source: 'learned', date: validDate(f.date), contact: EMAIL_RE.test(contact) && !mine.has(contact) ? contact : '' });
        if (saved && saved.id) facts += 1;
      }
      for (const ex of Array.isArray(out.examples) ? out.examples.slice(0, 2) : []) {
        if (typeof ex === 'string' && ex.trim().length >= MIN_CHARS && !SECRET_RE.test(ex)) examples.push(ex.trim().slice(0, 600));
      }
    }
    // batch read: the threads that finished here get marked, and the 1st batch's style applies right away
    done += batches[b].length;
    const finished = [];
    for (const e of batches[b]) {
      const n = left.get(e.threadId) - 1;
      left.set(e.threadId, n);
      if (n === 0) finished.push(e.threadId);
    }
    await markSeen(finished);
    if (!summary && styles.length) {
      summary = styles[0];
      await save({ style: { ...state.style, summary: summary.slice(0, 900), examples: [...examples, ...(state.style.examples || [])].slice(0, 3), learnedAt: localDate() } });
    }
    if (b < batches.length - 1) await sleep(batchDelayMs);
  }
  onProgress({ stage: 'think', done: batches.length, total: batches.length });

  if (styles.length > 1 || (styles.length === 1 && state.style.summary)) {
    try {
      const r = await complete(cfg, {
        system: mergeStyleSystem(),
        user: [state.style.summary, ...styles].filter(Boolean).map((s, i) => `${i + 1}. ${s}`).join('\n'),
        maxTokens: 600,
        timeoutMs: 120000,
        purpose: 'learn',
        fetchImpl,
      });
      await bumpUsage(r.usage);
      summary = r.text.trim();
    } catch (e) {
      summary = summary || styles[0]; // merging is a nice-to-have: without it, the first style stays
    }
  }
  const style = {
    summary: String(summary || '').slice(0, 900),
    examples: [...examples, ...(state.style.examples || [])].slice(0, 3),
    learnedAt: localDate(),
    emails: (state.style.emails || 0) + done,
  };
  if (styles.length) await save({ style });
  // thread with no email from the user: nothing to learn. Only mark it when the identity looks right
  // (we found their emails), otherwise a wrong address would make everything vanish next time.
  if (emails.length) await markSeen(empty);
  const learnState = (await load(['learn'])).learn;
  await save({ learn: { ...learnState, lastRun: new Date().toISOString(), lastCount: done } });
  return { threads: read.length, emails: done, facts, style, error: stopped ? stopped.code || 'down' : '', stopped: cancelled, truncated, unreadable, aliases };
}
