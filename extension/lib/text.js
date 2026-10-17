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

export function cleanClientText(text, max = 8000) {
  let t = String(text || '').replace(/\r\n/g, '\n').trim();
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
