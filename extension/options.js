// Burnout's settings: the first time it's a 3-screen walkthrough (your AI, your business,
// done); after that it becomes tabs (AI, your business, memory, privacy). Made for people
// who have never seen an API key: paste the key and Burnout recognizes which AI it is.
// Whoever has a company AI enters its address (contract in docs/CONNECT_AI.md).

import { AIError, PRESETS, PROVIDERS, checkBaseUrl, defaultModel, detectKey, listModels, originFor, shortName, testKey } from './lib/ai.js';
import { h, toast } from './lib/dom.js';
import { errText, t } from './lib/i18n.js';
import { icon } from './lib/icons.js';
import * as store from './lib/store.js';

const app = document.getElementById('app');
let S = null;
let tab = 'ai';
let step = 1;
let focusedStep = 0; // walkthrough step that already got the cursor (once only: after that it never steals it)
let busy = ''; // 'test' | 'models'
let note = null; // { kind, text } of the current screen
let draft = null; // the AI being set up
let shortcut = '';
let voiceCount = 0; // the owner's emails kept to write like them (loaded apart: only the count is shown)
let memQuery = ''; // the Memory tab's search
let memAll = false; // "Show all" clicked
const MEM_SHOWN = 100;

const STEPS = { gemini: 'stepsGemini', openai: 'stepsOpenai', anthropic: 'stepsAnthropic' };
const NOTES = { gemini: 'noteGemini', openai: 'noteOpenai', anthropic: 'noteAnthropic' };
const TILES = [
  { id: 'gemini', name: () => 'Google Gemini', sub: 'tileGemini', free: true },
  { id: 'openai', name: () => 'ChatGPT (OpenAI)', sub: 'tileOpenai' },
  { id: 'anthropic', name: () => 'Claude (Anthropic)', sub: 'tileAnthropic' },
  { id: 'compatible', name: () => t('provCompatible'), sub: 'tileCompatible' },
  { id: 'custom', name: () => t('provCustom'), sub: 'tileCustom' },
];

const presetById = (id) => PRESETS.find((p) => p.id === id) || PRESETS[PRESETS.length - 1];
const presetLabel = (p) => (p.id === 'other' ? t('presetOther') : p.local ? t('presetLocal', { name: p.label }) : p.label);
const spin = (label) => h('span', { class: 'busy' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), label || null);
const noteBox = (kind, ic, text) => h('div', { class: 'note ' + kind }, icon(ic, 14), h('span', null, text));

function providerName(id, preset) {
  if (id === 'compatible') return preset ? presetLabel(presetById(preset)) : t('provCompatible');
  if (id === 'custom') return t('provCustom');
  const tile = TILES.find((x) => x.id === id);
  return tile ? tile.name() : id;
}

async function load() {
  S = await store.load();
  voiceCount = (await store.loadVoice()).length;
  document.title = t('appName');
  if (!draft) draft = draftFrom(S.settings);
}

function draftFrom(s) {
  const p = PROVIDERS[s.provider] || PROVIDERS.gemini;
  const known = p.models.some((m) => m.id === s.model);
  const d = { provider: p.id, apiKey: s.apiKey || '', model: p.needsUrl || known ? s.model || '' : '',
    custom: !p.needsUrl && !known ? s.model || '' : '', baseUrl: p.needsUrl ? s.baseUrl || '' : '',
    preset: s.preset || (p.id === 'compatible' ? 'openrouter' : ''), show: false, models: [], detected: null };
  if (p.id === 'compatible' && !d.baseUrl) d.baseUrl = presetById(d.preset).url;
  return d;
}

function setNote(kind, text) {
  note = { kind, text };
  render();
}

