// Learn from the emails the user HAS ALREADY SENT: how they write and the
// recurring facts about their work (what they offer, prices, how the process
// works). This becomes "learned memory" and "writing style". Their emails
// themselves are kept in the browser too (their part only), so each reply can
// use the ones closest to the open email as the model: to the same person, or
// about the same thing.
//
// Only the messages the user wrote go to their AI (with date, recipient and
// subject); the other side of the thread is left out. The AI is told to skip
// passwords, cards, ID documents and health, and to keep a client's price or
// terms for that client only. Everything stays in the browser and shows up on
// the memory screen, where anything that isn't useful can be deleted.
//
// It goes 60 conversations at a time: closing the panel midway doesn't lose what
// was already learned, and the conversations not finished wait for the next Learn.

import { complete } from './ai.js';
import { mineSet, parsePrintView } from './gmail_parse.js';
import { learnSystem, learnUser, mergeStyleSystem } from './prompts.js';
import { addAliases, addMemories, addVoice, bumpUsage, load, markSeen, save, saveLearnBytes } from './store.js';
import { dayToDate, localDate, oneLine, parseMailDate } from './text.js';

export const LEARN_BATCH = 20; // emails per request to the AI (Gemini, ChatGPT, Claude)
const LEARN_BATCH_OTHER = 12; // Other AI / Company AI: often a local model with a small context
export const LEARN_CHUNK = 60; // conversations read before they go to the AI
export const LEARN_DEFAULT = 1000;
export const LEARN_ALL = 20000; // "All": the whole Sent folder of almost anyone
const FACTS_PER_BATCH = 20;
const STYLES_KEPT = 16; // descriptions of the style merged into one at the end
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

// A plain-text reply quotes the other person under "On <date>, <name> wrote:" and with "> " lines,
// and a forward carries someone else's email under "---------- Forwarded message ---------".
// That part is theirs, so it stays out of Learn (Gmail's own quote blocks are already gone).
const QUOTE_HEAD_RE = /^\s*(?:On\b.{4,200}\bwrote:|Em\b.{4,200}\bescreveu:|El\b.{4,200}\bescribió:|-{2,}\s*Original Message\s*-{2,}|-{2,}\s*Mensagem original\s*-{2,}|-{5,}\s*(?:Forwarded message|Mensagem encaminhada|Mensaje reenviado|Message transféré|Weitergeleitete Nachricht)\s*-*)\s*$/i;

// Outlook-style quote: a "From:" line with "Sent:" (or "Date:") right under it.
const FROM_LINE_RE = /^\s*\*?(?:From|De|Von|Da|Van)\s*:\*?\s+\S/i;
const SENT_LINE_RE = /^\s*\*?(?:Sent|Date|Enviado|Enviada|Data|Fecha|Gesendet|Datum|Inviato|Envoyé)\s*:/i;

export function ownPart(text) {
  const lines = String(text || '').split('\n');
  let cut = lines.findIndex((l) => QUOTE_HEAD_RE.test(l));
  const outlook = lines.findIndex((l, i) => FROM_LINE_RE.test(l) && lines.slice(i + 1, i + 4).some((n) => SENT_LINE_RE.test(n)));
  if (outlook >= 0 && (cut < 0 || outlook < cut)) cut = outlook;
  return (cut >= 0 ? lines.slice(0, cut) : lines).filter((l) => !/^\s*>/.test(l)).join('\n').trim();
}

/**
 * The messages the user wrote in a thread (me = their address or a list of their addresses).
 * date = 'YYYY-MM-DD' from the message (fallback: the day the Sent folder showed it); rawDate =
 * the date as Gmail wrote it.
 */
