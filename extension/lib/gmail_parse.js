// Reads Gmail's print page (?view=pt) and returns the thread as text.
//
// Why the print page: it has the WHOLE thread (including messages collapsed on
// screen) in plain HTML, with one <table class="message"> per message. Tested on
// real Gmail on Oct 17, 2026.
//
// No DOMParser on purpose: Gmail uses Trusted Types and this code also runs in
// Node tests. It's a small tag reader that only needs to understand this page.

import { stripInvisible } from './text.js';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
const EMAIL_RE = /[A-Za-z0-9._%+\-']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', euro: '€', pound: '£' };

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') {
      const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
  });
}

/** Removes the blocks (with everything inside) whose opening tag passes the test. Respects nesting. */
export function removeBlocks(html, test) {
  let out = '';
  let last = 0;
  let skip = null;
  let depth = 0;
  const re = new RegExp(TAG_RE.source, 'g');
  let m;
  while ((m = re.exec(html))) {
    const name = m[1].toLowerCase();
    const closing = m[0][1] === '/';
    const selfClosing = VOID.has(name) || /\/\s*>$/.test(m[0]);
    if (skip === null) {
      if (!closing && test(name, m[2] || '')) {
        out += html.slice(last, m.index) + '\n'; // a removed block becomes a line break
        if (selfClosing) {
          last = re.lastIndex;
        } else {
          skip = name;
          depth = 1;
        }
      }
    } else if (name === skip && !selfClosing) {
      depth += closing ? -1 : 1;
      if (depth === 0) {
        skip = null;
        last = re.lastIndex;
      }
    }
  }
  if (skip === null) out += html.slice(last);
  return out;
}

const hasClass = (attrs, cls) => new RegExp(`class\\s*=\\s*["']?[^"'>]*\\b${cls}\\b`, 'i').test(attrs);

// Hidden text in the email: someone reading in Gmail can't see it, so the AI doesn't read it
// either. It's the usual way to hide instructions for an AI in an email. Best effort: it reads
// each tag's own style (and the hidden attribute), not the email's <style> rules, which Gmail
// mostly drops anyway.
function styleOf(attrs) {
  const m = /(?:^|\s)style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').toLowerCase() : '';
}

/** The value of one CSS property in a style attribute (the last one wins, like in CSS). */
function cssValue(style, prop) {
  let v = null;
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i > 0 && decl.slice(0, i).trim() === prop) v = decl.slice(i + 1).replace(/!\s*important/g, '').trim();
  }
  return v;
}

const isZero = (v) => v != null && /^[-+]?0*\.?0+(?:[a-z]{1,4}|%)?$/.test(v);
const number = (v) => (v == null ? NaN : parseFloat(v));

// smaller than 2px is unreadable: 0, 1px, 0.5px, 1pt, 0.1em
function tinyFont(v) {
  const m = /^(\d*\.?\d+)\s*(px|pt|em|rem|%)?$/.exec(v || '');
  if (!m) return false;
  const n = parseFloat(m[1]);
  const px = { pt: (4 / 3) * n, em: 16 * n, rem: 16 * n, '%': 0.16 * n }[m[2]] ?? n;
  return px < 2;
}

function seeThrough(v) {
  if (v == null) return false;
  if (v.endsWith('%')) return parseFloat(v) < 10;
  return number(v) < 0.1;
}