// ── 1. The AI ───────────────────────────────────────────────────────────
function pickProvider(id, { silent = false } = {}) {
  if (draft.provider === id) return;
  const saved = S.settings;
  draft.provider = id;
  draft.model = '';
  draft.custom = ''; // a model typed for one AI doesn't apply to another
  draft.models = [];
  note = null;
  // a key that clearly belongs to another AI doesn't go to this one (a Gemini key never goes to the company server)
  const d = detectKey(draft.apiKey);
  if (d && !d.weak && d.provider !== id) draft.apiKey = '';
  if (!draft.apiKey && saved.provider === id) draft.apiKey = saved.apiKey || '';
  draft.detected = null;
  if (id === 'compatible') {
    draft.preset = saved.provider === 'compatible' && saved.preset ? saved.preset : draft.preset || 'openrouter';
    draft.baseUrl = saved.provider === 'compatible' ? saved.baseUrl : presetById(draft.preset).url;
    draft.model = saved.provider === 'compatible' ? saved.model : presetById(draft.preset).model || '';
  } else if (id === 'custom') {
    draft.baseUrl = saved.provider === 'custom' ? saved.baseUrl : '';
    draft.model = saved.provider === 'custom' ? saved.model : '';
  } else {
    draft.baseUrl = '';
  }
  if (!silent) render();
}

function pickPreset(id) {
  const pr = presetById(id);
  draft.preset = id;
  draft.baseUrl = pr.url;
  draft.model = pr.model || '';
  draft.models = [];
  note = null;
  render();
}

function detectedLine() {
  const d = draft.detected;
  return d ? h('span', { class: 'detected' }, icon('check', 14), t('detected', { name: providerName(d.provider, d.preset) })) : null;
}

// Key pasted: recognize the AI by how the key starts and select the right tile.
function onKeyInput(e) {
  draft.apiKey = e.target.value.trim();
  const d = detectKey(draft.apiKey);
  // a bare "sk-" may be OpenAI, DeepSeek...: only switch when the chosen one clearly isn't it
  const apply = d && (!d.weak || draft.provider === 'gemini' || draft.provider === 'anthropic');
  const changes = apply && (draft.provider !== d.provider || (d.preset && draft.preset !== d.preset));
  if (changes) {
    pickProvider(d.provider, { silent: true });
    if (d.preset) {
      const pr = presetById(d.preset);
      draft.preset = d.preset;
      draft.baseUrl = pr.url;
      draft.model = pr.model || '';
    }
  }
  draft.detected = apply ? d : null;
  if (!changes) {
    const slot = document.getElementById('detected');
    if (slot) slot.replaceChildren(...[detectedLine()].filter(Boolean));
    return;
  }
  render();
  const input = app.querySelector('input.key');
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function tileEl(x) {
  const on = draft.provider === x.id;
  return h('button', { class: 'tile' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: () => pickProvider(x.id) },
    h('span', null, h('b', null, x.name()), h('small', null, t(x.sub))),
    x.free ? h('span', { class: 'free' }, t('freeTag')) : null);
}

function modelSelect(p) {
  const current = draft.model || p.models[0].id;
  return h('select', { 'aria-label': t('model'), onchange: (e) => { draft.model = e.target.value; } },
    p.models.map((m) => h('option', { value: m.id, selected: current === m.id }, m.label)));
}

function urlInput(hintKey) {
  return [h('label', null, t('urlLabel')),
    h('input', { type: 'url', value: draft.baseUrl, spellcheck: 'false', autocomplete: 'off', placeholder: 'https://',
      oninput: (e) => { draft.baseUrl = e.target.value.trim(); draft.models = []; } }),
    h('div', { class: 'field-hint' }, t(hintKey))];
}

function providerDetails(p) {
  if (p.id === 'compatible') {
    const pr = presetById(draft.preset);
    const modelField = draft.models.length
      ? h('select', { 'aria-label': t('model'), onchange: (e) => { draft.model = e.target.value; } },
        [h('option', { value: '', selected: !draft.model }, '—'),
          ...draft.models.map((m) => h('option', { value: m, selected: m === draft.model }, m))])
      : h('input', { type: 'text', value: draft.model, placeholder: t('modelTyped'), spellcheck: 'false', 'aria-label': t('model'),
        oninput: (e) => { draft.model = e.target.value.trim(); } });
    return [
      h('label', null, t('presetLabel')),
      h('select', { 'aria-label': t('presetLabel'), onchange: (e) => pickPreset(e.target.value) },
        PRESETS.map((x) => h('option', { value: x.id, selected: x.id === draft.preset }, presetLabel(x)))),
      ...urlInput('urlHintCompatible'),
      h('label', null, t('model')),
      h('div', { class: 'row nowrap' }, modelField,
        h('button', { class: 'btn', type: 'button', onclick: () => loadModels(), disabled: !!busy }, busy === 'models' ? spin('') : icon('refresh', 14), t('modelsLoad'))),
      h('div', { class: 'steps', style: 'margin-top:14px' }, pr.local ? t('stepsLocal', { name: pr.label }) : t('stepsCompatible')),
      pr.keyUrl ? h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => chrome.tabs.create({ url: pr.keyUrl }) }, icon('external', 13), t('openKeyPage'))) : null,
      h('div', { style: 'margin-top:12px' }, noteBox('info', 'shield', pr.local ? t('noteLocal') : t('noteCompatible'))),
    ];
  }
  if (p.id === 'custom') {
    return [
      ...urlInput('urlHintCustom'),
      h('label', null, t('model')),
      h('input', { type: 'text', value: draft.model, spellcheck: 'false', 'aria-label': t('model'), oninput: (e) => { draft.model = e.target.value.trim(); } }),
      h('div', { class: 'field-hint' }, t('modelCustomHint')),
      h('div', { class: 'steps', style: 'margin-top:14px' }, t('stepsCustom')),
      h('details', null, h('summary', null, t('contractTitle')),
        h('p', { class: 'muted small' }, t('contractText')), h('pre', { class: 'code' }, t('contractCode'))),
      h('div', { style: 'margin-top:12px' }, noteBox('info', 'shield', t('noteCustom'))),
    ];
  }
  return [
    h('div', { class: 'steps', style: 'margin-top:14px' }, t(STEPS[p.id])),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('button', { class: 'btn sm', type: 'button', onclick: () => chrome.tabs.create({ url: p.keyUrl }) }, icon('external', 13), t('openKeyPage'))),
    h('div', { style: 'margin-top:12px' }, noteBox('info', 'shield', t(NOTES[p.id]))),
    h('label', null, t('model')),
    modelSelect(p),
    h('details', null, h('summary', null, t('modelOther')),
      h('input', { type: 'text', value: draft.custom, placeholder: p.models[0].id, spellcheck: 'false', 'aria-label': t('modelOther'),
        oninput: (e) => { draft.custom = e.target.value.trim(); } }),
      h('div', { class: 'field-hint' }, t('modelOtherHint'))),
  ];
}

