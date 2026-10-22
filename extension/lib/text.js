// Text that goes to the other side of the email, and text helpers.
//
// The email goes out without an AI look: no dashes, no markdown, no [placeholder].
// A money amount nobody gave (not the email, the profile, the memory or the
// instruction) becomes a warning for the person to check before sending. Burnout never
// sends on its own: the person sends, in Gmail.

const DASH = '[\\u2012-\\u2015]'; // figure dash, en dash, em dash, horizontal bar
const PH = '\\[\\s*(?:[^\\]\\n]{0,24}\\b)?(?:name|nome|nombre|company|empresa|date|data|fecha|link|phone|' +
  'telefone|tel[eé]fono|title|cargo|signature|assinatura|firma|insert|inserir|your|seu|sua|tu)\\b[^\\]\\n]{0,24}\\]';
export const PLACEHOLDER_RE = new RegExp(PH, 'i');

export function clip(text, n) {
  const s = text == null ? '' : String(text);
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

export function oneLine(text, n = 300) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

// Characters nobody can see: "tag" letters, zero-width spaces, word joiners and direction
// overrides. They're a known way to hide text from a person and still have an AI read it, or
// to slip data out inside a reply. The joiners that some scripts and emoji need (ZWJ, ZWNJ, LRM,
// RLM) stay, unless several come in a row, which no language needs.
const INVISIBLE_RUN_RE = /[᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]{2,}/g;
const INVISIBLE_RE = /[᠎​‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/gu;

export function stripInvisible(text) {
  return String(text || '').replace(INVISIBLE_RUN_RE, '').replace(INVISIBLE_RE, '');
}

export function cleanClientText(text, max = 8000) {
  let t = stripInvisible(String(text || '').replace(/\r\n/g, '\n')).trim();
  if (t.startsWith('```')) t = t.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  if (t.length > 1 && t[0] === '"' && t[t.length - 1] === '"') t = t.slice(1, -1).trim();
  t = t.replace(new RegExp('^[ \\t]*' + DASH + '[ \\t]*', 'gm'), '');          // dash opening a line
  t = t.replace(new RegExp('(?<=\\d)[ \\t]*' + DASH + '[ \\t]*(?=\\d)', 'g'), '-'); // range: 3-5
  t = t.replace(new RegExp('(?<=[\\p{L}\\p{N}])' + DASH + '(?=[\\p{L}\\p{N}])', 'gu'), '-'); // glued: Mon-Fri, 9am-5pm
  t = t.replace(new RegExp('[ \\t]*' + DASH + '[ \\t]*', 'g'), ', ');           // the rest becomes a comma
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2');                                    // bold
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');                                  // heading
  t = t.replace(/^[ \t]*[*•][ \t]+/gm, '- ');                             // bullet
  t = t.replace(new RegExp('^[ \\t]*' + PH + '[ \\t]*,?[ \\t]*$\\n?', 'gmi'), ''); // a line that is only a placeholder
  t = t.replace(new RegExp(PH, 'gi'), '');
  t = t.replace(/[ \t]+([,.!?;:])/g, '$1');
  t = t.replace(/[ \t]{2,}/g, ' ');
  t = t.replace(/[ \t]+$/gm, ''); // spaces at the end of a line ("Best, " breaks the signature)
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim().slice(0, max);
}

// ── Ready reply inside a conversation with Burnout ──────────────────────
const READY_START = /^[ \t*_#>]*(?:READY REPLY|RESPOSTA PRONTA|RESPUESTA LISTA)[ \t*_]*:?[ \t*_]*$/gim;
const READY_END = /^[ \t*_#>]*(?:END OF REPLY|FIM DA RESPOSTA|FIN DE LA RESPUESTA)[ \t*_.:]*$/im;
const SUBJECT_LINE = /^[ \t*_]*(?:subject|assunto|asunto)[ \t*_]*:[^\n]*\n/i;

// A greeting that opens an email, in the languages people write to the owner in.
const GREETING = /^[ \t]*(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|ol[áa]|oi|prezad[oa]s?|bom dia|boa tarde|hola|estimad[oa]s?|buenos d[íi]as)(?=[\s,!.]|$)[^\n]{0,60}$/gim;

/**
 * The email inside an answer from Ask: between READY REPLY and END OF REPLY. Small local models
 * sometimes skip the markers and just write the email: then, when the answer has a greeting line
 * followed later by the owner's sign-off (signature = the profile's), the email is that block.
 * '' when there is no email in the answer.
 */
export function readyText(answer, signature = '') {
  const a = String(answer || '').replace(/\r\n/g, '\n');
  let last = null;
  for (const m of a.matchAll(READY_START)) last = m;
  if (!last) return unmarkedEmail(a, signature);
  const rest = a.slice(last.index + last[0].length);
  const end = rest.match(READY_END);
  let body = (end ? rest.slice(0, end.index) : rest).trim();
  while (body.startsWith('---') || body.endsWith('---')) body = body.replace(/^-+|-+$/g, '').trim();
  body = body.replace(SUBJECT_LINE, '').trim();
  if (body.length > 1 && '"“'.includes(body[0]) && '"”'.includes(body[body.length - 1])) body = body.slice(1, -1).trim();
  return body.length >= 20 ? body : '';
}

function unmarkedEmail(a, signature) {
  const sign = String(signature || '').trim().split('\n')[0].trim();
  if (!sign) return '';
  const end = a.lastIndexOf(sign);
  if (end < 0) return '';
  let start = -1;
  for (const m of a.slice(0, end).matchAll(GREETING)) start = m.index;
  if (start < 0) return '';
  const body = a.slice(start).trim();
  return body.length >= 20 ? body : '';
}

export function stripReadyMarkers(answer) {
  return String(answer || '').replace(READY_START, '').replace(new RegExp(READY_END.source, 'gim'), '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** A robot sender nobody answers (no-reply@, notifications@, mailer-daemon@...): auto-draft leaves those emails alone. */
export function isAutomatedSender(email) {
  const local = String(email || '').trim().toLowerCase().split('@')[0];
  return /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify|newsletters?|alerts?)(?:$|[-_.+])/.test(local);
}

// ── Money amounts nobody gave ───────────────────────────────────────────
const MONEY_RE = /(?:US|R|C|A)?\$\s?(\d[\d.,]*)|€\s?(\d[\d.,]*)|£\s?(\d[\d.,]*)|(?<![\w.,])(\d[\d.,]*)\s?(?:usd|eur|brl|dollars?|d[oó]lares|euros?|reais|cents?|centavos)\b/gi;
const NUMBER_RE = /(?<![\w.,])\d[\d.,]*/g;

export function normNumber(raw) {
  let s = String(raw || '').trim().replace(/[.,]+$/, '');
  if (!s) return '';
  if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else if (/^[1-9]\d{0,2}(?:\.\d{3})+(?:,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const v = Number(s);
  if (!Number.isFinite(v)) return '';
  return String(Math.round(v * 1e6) / 1e6);
}

function moneyFigures(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(MONEY_RE)) {
    const n = normNumber(m[1] || m[2] || m[3] || m[4] || '');
    if (n) out.add(n);
  }
  return out;
}

/** true when the text has a money amount that appears in none of the sources. */
export function hasUnknownMoney(text, ...sources) {
  const known = new Set();
  for (const src of sources) {
    for (const m of String(src || '').matchAll(NUMBER_RE)) {
      const n = normNumber(m[0]);
      if (n) known.add(n);
    }
  }
  for (const n of moneyFigures(text)) if (!known.has(n)) return true;
  return false;
}

// ── Keywords (the memory most related to the open email) ────────────────
const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'your', 'will', 'would', 'there', 'their', 'about',
  'which', 'what', 'when', 'where', 'been', 'were', 'they', 'them', 'then', 'than', 'also', 'just', 'here', 'more',
  'para', 'como', 'mais', 'isso', 'esse', 'essa', 'este', 'esta', 'voce', 'pelo', 'pela', 'seus', 'suas', 'muito',
  'quando', 'onde', 'qual', 'sobre', 'ainda', 'depois', 'antes', 'tudo', 'todo', 'toda', 'porque', 'pode', 'podemos',
  'obrigado', 'obrigada', 'thanks', 'thank', 'regards', 'best', 'abraco', 'atenciosamente', 'please', 'favor']);

/** Words of 4+ letters (accents removed, very common ones skipped) and numbers: what ties a fact to an email. */
export function keywords(text) {
  const out = new Set();
  const plain = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const w of plain.match(/[a-z0-9]{4,}|\d{2,}/g) || []) if (!STOP.has(w)) out.add(w);
  return out;
}

// ── Who an address belongs to ───────────────────────────────────────────
const PUBLIC_DOMAIN_RE = /^(?:gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|pm|gmx|web|uol|bol|terra|ig|globo|yandex|mail|zoho|hey|fastmail|qq|163|126|naver|libero|orange|free|laposte|t-online|comcast|att|verizon|sbcglobal|cox|charter|earthlink|bellsouth|optonline|btinternet|shaw|rogers|bigpond)\./;
// relays: one address per buyer or guest, all under the marketplace's own domain
const RELAY_DOMAIN_RE = /(?:^|\.)(?:marketplace\.amazon\.[a-z.]+|members\.ebay\.[a-z.]+|guest\.booking\.com|privaterelay\.appleid\.com|reply\.craigslist\.org|relay\.firefox\.com|duck\.com|simplelogin\.[a-z.]+|anonaddy\.[a-z.]+)$|\.edu$/;

export function domainOf(email) {
  const at = String(email || '').trim().toLowerCase().lastIndexOf('@');
  return at < 0 ? '' : String(email).trim().toLowerCase().slice(at + 1);
}

/**
 * A webmail (gmail.com, outlook.com...), a relay (marketplace.amazon.com, guest.booking.com...) or a
 * school: sharing it says nothing about being the same company.
 */
export function isPublicDomain(domain) {
  const d = String(domain || '').toLowerCase();
  return !d || PUBLIC_DOMAIN_RE.test(d) || RELAY_DOMAIN_RE.test(d);
}

// ── Dates the way Gmail writes them, in the account's language ──────────
const MONTHS = { janv: 1, jan: 1, ene: 1, gen: 1, fevr: 2, fev: 2, feb: 2, mars: 3, mar: 3, avr: 4, apr: 4, abr: 4,
  mai: 5, may: 5, mag: 5, juin: 6, jun: 6, giu: 6, juil: 7, jul: 7, lug: 7, aout: 8, aug: 8, ago: 8,
  sept: 9, sep: 9, set: 9, oct: 10, out: 10, okt: 10, ott: 10, nov: 11, dec: 12, dez: 12, dic: 12 };
const pad2 = (n) => String(n).padStart(2, '0');
const validYmd = (y, m, d) => (y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad2(m)}-${pad2(d)}` : '');

/**
 * The date of a message as the print page shows it ('Thu, Oct 16, 2026 at 10:12 AM',
 * 'qui., 16 de out. de 2026 às 10:12', '16 oct 2026, 10:12') -> '2026-10-16'. '' when it can't
 * tell for sure (no year, or 03/04/2026, which reads two ways).
 */
export function parseMailDate(text) {
  const plain = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let m = plain.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  const tokens = plain.match(/[a-z]+|\d+/g) || [];
  const yi = tokens.findIndex((tk) => /^(?:19|20)\d{2}$/.test(tk));
  if (yi < 0) return '';
  const monthOf = (tk) => (/^[a-z]{3,}$/.test(tk) ? MONTHS[tk.slice(0, 4)] || MONTHS[tk.slice(0, 3)] || 0 : 0);
  // the month nearest the year ("mar" is also Tuesday in Spanish: "mar, 16 oct 2026")
  let mi = -1;
  tokens.forEach((tk, i) => { if (monthOf(tk) && (mi < 0 || Math.abs(i - yi) < Math.abs(mi - yi))) mi = i; });
  if (mi < 0) {
    m = plain.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
    if (!m) return '';
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    if (a > 12) return validYmd(y, b, a);
    if (b > 12) return validYmd(y, a, b);
    return '';
  }
  for (const dist of [1, 2]) {
    for (const j of [mi - dist, mi + dist]) {
      const tk = tokens[j];
      if (j !== yi && tk && /^\d{1,2}$/.test(tk)) return validYmd(+tokens[yi], monthOf(tokens[mi]), +tk);
    }
  }
  return '';
}

/** Days since 1970-01-01 (UTC) -> 'YYYY-MM-DD'. */
export function dayToDate(day) {
  if (!Number.isFinite(Number(day))) return '';
  return new Date(Math.floor(Number(day)) * 86400000).toISOString().slice(0, 10);
}

/** The user's paste shortcut: Cmd+V on a Mac, Ctrl+V elsewhere. */
export function pasteKeys() {
  const nav = globalThis.navigator || {};
  const plat = String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || '');
  return /mac/i.test(plat) ? 'Cmd+V' : 'Ctrl+V';
}

// ── Dates in the user's time zone ───────────────────────────────────────
export function timeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
}

export function localDate(now = new Date(), tz = timeZone()) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function localMonth(now = new Date(), tz = timeZone()) {
  return localDate(now, tz).slice(0, 7);
}

export function todayLine(now = new Date(), tz = timeZone()) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
  return `TODAY: ${localDate(now, tz)} (${weekday}), time zone ${tz}`;
}