// transparent text, or white text with no background of its own (white on the white page)
function invisibleColor(color, style) {
  if (color == null) return false;
  if (/^transparent$|^rgba\([^)]*,\s*0*\.?0+\s*\)$|^#[0-9a-f]{3}0$|^#[0-9a-f]{6}00$/.test(color)) return true;
  const white = /^(?:#fff|#ffffff|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))$/.test(color);
  return white && cssValue(style, 'background') == null && cssValue(style, 'background-color') == null;
}

/** The tag hides its content from someone reading the email. */
export function hidesText(attrs) {
  const a = String(attrs || '');
  if (/(?:^|\s)hidden(?=\s|=|\/|$)/i.test(a.replace(/"[^"]*"|'[^']*'/g, '""'))) return true; // <div hidden>
  const s = styleOf(a);
  if (!s) return false;
  const v = (p) => cssValue(s, p);
  if (v('display') === 'none' || /^(?:hidden|collapse)$/.test(v('visibility') || '') || v('mso-hide') === 'all') return true;
  if (seeThrough(v('opacity')) || tinyFont(v('font-size')) || invisibleColor(v('color'), s)) return true;
  if (isZero(v('max-height')) || isZero(v('max-width'))) return true;
  if ((isZero(v('height')) || isZero(v('width')) || isZero(v('line-height'))) && /hidden|clip/.test(v('overflow') || '')) return true;
  if (number(v('text-indent')) <= -999) return true;
  if (/^(?:absolute|fixed)$/.test(v('position') || '') && ['left', 'top', 'right'].some((p) => number(v(p)) <= -999)) return true;
  return /rect\(\s*0/.test(v('clip') || '') || /inset\(\s*(?:50|100)%/.test(v('clip-path') || '');
}

/** Email HTML -> text. dropQuotes removes quoted replies (gmail_quote, blockquote). */
export function htmlToText(html, { dropQuotes = true } = {}) {
  let h = String(html || '');
  h = h.replace(/<!--[\s\S]*?-->/g, '');
  // real Gmail doesn't close the <head> (checked Oct 17): for a full page, start at <body>
  const bodyAt = h.search(/<body\b/i);
  if (bodyAt > 0) h = h.slice(bodyAt);
  h = h.replace(/<(script|style|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  h = removeBlocks(h, (name, attrs) => hidesText(attrs));
  if (dropQuotes) {
    // Outlook puts only the "From: / Sent:" header of the email it answers in div#divRplyFwdMsg (after an
    // empty div#appendonsend), and the quoted email after it, outside any quote block: from there on it's theirs
    const outlook = h.search(/<div\b[^>]*\bid\s*=\s*["']?[\w-]*?(?:divRplyFwdMsg|appendonsend)\b/i);
    if (outlook >= 0) h = h.slice(0, outlook);
    h = removeBlocks(h, (name, attrs) =>
      name === 'blockquote' ||
      (name === 'div' && (hasClass(attrs, 'gmail_quote') || hasClass(attrs, 'gmail_extra') ||
        /id\s*=\s*["']?(?:divRplyFwdMsg|appendonsend)/i.test(attrs))));
  }
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<li\b[^>]*>/gi, '\n- ');
  h = h.replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol|blockquote)>/gi, '\n');
  h = h.replace(/<(p|div|tr|table|h[1-6])\b[^>]*>/gi, '\n');
  h = h.replace(/<\/t[dh]>/gi, ' ');
  h = h.replace(TAG_RE, '');
  let t = stripInvisible(decodeEntities(h)).replace(/ /g, ' ').replace(/\r/g, '');
  t = t.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function firstMatch(re, s) {
  const m = re.exec(s);
  return m ? m : null;
}

function emailsIn(text) {
  return [...new Set((String(text || '').match(EMAIL_RE) || []).map((e) => e.toLowerCase()))];
}

/**
 * Print page -> { account, subject, messages: [{fromName, fromEmail, date, to, cc, text}] }.
 * account = email of the account that printed it (page header).
 */
export function parsePrintView(html) {
  const page = String(html || '');
  const mainAt = page.search(/class\s*=\s*["']?maincontent/i);
  const header = mainAt > 0 ? page.slice(0, mainAt) : '';
  const account = emailsIn(htmlToText(header, { dropQuotes: false }))[0] || '';
  // One <table class="message"> per message, all at the same level. A table with that
  // name INSIDE an email's text sits deeper: it doesn't count as a message (otherwise
  // the sender could forge a message "from the owner" that would go into Learn).
  const found = [];
  const tableRe = /<(\/?)table\b([^>]*)>/gi;
  let depth = 0;
  let m;
  while ((m = tableRe.exec(page))) {
    if (m[1]) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (hasClass(m[2] || '', 'message')) found.push({ at: m.index, depth });
    depth += 1;
  }
  const top = found.length ? Math.min(...found.map((f) => f.depth)) : 0;
  const starts = found.filter((f) => f.depth === top).map((f) => f.at);
  const before = mainAt >= 0 ? page.slice(mainAt, starts.length ? starts[0] : undefined) : '';
  const subjectM = firstMatch(/<b\b[^>]*>([\s\S]*?)<\/b>/i, before);
  const subject = subjectM ? htmlToText(subjectM[1], { dropQuotes: false }).replace(/\s+/g, ' ').trim() : '';
  const messages = starts.map((at, i) => parseMessage(page.slice(at, i + 1 < starts.length ? starts[i + 1] : undefined)));
  return { account, subject, messages: messages.filter((x) => x.text || x.fromEmail) };
}

function parseMessage(chunk) {
  const nameM = firstMatch(/<b\b[^>]*>([\s\S]*?)<\/b>([\s\S]*?)<\/font>/i, chunk);
  const fromName = nameM ? htmlToText(nameM[1], { dropQuotes: false }).replace(/\s+/g, ' ').trim() : '';
  const fromEmail = nameM ? (emailsIn(decodeEntities(nameM[2]))[0] || emailsIn(fromName)[0] || '') : '';
  // on real Gmail the date cell has no </td>: it runs until the next <tr>
  const dateM = firstMatch(/<td\b[^>]*align\s*=\s*["']?right["']?[^>]*>([\s\S]*?)(?:<\/td>|<tr\b|<\/tr>|<\/table>)/i, chunk);
  const date = dateM ? htmlToText(dateM[1], { dropQuotes: false }).replace(/\s+/g, ' ').trim() : '';
  const recM = firstMatch(/<font\b[^>]*class\s*=\s*["']?recipient[^>]*>([\s\S]*?)<\/font>/i, chunk);
  let to = '';
  let cc = '';
  let bodyFrom = 0;
  if (recM) {
    const lines = htmlToText(recM[1], { dropQuotes: false }).split('\n').filter(Boolean);
    to = emailsIn(lines[0] || '').join(', ');
    cc = emailsIn(lines.slice(1).join(' ')).join(', ');
    bodyFrom = recM.index + recM[0].length;
  } else if (dateM) {
    bodyFrom = dateM.index + dateM[0].length;
  }
  const text = htmlToText(chunk.slice(bodyFrom));
  return { fromName, fromEmail, date, to, cc, text };
}

/** The thread as the model reads it: oldest to newest, capped per message and in total. */
export function threadText(thread, { maxPerMessage = 2500, maxTotal = 11500, lastN = 6 } = {}) {
  const msgs = (thread && thread.messages) || [];
  const parts = msgs.slice(-lastN).map((m) => {
    const who = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail || '?';
    const body = m.text.length > maxPerMessage ? m.text.slice(0, maxPerMessage) + '\n[...]' : m.text;
    return `FROM ${who}${m.date ? ' (' + m.date + ')' : ''}:\n${body}`;
  });
  let out = parts.join('\n---\n');
  if (out.length > maxTotal) out = '[...]\n' + out.slice(-maxTotal);
  return out;
}

/** The user's own addresses: the account and its "Send mail as" aliases. */
export function mineSet(me) {
  return new Set([].concat(me || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean));
}

/** Who the thread is with: the last person who wrote and isn't the user. */
export function partyOf(thread, me) {
  const mine = mineSet(me);
  const msgs = (thread && thread.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.fromEmail && !mine.has(m.fromEmail)) return { name: m.fromName || '', email: m.fromEmail };
  }
  const last = msgs[msgs.length - 1];
  const to = last ? emailsIn(last.to).find((e) => !mine.has(e)) || '' : '';
  return { name: '', email: to };
}

/** Anyone else in the thread besides me and the other party? (turns into "reply all") */
export function othersIn(thread, me, party) {
  const mine = mineSet(me);
  const last = ((thread && thread.messages) || []).slice(-1)[0];
  if (!last) return [];
  const all = emailsIn([last.fromEmail, last.to, last.cc].join(' '));
  return all.filter((e) => !mine.has(e) && e !== (party && party.email));
}

/** Is the last message in the thread from the user? (then the reply is a follow-up, not an answer) */
export function ownerWroteLast(thread, me) {
  const mine = mineSet(me);
  const last = ((thread && thread.messages) || []).slice(-1)[0];
  return !!(last && last.fromEmail && mine.has(last.fromEmail));
}