function aiSection(wizard) {
  const p = PROVIDERS[draft.provider];
  const keyInput = h('input', { class: 'key', type: draft.show ? 'text' : 'password', value: draft.apiKey, autocomplete: 'off',
    spellcheck: 'false', 'aria-label': p.keyOptional ? t('keyLabelOptional') : t('keyLabel'),
    placeholder: p.keyHint ? `${t('keyPaste')}  (${p.keyHint})` : t('keyPaste'), oninput: onKeyInput });
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, t('aiHead')), h('p', { class: 'muted' }, t('aiSub')))),
    h('label', null, p.keyOptional ? t('keyLabelOptional') : t('keyLabel')),
    h('div', { class: 'keybox' }, keyInput,
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { draft.show = !draft.show; render(); } },
        icon(draft.show ? 'eyeOff' : 'eye', 14), draft.show ? t('hideKey') : t('showKey'))),
    h('div', { id: 'detected' }, detectedLine()),
    S.settings.unconfirmed ? h('div', { style: 'margin-top:12px' }, noteBox('warn', 'alert', t('aiFromBackup', aiWhere(S.settings)))) : null,
    h('label', null, t('providerLabel')),
    h('div', { class: 'tiles' }, TILES.map(tileEl)),
    ...providerDetails(p),
    note ? h('div', { style: 'margin-top:14px' }, noteBox(note.kind, note.kind === 'ok' ? 'check' : note.kind === 'info' ? 'info' : 'alert', note.text)) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary lg', onclick: saveAi, disabled: !!busy }, busy === 'test' ? spin(t('testing')) : [icon('check', 15), t('testSave')]),
      wizard ? restoreButton() : null));
}

