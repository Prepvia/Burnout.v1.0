// A fake Gmail to run content.js in Node (vm module), with no browser.
// It only has what content.js uses: simple selectors (tag.class[attribute="v"]),
// visibility, click, focus, selection, execCommand('insertText'), location.hash
// with a "router" that swaps the visible list, and a virtual clock (content.js's
// sleeps move the clock instead of really waiting).

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONTENT_SRC = fs.readFileSync(path.join(HERE, '..', 'extension', 'content.js'), 'utf8');
const LOCALE = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'extension', '_locales', 'en', 'messages.json'), 'utf8'));

function parseSelector(sel) {
  const m = sel.trim().match(/^([a-zA-Z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/);
  if (!m) throw new Error('selector outside the mini engine: ' + sel);
  const attrs = [...(m[3] || '').matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((a) => [a[1], a[2]]);
  return { tag: (m[1] || '').toUpperCase(), classes: (m[2] || '').split('.').filter(Boolean), attrs };
}

export class El {
  constructor(tag, attrs = {}, { visible = true, text = '' } = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.visible = visible;
    this.children = [];
    this.parentElement = null;
    this.textContent = text;
    this.listeners = {};
    this.clicks = 0;
    this.onclick = null;
  }
  get innerText() { return this.textContent; }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  get title() { return this.attrs.title || ''; }
  set title(v) { this.attrs.title = v; }
  get type() { return this.attrs.type || ''; }
  set type(v) { this.attrs.type = v; }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getClientRects() { return this.visible && (!this.parentElement || this.parentElement.getClientRects().length) ? [1] : []; }
  append(...kids) { for (const k of kids) { k.parentElement = this; this.children.push(k); } return this; }
  prepend(...kids) { for (const k of kids) k.parentElement = this; this.children.unshift(...kids); return this; }
  remove() {
    const p = this.parentElement;
    if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parentElement = null;
  }
  closest(sel) {
    for (let el = this; el; el = el.parentElement) if (el.matches(sel)) return el;
    return null;
  }
  insertAdjacentElement(where, el) {
    const p = this.parentElement;
    el.parentElement = p;
    p.children.splice(p.children.indexOf(this) + 1, 0, el);
    return el;
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatchEvent(ev) { for (const fn of this.listeners[ev.type] || []) fn(ev); return true; }
  click() {
    this.clicks += 1;
    if (this.onclick) this.onclick();
    for (const fn of this.listeners.click || []) fn({ preventDefault() {}, stopPropagation() {} });
  }
  focus() { this.doc.active = this; }
  matches(sel) {
    const s = parseSelector(sel);
    if (s.tag && s.tag !== this.tagName) return false;
    const cls = this.className.split(/\s+/);
    if (!s.classes.every((c) => cls.includes(c))) return false;
    return s.attrs.every(([k, v]) => (v === undefined ? this.getAttribute(k) !== null : this.getAttribute(k) === v));
  }
  descendants() {
    const out = [];
    for (const c of this.children) out.push(c, ...c.descendants());
    return out;
  }
  querySelectorAll(sel) { return this.descendants().filter((e) => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

export function makeGmail({ title = 'Inbox (3) - alice@acme-ceramics.com - Gmail', account = 0, lists = {}, printPages = {}, staleChip = false } = {}) {
  const clock = { now: 1_800_000_000_000 };
  const doc = { active: null, inserted: [], lang: 'en' };
  const body = new El('body');
  const main = new El('div', { role: 'main' });
  body.append(main, new El('script', {}, { text: 'var GLOBALS=[null,null,1,"x",2,"y",3,4,5,"abc123def0",6];' }));
  if (staleChip) main.append(new El('button', { class: 'jm-chip' }, { text: 'Reply with Burnout (old copy)' }));
  const world = {
    clock, doc, body, main, fetches: [], messagesOut: [], hashLog: [], intervals: [], listeners: [],
    hash: '#inbox', listNodes: {}, thread: null,
  };

  // lists: { '#sent': ['id1', 'id2'], '#sent/p2': [...], '#inbox': [...] } — one table per folder
  for (const [hash, ids] of Object.entries(lists)) {
    const table = new El('table', { class: 'F cf zt' }, { visible: false });
    for (const id of ids) {
      const row = new El('tr', { class: 'zA yO' });
      row.append(new El('span', { 'data-thread-id': '#thread-f:1' + id, 'data-legacy-thread-id': id }));
      table.append(row);
    }
    main.append(table);
    world.listNodes[hash] = table;
  }

  function route(hash) {
    world.hash = hash;
    world.hashLog.push(hash);
    for (const [h, node] of Object.entries(world.listNodes)) node.visible = h === hash;
    if (world.thread) world.thread.visible = false;
    if (world.onRoute) world.onRoute(hash);
  }
  route('#inbox');

  world.openThread = (id, { replyAll = false, subject = 'Re: 40 mugs', messages = [] } = {}) => {
    for (const node of Object.values(world.listNodes)) node.visible = false;
    const view = new El('div', { class: 'nH' });
    const head = new El('div', { class: 'ha' });
    const h2 = new El('h2', { class: 'hP', 'data-legacy-thread-id': id, 'data-thread-perm-id': 'thread-f:9' }, { text: subject });
    head.append(h2);
    for (const m of messages) {   // messages open on screen (content.js's fallback reads from here)
      const box = new El('div', { class: 'adn ads' }, { visible: m.visible !== false });
      box.append(new El('span', { class: 'gD', email: m.email, name: m.name }, { text: m.name }),
        new El('span', { class: 'g3', title: m.date }, { text: m.date }),
        new El('div', { class: 'a3s' }, { text: m.text }));
      view.append(box);
    }
    const reply = new El('span', { class: 'ams bkH' });
    view.append(head, reply);
    if (replyAll) view.append(new El('span', { class: 'ams bkI' }));
    const box = new El('div', { contenteditable: 'true', role: 'textbox', class: 'Am Al editable' }, { visible: true });
    box.doc = doc;
    const area = new El('div', { class: 'M9' }, { visible: false });
    area.append(box);
    reply.onclick = () => { area.visible = true; world.opened = 'reply'; };
    const all = view.querySelector('span.ams.bkI');
    if (all) all.onclick = () => { area.visible = true; world.opened = 'replyAll'; };
    view.append(area);
    main.append(view);
    world.thread = view;
    world.box = box;
    world.h2 = h2;
    return view;
  };

  const document = {
    title,
    documentElement: { lang: doc.lang },
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelector(sel),
    createElement: (tag) => { const e = new El(tag); e.doc = doc; return e; },
    createRange: () => ({ setStart(node) { this.node = node; }, collapse() {} }),
    execCommand: (cmd, ui, value) => {
      if (cmd !== 'insertText' || !doc.active || world.execFails) return false;
      doc.inserted.push({ box: doc.active, text: value });
      doc.active.textContent = value + doc.active.textContent;
      return true;
    },
  };
  const location = {
    pathname: `/mail/u/${account}/`,
    get hash() { return world.hash; },
    set hash(v) { route(v.startsWith('#') ? v : '#' + v); },
    replace(url) { world.replaced = (world.replaced || 0) + 1; route(String(url).slice(String(url).indexOf('#'))); },
  };
  // the button text comes from the extension's own English locale, as in Chrome
  const MESSAGES = Object.fromEntries(Object.entries(LOCALE).map(([k, v]) => [k, v.message]));
  const chrome = {
    runtime: {
      id: 'burnout-test',
      onMessage: { addListener: (fn) => world.listeners.push(fn) },
      sendMessage: (msg) => { world.messagesOut.push(JSON.parse(JSON.stringify(msg))); return Promise.resolve(); },
    },
    i18n: { getMessage: (k) => MESSAGES[k] || '' },
  };
  // extension updated: the old copy loses chrome.runtime.id
  world.kill = () => { chrome.runtime.id = undefined; };
  // the person clicks somewhere else in Gmail while the Sent folder is being listed
  world.onRoute = null;
  const sandbox = {
    window: { addEventListener() {}, getSelection: () => ({ toString: () => world.selection || '', removeAllRanges() {}, addRange() {} }) },
    document,
    location,
    chrome,
    console,
    Event: class { constructor(type, o) { this.type = type; this.bubbles = !!(o && o.bubbles); } },
    Date: { now: () => clock.now },
    Promise,
    AbortController,
    // the fetch timeout (15 s) doesn't move the clock: only the sleeps do
    setTimeout: (fn, ms) => { if (ms < 10000) clock.now += ms || 0; return ms >= 10000 ? 0 : setImmediate(fn); },
    clearTimeout: () => {},
    setInterval: (fn) => { world.intervals.push(fn); return world.intervals.length; },
    clearInterval: () => { world.stopped = true; },
    encodeURIComponent,
    fetch: async (url, opts) => {
      world.fetches.push({ url, opts });
      const id = (url.match(/[?&]th=([0-9a-f]+)/) || [])[1];
      const page = printPages[id];
      if (!page) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => page };
    },
  };
  sandbox.window.__burnoutLoaded = false;
  vm.createContext(sandbox);
  vm.runInContext(CONTENT_SRC, sandbox, { filename: 'content.js' });

  // cloned reply: an object created inside the vm has a different Object.prototype
  world.ask = (msg) => new Promise((resolve) => {
    const done = (v) => resolve(v === undefined ? v : JSON.parse(JSON.stringify(v)));
    const handled = world.listeners.some((fn) => fn(msg, {}, done) === true);
    if (!handled) resolve(undefined);
  });
  world.tick = () => world.intervals.forEach((fn) => fn());
  world.sandbox = sandbox;
  world.route = route;
  return world;
}