export function ownMessages(thread, me, fallbackDate = '') {
  const mine = mineSet(me instanceof Set ? [...me] : me);
  if (!mine.size && thread.account) mine.add(String(thread.account).toLowerCase());
  if (!mine.size) return [];
  return (thread.messages || [])
    .filter((m) => mine.has(m.fromEmail))
    .map((m) => ({ date: parseMailDate(m.date) || fallbackDate, rawDate: m.date, to: m.to, subject: thread.subject, text: ownPart(m.text).slice(0, 1500) }))
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
    if (uncovered.length < 3) break;
    const count = new Map();
    const nameOf = new Map();
    for (const th of uncovered) {
      for (const m of th.messages || []) if (m.fromEmail && m.fromName && !nameOf.has(m.fromEmail)) nameOf.set(m.fromEmail, firstName(m.fromName));
      for (const s of new Set((th.messages || []).map((m) => m.fromEmail).filter(Boolean))) count.set(s, (count.get(s) || 0) + 1);
    }
    const ranked = [...count].filter(([addr]) => !known.has(addr)).sort((a, b) => b[1] - a[1]);
    const need = Math.ceil(uncovered.length * 0.8);
    let pick = null;
    if (names.size) {
      // two addresses with the owner's name in the same threads (a client using that name, say): no guessing
      const fits = ranked.filter(([addr, n]) => n >= need && names.has(nameOf.get(addr)));
      if (fits.length && (fits.length === 1 || fits[0][1] > fits[1][1])) pick = fits[0];
    } else if (ranked[0] && ranked[0][1] >= need && (!ranked[1] || ranked[1][1] < ranked[0][1])) {
      pick = ranked[0]; // no name to check against: only a clear leader
    }
    if (!pick) break;
    known.add(pick[0]);
    found.push(pick[0]);
  }
  return found;
}

// A fact's date must be a plausible day: not before Gmail existed, not in the future (a fact dated
// 9999 would never leave the memory). Otherwise it takes the newest date of the emails it came from.
function factDate(d, fallback) {
  const today = localDate();
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && d >= '2004-01-01' && d <= today) return d;
  return fallback && fallback <= today ? fallback : today;
}

// Card numbers and "password: ..." in the owner's own emails don't stay in the browser
// ("pin the label" stays: only "PIN: 1234" or "my password is ..." lose the value).
export function scrubSecrets(text) {
  return String(text || '')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '(number removed)')
    .replace(/\b(senha|password|passcode|pin|cvv|cvc|ssn|cpf|passport|passaporte)\b(\s*[:=]\s*|\s+(?:is|é|e)\s+)[^\s,;]+/gi, '$1$2(removed)');
}

/** [id] or [[id, day]] -> [{ id, day }] (day = days since 1970 when the Sent folder showed it, 0 when unknown). */
function normIds(ids) {
  const out = [];
  const have = new Set();
  for (const x of ids || []) {
    const id = Array.isArray(x) ? x[0] : x;
    if (typeof id !== 'string' || have.has(id)) continue;
    have.add(id);
    out.push({ id, day: Array.isArray(x) && Number.isFinite(Number(x[1])) ? Number(x[1]) : 0 });
  }
  return out;
}

/** Spread picks: n items across the whole list, not only its start. */
function spread(list, n) {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]);
}

/**
 * Which conversations to learn: the ones still waiting from last time, what was sent since the
 * last Learn, then further back from where the last one stopped, until there are `want`.
 * list(opts) asks Gmail (content.js) for a stretch of the Sent folder:
 *   { max, to, from } -> { ids, days, lo, end, cancelled, moved }.
 * today = days since 1970. Returns { queue: [[id, day]] newest first, range, stopped }.
 */