async function saveAi() {
  const p = PROVIDERS[draft.provider];
  const conf = { provider: p.id, apiKey: draft.apiKey.trim(), baseUrl: p.needsUrl ? draft.baseUrl.trim() : '',
    model: (p.needsUrl ? draft.model : draft.custom || draft.model || defaultModel(p.id)).trim() };
  if (!conf.apiKey && !p.keyOptional) return setNote('err', t('err_no_key'));
  if (p.needsUrl) {
    const u = checkBaseUrl(conf.baseUrl, p.id);
    if (!u.ok) return setNote('err', errText({ code: u.error }));
  }
  // permission to talk to this AI (Chrome asks once): the first thing the click does
  try {
    const ok = await chrome.permissions.request({ origins: [originFor(conf)] });
    if (!ok) return setNote('err', t('err_permission'));
  } catch (e) {
    // no permissions API (preview outside the extension): carry on
  }
  if (p.id === 'compatible' && !conf.model) {
    await loadModels({ permitted: true }); // no model yet: show the server's list
    if (!draft.model) return;
    conf.model = draft.model;
  }
  busy = 'test';
  note = null;
  render();
  try {
    const used = await testKey(conf);
    const prev = S.settings;
    S.settings = { ...S.settings, ...conf, preset: p.id === 'compatible' ? draft.preset : '', unconfirmed: false };
    await store.save({ settings: S.settings });
    forgetOldAddress(prev, conf);
    const name = shortName(conf) || providerName(p.id, draft.preset);
    note = { kind: 'ok', text: t('keyOk', { name: used && used !== name ? `${name} (${used})` : name }) };
    if (!S.onboarded && step === 1) {
      step = 2;
      note = null;
    }
  } catch (e) {
    note = { kind: 'err', text: e instanceof AIError ? errText(e) : t('err_down') };
  }
  busy = '';
  render();
}

// The address it talked to before (Other AI, Company AI) stops being allowed: only the current one is.
function forgetOldAddress(prev, now) {
  const old = PROVIDERS[prev && prev.provider];
  const before = old && old.needsUrl ? originFor(prev) : '';
  if (!before || before === originFor(now)) return;
  try {
    chrome.permissions.remove({ origins: [before] }).catch(() => {});
  } catch (e) {
    // no permissions API (preview outside the extension)
  }
}

// "Company AI (https://ai.example.com/burnout)": what the screen names when an AI came from a file.
function aiWhere(s) {
  const url = String((s && s.baseUrl) || '').split('?')[0];
  return { name: providerName(s.provider, s.preset), where: PROVIDERS[s.provider] && PROVIDERS[s.provider].needsUrl && url ? ` (${url})` : '' };
}

async function loadModels({ permitted = false } = {}) {
  const conf = { provider: 'compatible', apiKey: draft.apiKey.trim(), baseUrl: draft.baseUrl.trim() };
  const u = checkBaseUrl(conf.baseUrl, 'compatible');
  if (!u.ok) return setNote('err', errText({ code: u.error }));
  if (!permitted) {
    try {
      if (!(await chrome.permissions.request({ origins: [u.origin] }))) return setNote('err', t('err_permission'));
    } catch (e) {
      // preview outside the extension
    }
  }
  busy = 'models';
  note = null;
  render();
  try {
    const list = await listModels(conf);
    draft.models = list;
    const pr = presetById(draft.preset);
    if (!list.includes(draft.model)) draft.model = pr.model && list.includes(pr.model) ? pr.model : '';
    note = !list.length ? { kind: 'info', text: t('modelsNone') }
      : { kind: 'info', text: draft.model ? t('modelsLoaded', { n: list.length }) : t('modelsPick') };
  } catch (e) {
    draft.models = [];
    note = { kind: 'err', text: (e instanceof AIError ? errText(e) : t('err_down')) + ' ' + t('modelsNone') };
  }
  busy = '';
  render();
}

// New computer: the backup brings everything (AI, profile, memory) and skips the walkthrough.
function restoreButton() {
  const file = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onchange: (e) => importFile(e, 'restore') });
  return h('span', { class: 'row' }, h('button', { class: 'btn ghost', type: 'button', onclick: () => file.click() }, icon('upload', 14), t('restoreBackup')), file);
}