export async function collectSent({ list, want, today, learnState }) {
  const seen = new Set((learnState && learnState.seen) || []);
  const queue = new Map();
  for (const p of (learnState && learnState.pending) || []) if (Array.isArray(p) && !seen.has(p[0])) queue.set(p[0], Number(p[1]) || 0);
  const top = today + 2; // past "today" in every time zone
  const prev = learnState && learnState.range && Number.isFinite(learnState.range.hi) && Number.isFinite(learnState.range.lo) ? learnState.range : null;
  let range = prev;
  let stopped = null;
  const take = (r) => {
    for (const id of (r && r.ids) || []) if (!seen.has(id) && !queue.has(id)) queue.set(id, Number(r.days && r.days[id]) || 0);
  };
  if (prev) {
    // 1. what was sent since the last Learn (with one day of overlap, for time zones)
    const r = await list({ max: want, to: top, from: Math.max(0, prev.hi - 1) });
    take(r);
    if (!r || r.cancelled || r.moved) stopped = r || { cancelled: true };
    // reached what the last Learn covered: one stretch again. Otherwise it starts over from here
    // (what was already learned stays out on its own: it's in "seen")
    range = r && r.end ? { hi: top, lo: prev.lo, end: prev.end } : { hi: top, lo: Number.isFinite(r && r.lo) ? r.lo : top, end: false };
  }
  if (!stopped && queue.size < want && !(range && range.end)) {
    // 2. further back, from where the stretch ends
    const to = range ? range.lo : top;
    const r = await list({ max: want - queue.size, to });
    take(r);
    if (!r || r.cancelled || r.moved) stopped = r || { cancelled: true };
    range = { hi: range ? range.hi : top, lo: Math.min(Number.isFinite(r && r.lo) ? r.lo : to, to), end: !!(r && r.end) };
    // the very first listing found nothing at all: maybe Gmail didn't run the search. Nothing is
    // taken as gone through, so the next Learn tries the whole folder again
    if (!prev && !(r && r.ids && r.ids.length)) range = null;
  }
  return { queue: [...queue].sort((a, b) => b[1] - a[1]), range, stopped };
}

// Gmail limits what its web pages can download: 750 MB an hour and 1,250 MB a day (Google's
// "Gmail bandwidth limits"), counting the person's own Gmail use. Learn takes at most 200 MB an
// hour (it waits) and 600 MB a day (it stops for the day), counted across Learns.
export const HOUR_BYTES = 200 * 1024 * 1024;
export const DAY_BYTES = 600 * 1024 * 1024;
const HOUR_MS = 3600000;

function usedSince(budget, ms) {
  const since = Date.now() - ms;
  let n = 0;
  for (const x of budget.events) if (x.t >= since) n += x.n;
  return n;
}

async function readAll(items, { fetchThread, concurrency, delayMs, sleep, isCancelled, budget }) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !isCancelled() && !budget.full) {
      if (usedSince(budget, 24 * HOUR_MS) > DAY_BYTES) {
        budget.full = true;
        break;
      }
      // over the hour's share: wait (about an hour at most) until older downloads age out
      for (let w = 0; w < 130 && usedSince(budget, HOUR_MS) > HOUR_BYTES && !isCancelled(); w++) await sleep(30000);
      const i = next++;
      try {
        const html = await fetchThread(items[i].id);
        budget.events.push({ t: Date.now(), n: String(html || '').length });
        out[i] = { ...items[i], thread: parsePrintView(html) };
      } catch (e) {
        // a conversation that didn't open waits for next time
      }
      if (delayMs) await sleep(delayMs);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return out.filter(Boolean);
}

/**
 * ids: conversations from the Sent folder (legacy Gmail id, 16 hex), or [id, day] pairs.
 * fetchThread(id) -> print page HTML.
 * me: the user's addresses (the account and the aliases already known).
 * onProgress({ stage: 'learn', done, total }) in conversations, so the screen can show it.
 * Pauses: between conversations read (so we don't hammer Gmail) and between requests to the AI
 * (Gemini's free plan allows about 10 a minute). AI limit hit: wait longer each time and try
 * again, up to quotaRetries times; then stop and keep what was already learned.
 * Returns { threads, emails, facts, voice, style, error, stopped, truncated, unreadable, aliases }:
 *   emails = emails the AI actually read; voice = emails kept to write like the owner;
 *   error = AI error code when it stopped midway; stopped = the user clicked Stop;
 *   truncated = requests the AI cut off at its limit; unreadable = emails whose answer wasn't
 *   the JSON asked for, even on a second try (their conversations stay for the next Learn).
 */
export async function learnFromThreads({ cfg, ids, fetchThread, me = [], account = '', onProgress = () => {}, isCancelled = () => false,
  fetchImpl, readDelayMs = 300, readConcurrency = 2, chunkSize = LEARN_CHUNK, batchDelayMs, quotaWaitMs = 30000, quotaRetries = 3,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const pause = Number.isFinite(batchDelayMs) ? batchDelayMs : cfg && cfg.provider === 'gemini' ? 4000 : 500;
  const size = cfg && ['compatible', 'custom'].includes(cfg.provider) ? LEARN_BATCH_OTHER : LEARN_BATCH;
  const state = await load(['learn', 'style', 'profile']);
  const seen = new Set(state.learn.seen);
  const todo = normIds(ids).filter((x) => !seen.has(x.id));
  const mine = mineSet(me);
  const out = { threads: 0, emails: 0, facts: 0, voice: 0, truncated: 0, unreadable: 0, aliases: [] };
  const styles = [];
  const examples = [];
  let summary = state.style.summary || '';
  let stopped = null;
  let cancelled = isCancelled();
  let done = 0;
  // what earlier Learns downloaded in the last 24 hours ([hour, bytes]), plus what this one downloads
  const budget = { events: (Array.isArray(state.learn.bytes) ? state.learn.bytes : []).map(([t, n]) => ({ t: Number(t) || 0, n: Number(n) || 0 })), full: false };
  const pool = []; // conversations sent from an address not known yet (a "Send mail as" one, most likely)
  onProgress({ stage: 'learn', done: 0, total: todo.length });

  const ask = (batch) => complete(cfg, { system: learnSystem(), user: learnUser(batch), maxTokens: 4000, timeoutMs: 120000, purpose: 'learn', fetchImpl });
  const askPatiently = async (batch) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return { r: await ask(batch) };
      } catch (e) {
        if (!(e && e.code === 'quota') || attempt >= quotaRetries) return { error: e };
        await sleep(quotaWaitMs * (attempt + 1));
      }
    }
  };

  for (let c = 0; c < todo.length && !stopped && !cancelled; c += chunkSize) {
    const chunk = todo.slice(c, c + chunkSize);
    const read = await readAll(chunk, { fetchThread, concurrency: readConcurrency, delayMs: readDelayMs, sleep, isCancelled, budget });
    await saveLearnBytes(budget.events);
    if (isCancelled()) {
      cancelled = true;
      break;
    }
    out.threads += read.length;
    done += chunk.length - read.length; // didn't open: counted as done for the bar, left for next time

    // whose emails these are: "Send mail as" addresses show up here, across everything read so far
    const byOwner = (th) => (th.messages || []).some((m) => mine.has(m.fromEmail));
    for (const r of read) {
      if (!byOwner(r.thread)) pool.push({ messages: (r.thread.messages || []).map((m) => ({ fromEmail: m.fromEmail, fromName: m.fromName })) });
    }
    if (pool.length > 300) pool.splice(0, pool.length - 300);
    const fresh = detectAliases(pool, [...mine], state.profile.name).filter((a) => !mine.has(a));
    for (const a of fresh) mine.add(a);
    if (fresh.length) {
      await addAliases(fresh);
      out.aliases.push(...fresh);
      for (let i = pool.length - 1; i >= 0; i--) if (byOwner(pool[i])) pool.splice(i, 1);
    }

    // the owner's emails, remembering which conversation each one came from
    const emails = [];
    const left = new Map(); // conversation -> its emails not yet read by the AI
    const empty = []; // the owner wrote here, but nothing long enough to learn from: done
    for (const { id, day, thread } of read) {
      // nobody known wrote here (an address not recognized yet): it waits for the next Learn
      if (!byOwner(thread)) {
        done += 1;
        continue;
      }
      const own = ownMessages(thread, [...mine], day ? dayToDate(day) : '');
      if (!own.length) {
        empty.push(id);
        continue;
      }
      left.set(id, own.length);
      for (const e of own) emails.push({ ...e, threadId: id });
    }
    if (isCancelled()) {
      cancelled = true;
      break;
    }
    // kept as they are, to write like the owner (no AI needed for this part), minus anything secret
    out.voice += await addVoice(emails.map((e) => ({ ...e, text: scrubSecrets(e.text) })), { account });

    for (let b = 0; b < emails.length; b += size) {
      if (isCancelled()) {
        cancelled = true;
        break;
      }
      const batch = emails.slice(b, b + size);
      const first = await askPatiently(batch);
      // stopped (or everything deleted) while the AI answered: nothing more is written
      if (isCancelled()) {
        cancelled = true;
        break;
      }
      if (first.error) {
        stopped = first.error;
        break;
      }
      let r = first.r;
      await bumpUsage(r.usage);
      let parsed = parseLearnJson(r.text);
      if (!parsed && !r.truncated) {
        // an answer that isn't the JSON asked for (small local models slip now and then): ask once more
        try {
          r = await ask(batch);
          await bumpUsage(r.usage);
          parsed = parseLearnJson(r.text);
        } catch (e) {
          r = { text: '', truncated: false };
        }
      }
      if (!parsed && !r.truncated) {
        // still unreadable: nothing learned here, and its conversations stay for the next Learn
        out.unreadable += batch.length;
        if (b + size < emails.length) await sleep(pause);
        continue;
      }
      if (!parsed && r.truncated) out.truncated += 1;
      if (parsed) {
        if (typeof parsed.style === 'string' && parsed.style.trim()) styles.push(parsed.style.trim());
        const facts = [];
        const newest = batch.reduce((d, e) => (e.date > d ? e.date : d), '');
        for (const f of Array.isArray(parsed.facts) ? parsed.facts.slice(0, FACTS_PER_BATCH) : []) {
          const text = oneLine(f && f.text, 300);
          if (!text || SECRET_RE.test(text)) continue;
          const contact = String((f && f.contact) || '').trim().toLowerCase();
          facts.push({ text, date: factDate(f.date, newest), contact: EMAIL_RE.test(contact) && !mine.has(contact) ? contact : '' });
        }
        out.facts += await addMemories(facts);
        for (const ex of Array.isArray(parsed.examples) ? parsed.examples.slice(0, 2) : []) {
          if (typeof ex === 'string' && ex.trim().length >= MIN_CHARS && !SECRET_RE.test(ex)) examples.push(ex.trim().slice(0, 600));
        }
      }
      // batch read: the conversations that finished here get marked, and the 1st style applies right away
      out.emails += batch.length;
      const finished = [];
      for (const e of batch) {
        const n = left.get(e.threadId) - 1;
        left.set(e.threadId, n);
        if (n === 0) finished.push(e.threadId);
      }
      await markSeen(finished);
      done += finished.length;
      onProgress({ stage: 'learn', done, total: todo.length });
      if (!summary && styles.length) {
        summary = styles[0];
        await save({ style: { ...state.style, summary: summary.slice(0, 900), examples: [...examples, ...(state.style.examples || [])].slice(0, 3), learnedAt: localDate() } });
      }
      if (b + size < emails.length) await sleep(pause);
    }
    if (!stopped && !cancelled) {
      await markSeen(empty);
      done += empty.length;
    }
    onProgress({ stage: 'learn', done, total: todo.length });
    if (budget.full && !stopped && !cancelled) {
      stopped = { code: 'gmail_daily' }; // what was read is learned; the rest waits for tomorrow
      break;
    }
    if (!stopped && !cancelled && c + chunkSize < todo.length && emails.length) await sleep(pause);
  }

  // stopped, or everything was deleted meanwhile: what was learned is already saved, nothing else is written
  if (cancelled) return { ...out, style: (await load(['style'])).style, error: '', stopped: true };
  const kept = spread(styles, STYLES_KEPT);
  if (kept.length > 1 || (kept.length === 1 && state.style.summary)) {
    try {
      const r = await complete(cfg, {
        system: mergeStyleSystem(),
        user: [state.style.summary, ...kept].filter(Boolean).map((s, i) => `${i + 1}. ${s}`).join('\n'),
        maxTokens: 600,
        timeoutMs: 120000,
        purpose: 'learn',
        fetchImpl,
      });
      await bumpUsage(r.usage);
      summary = r.text.trim();
    } catch (e) {
      summary = summary || kept[0]; // merging is a nice-to-have: without it, the first style stays
    }
  }
  const style = {
    summary: String(summary || '').slice(0, 900),
    examples: [...examples, ...(state.style.examples || [])].slice(0, 3),
    learnedAt: localDate(),
    emails: (state.style.emails || 0) + out.emails,
  };
  if (styles.length) await save({ style });
  const learnState = (await load(['learn'])).learn;
  await save({ learn: { ...learnState, lastRun: new Date().toISOString(), lastCount: out.emails } });
  return { ...out, style, error: stopped ? stopped.code || 'down' : '', stopped: cancelled };
}