// ── 2. Your business ────────────────────────────────────────────────────
function aboutSection(wizard) {
  const p = { ...S.profile };
  const input = (key, attrs = {}) => h('input', { type: 'text', value: p[key] || '', 'data-k': key, ...attrs });
  const area = (key, rows = 3) => {
    const el = h('textarea', { rows, 'data-k': key });
    el.value = p[key] || '';
    return el;
  };
  const field = (labelKey, el, hintKey) => [h('label', null, t(labelKey)), el, hintKey ? h('div', { class: 'field-hint' }, t(hintKey)) : null];
  const more = h('details', { open: wizard ? null : true },
    h('summary', null, t('moreDetails')),
    ...field('fServices', area('services', 3), 'fServicesHint'),
    h('div', { class: 'two' },
      h('div', null, ...field('fHours', input('hours'), 'fHoursHint')),
      h('div', null, ...field('fBooking', input('booking', { type: 'url' }), 'fBookingHint'))),
    ...field('fNever', area('never', 2), 'fNeverHint'),
    ...field('fTone', input('tone'), 'fToneHint'),
    ...field('fEmails', area('emails', 2), 'fEmailsHint'));
  return h('section', { class: 'card', id: 'about' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, t('aboutHead')), h('p', { class: 'muted' }, t('aboutSub')))),
    ...field('fName', input('name')),
    ...field('fAbout', area('about', 2), 'fAboutHint'),
    ...field('fSignature', area('signature', 3), 'fSignatureHint'),
    more,
    note ? h('div', { style: 'margin-top:14px' }, noteBox(note.kind, note.kind === 'ok' ? 'check' : 'alert', note.text)) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary lg', onclick: saveAbout }, icon('check', 15), wizard ? t('continue') : t('save'))));
}

async function saveAbout() {
  const vals = {};
  for (const el of document.querySelectorAll('#about [data-k]')) vals[el.getAttribute('data-k')] = String(el.value || '').trim();
  if (vals.name.length < 2) note = { kind: 'err', text: t('errName') };
  else if (vals.about.length < 10) note = { kind: 'err', text: t('errAbout') };
  else if (vals.booking && !/^https:\/\/\S+$/i.test(vals.booking)) note = { kind: 'err', text: t('errBooking') };
  else note = null;
  S.profile = { ...S.profile, ...vals };
  if (note) return render();
  const extra = {};
  if (!S.onboarded && step === 2) {
    step = 3;
    extra.onboarded = true;
    S.onboarded = true;
  } else {
    note = { kind: 'ok', text: t('saved') };
  }
  await store.save({ profile: S.profile, ...extra });
  render();
}

// ── 3. Done ─────────────────────────────────────────────────────────────
function doneSection() {
  const tip = (ic, text, extra) => h('div', { class: 'tip' }, icon(ic, 16), h('span', null, text, extra || null));
  return h('section', { class: 'card' },
    h('h2', null, t('doneHead')),
    h('p', { class: 'muted', style: 'margin-top:6px' }, t('doneText')),
    h('div', { class: 'tips' },
      shortcut ? tip('spark', t('doneShortcut') + ' ', h('kbd', null, shortcut)) : null,
      tip('external', t('donePin')),
      tip('learn', t('doneLearn'))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary lg', onclick: () => chrome.tabs.create({ url: 'https://mail.google.com/' }) }, icon('mail', 15), t('openGmail')),
      h('button', { class: 'btn', onclick: () => { step = 0; tab = 'ai'; note = null; render(); } }, icon('sliders', 14), t('settings'))));
}

// ── Memory and backup ───────────────────────────────────────────────────
// A long list shows the first 100 that match the search; "Show all" shows the rest.
function memoryList(items) {
  if (!items.length) return h('div', { class: 'list' }, h('div', { class: 'empty' }, t('memNone')));
  const q = memQuery.trim().toLowerCase();
  const found = q ? items.filter((m) => (m.text + ' ' + (m.contact || '')).toLowerCase().includes(q)) : items;
  const shown = memAll ? found : found.slice(0, MEM_SHOWN);
  const out = [h('div', { class: 'list' }, shown.length ? shown.map((m) =>
    h('label', { class: 'mem-item' },
      h('input', { type: 'checkbox', 'data-mem': m.id }),
      h('span', { class: 'mem-text' }, m.text, m.contact ? h('span', { class: 'mem-for' }, t('memFor', { who: m.contact })) : null),
      h('span', { class: 'mem-meta' }, m.date || ''))) : h('div', { class: 'empty' }, t('memNone')))];
  if (shown.length < found.length) {
    out.push(h('div', { class: 'row', style: 'margin-top:6px' },
      h('span', { class: 'muted small' }, t('memShowing', { shown: shown.length.toLocaleString('en-US'), n: found.length.toLocaleString('en-US') })),
      h('button', { class: 'btn ghost sm', type: 'button', onclick: () => { memAll = true; render(); } }, t('memShowAll'))));
  }
  return out;
}

// The search redraws the tab; the cursor goes back to the search box, at the end.
function memorySearch() {
  return h('input', { type: 'search', 'data-memsearch': '1', placeholder: t('memSearch'), 'aria-label': t('memSearch'), value: memQuery,
    oninput: (e) => {
      memQuery = e.target.value;
      render();
      const box = app.querySelector('[data-memsearch]');
      if (box) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
    } });
}

// Conversation notes: what the person asked for with Redo, grouped by conversation, newest
// first. A conversation saved before subjects were kept shows only the date.
function notesSection() {
  const threads = store.noteThreads(S.notes);
  const list = threads.length ? threads.map((c) => {
    const last = c.items[c.items.length - 1].date || '';
    const count = c.items.length === 1 ? t('notesCount1') : t('notesCountN', { n: c.items.length });
    const name = c.subject === null ? '' : c.subject || t('noSubject');
    return h('div', { class: 'nthread' },
      h('div', { class: 'nthread-head' },
        h('div', { class: 'grow' },
          name ? h('div', { class: 'nthread-subject' }, name) : null,
          h('div', { class: 'mem-meta' }, last ? `${count} · ${last}` : count)),
        h('button', { class: 'btn danger sm', 'aria-label': `${t('notesClear')}: ${name || last}`, onclick: async () => {
          await store.clearNotes(c.id);
          toast(t('notesCleared'));
          await load();
          render();
        } }, icon('trash', 13), t('notesClear'))),
      c.items.map((n) => h('div', { class: 'nitem' }, h('span', { class: 'mem-meta' }, n.date || ''), h('span', { class: 'mem-text' }, n.text))));
  }) : h('div', { class: 'empty' }, t('notesNone'));
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, t('notesHead')),
        h('p', { class: 'muted' }, t('notesText', { per: store.NOTES_PER_THREAD, threads: store.NOTE_THREADS_KEPT })))),
    h('label', null, t('notesThreads', { n: threads.length })),
    h('div', { class: 'list' }, list));
}

function memorySection() {
  const manual = S.memory.filter((m) => m.source !== 'learned');
  // newest first: with thousands of facts, the recent ones are the ones people look for
  const learned = S.memory.filter((m) => m.source === 'learned').map((m, i) => ({ m, i }))
    .sort((a, b) => String(b.m.date || '').localeCompare(String(a.m.date || '')) || b.i - a.i).map((x) => x.m);
  const add = h('input', { type: 'text', placeholder: t('memAddHint'), 'aria-label': t('memAddHint') });
  const withKey = h('input', { type: 'checkbox', onchange: (e) => {
    const warn = document.getElementById('keywarn');
    if (warn) warn.hidden = !e.target.checked;
  } });
  const file = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onchange: (e) => importFile(e, 'merge') });
  const saveMem = async () => {
    const r = await store.addMemory(add.value);
    if (r && r.full) toast(t('rememberFull'));
    else if (r && r.dup) toast(t('rememberDup'));
    else if (r && r.id) toast(t('remembered'));
    await load();
    render();
  };
  return [
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', null, t('memTitle')), h('p', { class: 'muted' }, t('memText')))),
      h('div', { class: 'row nowrap', style: 'margin-top:14px' }, add,
        h('button', { class: 'btn primary', onclick: saveMem }, icon('plus', 14), t('memAdd'))),
      S.memory.length > 20 ? h('div', { style: 'margin-top:14px' }, memorySearch()) : null,
      h('label', null, `${t('memManual')} (${manual.length}/${store.MEMORY_MAX.manual})`), memoryList(manual),
      h('label', null, `${t('memLearned')} (${learned.length.toLocaleString('en-US')}/${store.MEMORY_MAX.learned.toLocaleString('en-US')})`), memoryList(learned),
      h('div', { class: 'field-hint' }, t('memLearnedHint')),
      (S.identity.aliases || []).length ? [h('label', null, t('memAliases')), h('div', { class: 'field-hint' }, t('memAliasesHint')),
        h('div', { class: 'list' }, S.identity.aliases.map((a) => h('div', { class: 'mem-item' },
          h('span', { class: 'mem-text' }, a),
          h('button', { class: 'btn ghost sm', type: 'button', 'aria-label': `${t('memAliasRemove')}: ${a}`, onclick: async () => {
            await store.removeAlias(a);
            toast(t('memDeleted'));
            await load();
            render();
          } }, icon('trash', 13), t('memAliasRemove')))))] : null,
      h('label', null, t('memVoice', { n: voiceCount.toLocaleString('en-US') })),
      h('div', { class: 'field-hint' }, t('memVoiceHint')),
      voiceCount ? h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => {
          if (!window.confirm(t('memVoiceConfirm'))) return;
          await store.clearVoice();
          toast(t('memVoiceCleared'));
          await load();
          render();
        } }, icon('trash', 13), t('memVoiceClear'))) : null,
      S.style.summary ? [h('label', null, t('learnedStyle')), h('p', { class: 'small result muted' }, S.style.summary)] : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn danger', onclick: async () => {
          const ids = [...document.querySelectorAll('[data-mem]:checked')].map((el) => el.getAttribute('data-mem'));
          if (!ids.length) return;
          await store.removeMemory(ids);
          toast(t('memDeleted'));
          await load();
          render();
        } }, icon('trash', 14), t('memDeleteChecked')))),
    notesSection(),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', null, t('backupTitle')), h('p', { class: 'muted' }, t('backupText')))),
      h('label', { class: 'check', style: 'margin-top:14px' }, withKey, t('backupWithKey')),
      h('div', { id: 'keywarn', hidden: true, style: 'margin-top:8px' }, noteBox('warn', 'alert', t('backupKeyWarn'))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: async () => {
          const data = await store.exportBackup({ includeKey: withKey.checked });
          const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
          const a = h('a', { href: url, download: `burnout-backup-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        } }, icon('download', 14), t('backupExport')),
        h('button', { class: 'btn', onclick: () => file.click() }, icon('upload', 14), t('backupImport')), file)),
  ];
}

const BACKUP_MAX_BYTES = 20 * 1024 * 1024; // a real backup is a few MB at most
const FIELD_LABEL = { name: 'fName', about: 'fAbout', services: 'fServices', hours: 'fHours', booking: 'fBooking',
  signature: 'fSignature', never: 'fNever', tone: 'fTone', emails: 'fEmails' };

// What the file would change, so the person decides before anything comes in.
function importQuestion(plan) {
  const lines = [t('importAsk'), ''];
  lines.push('- ' + (plan.scoped ? t('importMemScoped', { n: plan.added, m: plan.scoped }) : t('importMem', { n: plan.added })));
  if (plan.profile.length) lines.push('- ' + t('importProfile', { fields: plan.profile.map((k) => t(FIELD_LABEL[k])).join(', ') }));
  if (plan.addresses.length) lines.push('- ' + t('importAddresses', { list: plan.addresses.join(', ') }));
  if (plan.ai) lines.push('- ' + t('importAi', aiWhere(plan.ai)));
  lines.push('', t('importTrust'));
  return lines.join('\n');
}

async function importFile(e, mode) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    if (f.size > BACKUP_MAX_BYTES) throw new Error('too_big');
    const data = JSON.parse(await f.text());
    if (!window.confirm(importQuestion(await store.previewBackup(data, { mode })))) return;
    const r = await store.importBackup(data, { mode });
    const done = mode === 'restore' ? (r.restored ? 'backupRestoredAi' : 'backupRestored') : 'backupImported';
    toast(t(done, { n: r.added }), 8000);
    draft = null;
    await load();
    if (mode === 'restore') {
      if (S.onboarded) step = 0;
      else if (store.connected(S.settings)) step = 2; // the AI came along but the profile is missing
    }
  } catch (err) {
    toast(t('backupBad'));
    await load();
  }
  render();
}

// ── Privacy ─────────────────────────────────────────────────────────────
function privacySection() {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, t('privTitle')))),
    h('ul', { class: 'bullets' }, ['privB1', 'privB2', 'privB3', 'privB4'].map((k) => h('li', null, t(k)))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn danger', onclick: async () => {
        if (!window.confirm(t('wipeConfirm'))) return;
        await store.wipe();
        toast(t('wiped'));
        draft = null;
        step = 1;
        tab = 'ai';
        await load();
        render();
      } }, icon('trash', 14), t('wipe'))));
}

// ── Screen ──────────────────────────────────────────────────────────────
function stepper() {
  const items = [['step1', 1], ['step2', 2], ['step3', 3]];
  return h('div', { class: 'stepper' }, items.map(([key, n]) =>
    h('div', { class: 'step' + (step === n ? ' on' : step > n ? ' done' : '') },
      h('span', { class: 'n' }, step > n ? icon('check', 12) : String(n)), h('span', null, t(key)))));
}

// The version, and where new ones are: opened only on a click (Burnout never checks on its own).
// The link shows once manifest.json has the repository's "homepage_url".
function versionFoot() {
  const m = chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
  if (!m.version) return null;
  const home = String(m.homepage_url || '').replace(/\/+$/, '');
  return h('p', { class: 'muted small version' }, t('versionLine', { v: m.version }),
    home ? [' · ', h('a', { href: home + '/releases', target: '_blank', rel: 'noopener' }, t('checkUpdates'))] : null);
}

function render() {
  const top = h('div', { class: 'top' }, h('img', { class: 'mark', src: 'icons/icon48.png', alt: '' }),
    h('div', null, h('h1', null, t('appName')), h('p', { class: 'muted small' }, t('optTitle'))),
    h('span', { class: 'pill' }, icon('lock', 12), t('privatePill')));
  const out = [top];
  if (!S.onboarded || step === 3) {
    out.push(stepper());
    if (step === 1) out.push(aiSection(true));
    else if (step === 2) out.push(aboutSection(true));
    else out.push(doneSection());
  } else {
    const tabs = [['ai', 'tabAi'], ['about', 'tabAbout'], ['memory', 'tabMemory'], ['privacy', 'tabPrivacy']];
    out.push(h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, key]) =>
      h('button', { class: 'tab' + (tab === id ? ' on' : ''), role: 'tab', 'aria-selected': tab === id ? 'true' : 'false',
        onclick: () => { tab = id; note = null; render(); } }, t(key)))));
    if (tab === 'ai') out.push(aiSection(false));
    else if (tab === 'about') out.push(aboutSection(false));
    else if (tab === 'memory') out.push(...memorySection());
    else out.push(privacySection());
  }
  out.push(versionFoot());
  app.replaceChildren(...out.flat().filter(Boolean));
  // first time on each step: the cursor starts in the right field (just paste the key, just type the name)
  if (!S.onboarded && (step === 1 || step === 2) && step !== focusedStep) {
    focusedStep = step;
    const first = app.querySelector(step === 1 ? 'input.key' : '#about [data-k=name]');
    if (first && !first.value) first.focus();
  }
}

// Back from the key page (Google, OpenAI...): the cursor returns to the key field, ready to paste.
window.addEventListener('focus', () => {
  if (!S || S.onboarded || step !== 1 || (draft && draft.apiKey)) return;
  const key = app.querySelector('input.key');
  if (key && document.activeElement !== key) key.focus();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && (changes.memory || changes.style || changes.notes || changes.voice) && tab === 'memory' && S && S.onboarded) {
    // Learn running in the panel changes the memory every few seconds: don't take the cursor from the search box
    if (document.activeElement && document.activeElement.matches && document.activeElement.matches('[data-memsearch]')) return;
    await load();
    render();
  }
});

if (chrome.commands && chrome.commands.getAll) {
  chrome.commands.getAll().then((cmds) => {
    const c = cmds.find((x) => x.name === '_execute_action');
    shortcut = (c && c.shortcut) || '';
    if (step === 3) render();
  }).catch(() => {});
}

load().then(() => {
  if (S.onboarded) step = 0;
  else if (store.connected(S.settings)) step = 2;
  render();
});
