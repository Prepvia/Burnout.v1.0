// Each person's own AI, or their business's. Burnout calls it straight from the browser;
// no server of ours in between.
//
// Providers (models checked on the official pages on Oct 17, 2026):
//   gemini      generateContent (v1beta), key in the x-goog-api-key header. Has a free plan.
//   openai      Responses API (/v1/responses).
//   anthropic   Messages API (/v1/messages), with the direct-browser-access header.
//   compatible  any server in OpenAI's /chat/completions format: OpenRouter, Groq,
//               Mistral, DeepSeek, xAI, Together, and Ollama or LM Studio on this computer.
//   custom      the company AI: an address that takes {system, prompt, max_tokens,
//               purpose, model} and returns {text} (docs/CONNECT_AI.md).
//
// With onText the reply arrives in pieces (stream) and the screen shows it as it comes.
// A server that doesn't stream falls back to a normal request without the person
// noticing. An optional parameter the model rejects (thinking, reasoning, effort,
// fallbacks) is dropped on the spot and the call repeats without it; Burnout remembers
// that while the browser stays open.

export const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    short: 'Gemini',
    free: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    origin: 'https://generativelanguage.googleapis.com/*',
    keyHint: 'AQ...',
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI (ChatGPT)',
    short: 'ChatGPT',
    free: false,
    keyUrl: 'https://platform.openai.com/api-keys',
    origin: 'https://api.openai.com/*',
    keyHint: 'sk-...',
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
    ],
  },
  anthropic: {
    id: 'anthropic',
    label: 'Claude (Anthropic)',
    short: 'Claude',
    free: false,
    keyUrl: 'https://platform.claude.com/settings/keys',
    origin: 'https://api.anthropic.com/*',
    keyHint: 'sk-ant-...',
    models: [
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    ],
  },
  compatible: {
    id: 'compatible',
    label: 'OpenAI-compatible',
    short: '',
    needsUrl: true,
    keyOptional: true,
    keyHint: '',
    models: [],
  },
  custom: {
    id: 'custom',
    label: 'Own endpoint',
    short: '',
    needsUrl: true,
    keyOptional: true,
    keyHint: '',
    noStream: true,
    models: [],
  },
};

/** Ready-made services for "Other AI": the address comes filled in. The person picks the model from the server's list. */
export const PRESETS = [
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', model: 'openrouter/auto' },
  { id: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  { id: 'mistral', label: 'Mistral', url: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'xai', label: 'xAI (Grok)', url: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai' },
  { id: 'together', label: 'Together AI', url: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.xyz/settings/api-keys' },
  { id: 'ollama', label: 'Ollama', url: 'http://localhost:11434/v1', local: true },
  { id: 'lmstudio', label: 'LM Studio', url: 'http://localhost:1234/v1', local: true },
  { id: 'other', label: '', url: '' },
];

export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const THINKING_ROOM = 1500; // reasoning tokens the model may spend before the text

export class AIError extends Error {
  /**
   * code: no_provider | no_key | key_format | no_url | no_model | url_bad | url_https | key | key_gemini | credit | region
   *       | quota | model | too_long | url | down | network | unreachable | origin | timeout | refused | empty | bad_request
   *       | permission
   */
  constructor(code, detail = '') {
    super(code);
    this.code = code;
    this.detail = String(detail || '').slice(0, 300);
  }
}

// optional parameters a model already rejected: "provider|model|parameter"
const REFUSED_EXTRAS = new Set();
// servers that rejected streaming: "provider|model|address"
const NO_STREAM = new Set();

export function resetRefusedExtras() {
  REFUSED_EXTRAS.clear();
  NO_STREAM.clear();
}

export function defaultModel(provider) {
  const p = PROVIDERS[provider];
  return p && p.models[0] ? p.models[0].id : '';
}

// ── Pasted key: whose is it ─────────────────────────────────────────────
const KEY_PATTERNS = [
  // AI Studio makes "auth keys" (AQ.) since May 28, 2026; older standard keys start with AIza.
  // Google doesn't publish the AQ. character set: any printable character (resolve() refuses the rest).
  [/^AQ[.][!-~]{20,}$/, { provider: 'gemini' }],
  [/^AIza[0-9A-Za-z_-]{20,}$/, { provider: 'gemini' }],
  [/^sk-ant-[0-9A-Za-z_-]{10,}$/, { provider: 'anthropic' }],
  [/^sk-or-[0-9A-Za-z_-]{10,}$/, { provider: 'compatible', preset: 'openrouter' }],
  [/^gsk_[0-9A-Za-z]{10,}$/, { provider: 'compatible', preset: 'groq' }],
  [/^xai-[0-9A-Za-z]{10,}$/, { provider: 'compatible', preset: 'xai' }],
  [/^sk-(?:proj|svcacct|admin)-[0-9A-Za-z_-]{10,}$/, { provider: 'openai' }],
  // a bare "sk-" is also DeepSeek and others: a weak guess
  [/^sk-[0-9A-Za-z_-]{20,}$/, { provider: 'openai', weak: true }],
];

/** Recognizes the key by how it starts. null when it can't tell. */
export function detectKey(key) {
  const k = String(key || '').trim();
  for (const [re, who] of KEY_PATTERNS) if (re.test(k)) return { ...who };
  return null;
}

// ── Server address (Other AI and Company AI) ────────────────────────────
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Checks the address: HTTPS, or HTTP only on this computer (Ollama, LM Studio).
 * Returns { ok, url, origin, local } or { ok: false, error }.
 * origin is Chrome's permission pattern for that server (no port: any port matches).
 */
export function checkBaseUrl(raw, kind = 'compatible') {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, error: 'no_url' };
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return { ok: false, error: 'url_bad' };
  }
  if (u.username || u.password || !u.hostname) return { ok: false, error: 'url_bad' };
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { ok: false, error: 'url_https' };
  let url = u.origin + u.pathname.replace(/\/+$/, '');
  if (kind === 'compatible') url = url.replace(/\/chat\/completions$/, '');
  else url += u.search; // an own endpoint may carry the function key in the query (?code=...)
  return { ok: true, url, origin: `${u.protocol}//${u.hostname}/*`, local };
}

/** Chrome's permission pattern for this configuration's AI ('' when the address is invalid). */
export function originFor(cfg) {
  const p = PROVIDERS[cfg && cfg.provider];
  if (!p) return '';
  if (!p.needsUrl) return p.origin;
  const u = checkBaseUrl(cfg.baseUrl, p.id);
  return u.ok ? u.origin : '';
}

/** Short name to show in the panel: "Gemini", "ChatGPT", "openrouter.ai"... */
export function shortName(cfg) {
  const p = PROVIDERS[cfg && cfg.provider];
  if (!p) return '';
  if (p.short) return p.short;
  try {
    return new URL(cfg.baseUrl).hostname.replace(/^www\.|^api\./, '');
  } catch (e) {
    return '';
  }
}

/** Removes the reasoning some models write before the answer (<think>...</think>). */
export function stripThink(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
}

// ── HTTP ────────────────────────────────────────────────────────────────
function netError(e, o) {
  if (e && e.name === 'AbortError') return new AIError('timeout');
  if (e instanceof AIError) return e;
  return new AIError(o.kind && PROVIDERS[o.kind] && PROVIDERS[o.kind].needsUrl ? 'unreachable' : 'network', e && e.message);
}

/**
 * Makes the request. Without stream (or when the server answered without one): { status, text, data }.
 * With stream: { status: 200, stream } where stream is an async iterator of SSE events.
 * The timeout runs until the response arrives; on a stream it restarts with every piece.
 */
async function request(o, url, headers, body, { stream = false, method = 'POST' } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  const arm = () => {
    if (!ctrl) return;
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
  };
  const disarm = () => clearTimeout(timer);
  arm();
  let res;
  try {
    res = await o.fetchImpl(url, {
      method,
      headers: method === 'GET' ? headers : { 'content-type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch (e) {
    disarm();
    throw netError(e, o);
  }
  const type = String((res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '');
  if (stream && res.status === 200 && /event-stream/i.test(type) && res.body && typeof res.body.getReader === 'function') {
    return { status: 200, stream: sseEvents(res.body, arm, disarm, o) };
  }
  let text = '';
  try {
    text = await res.text();
  } catch (e) {
    throw netError(e, o);
  } finally {
    disarm();
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = null;
  }
  return { status: res.status, text, data };
}

function sseBlock(block) {
  let event = '';
  const data = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const k = line.indexOf(':');
    const field = k < 0 ? line : line.slice(0, k);
    let value = k < 0 ? '' : line.slice(k + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!event && !data.length) return null;
  const raw = data.join('\n');
  let json = null;
  try {
    json = raw && raw !== '[DONE]' ? JSON.parse(raw) : null;
  } catch (e) {
    json = null;
  }
  return { event, raw, data: json };
}

/** Reads an SSE body in pieces and yields one event at a time ({ event, raw, data }). */
async function* sseEvents(body, onChunk, done, o) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let tail = '';
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        throw netError(e, o);
      }
      if (chunk.done) break;
      onChunk();
      // \r\n and \r become \n; a \r at the end of a piece may be half of a \r\n
      let raw = tail + dec.decode(chunk.value, { stream: true });
      tail = raw.endsWith('\r') ? '\r' : '';
      if (tail) raw = raw.slice(0, -1);
      buf += raw.replace(/\r\n?/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = sseBlock(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (ev) yield ev;
      }
    }
    const last = sseBlock((buf + tail).replace(/\r\n?/g, '\n').trim());
    if (last) yield last;
  } finally {
    done();
    try {
      reader.releaseLock();
    } catch (e) {
      // already released
    }
  }
}

const CREDIT_RE = /credit[_ ]balance|insufficient[_ ]quota|insufficient[_ ](?:funds|credits?|balance)|out of credits|billing_error|spend[_ ]limit/;
const REGION_RE = /location is not supported|not (?:available|supported) in your (?:country|region)|unsupported[_ ](?:country|region)/;
const TOO_LONG_RE = /context[_ ]length|context window|maximum context|too many tokens|prompt is too long|token count exceeds|input is too long/;

function failFor(status, text, kind = '', local = false) {
  const t = String(text || '').toLowerCase();
  const own = kind === 'compatible' || kind === 'custom';
  // a server on this computer answering 403 is Ollama/LM Studio refusing the extension's origin, not a key problem
  if (local && status === 403) return new AIError('origin', text);
  // before the status: missing credit and region come as 400/403/429, and "pick another model" doesn't fix them
  if (status === 402 || CREDIT_RE.test(t)) return new AIError('credit', text);
  if (REGION_RE.test(t)) return new AIError('region', text);
  if (status >= 400 && status < 500 && status !== 429 && TOO_LONG_RE.test(t)) return new AIError('too_long', text);
  if (status === 401 || status === 403) return new AIError('key', text);
  if (status === 429) return new AIError('quota', text);
  if (status === 404) return new AIError(kind === 'custom' || (own && !/model/.test(t)) ? 'url' : 'model', text);
  if (status === 405) return new AIError(own ? 'url' : 'bad_request', text);
  if (status === 400 && /api[_ ]?key|invalid.*key|key.*invalid|authentication/.test(t)) return new AIError('key', text);
  if (status === 400 && /model/.test(t)) return new AIError('model', text);
  if (status === 400) return new AIError('bad_request', text);
  if (status >= 500) return new AIError('down', text);
  return new AIError('bad_request', text);
}

/** An error that arrives in the middle of a stream ({ type/code, message }). */
function streamFail(err) {
  const e = err || {};
  const s = `${e.type || ''} ${e.code || ''} ${e.status || ''} ${e.message || ''}`.toLowerCase();
  if (CREDIT_RE.test(s)) return new AIError('credit', s);
  if (REGION_RE.test(s)) return new AIError('region', s);
  if (/overload/.test(s)) return new AIError('down', s);
  if (/rate[_ ]?limit|quota|exhaust/.test(s)) return new AIError('quota', s);
  if (/auth|api[_ ]?key|permission/.test(s)) return new AIError('key', s);
  if (TOO_LONG_RE.test(s)) return new AIError('too_long', s);
  if (/not[_ ]found|model/.test(s)) return new AIError('model', s);
  if (/invalid[_ ]request/.test(s)) return new AIError('bad_request', s);
  return new AIError('down', s);
}

// Calls with the extras; if the model rejects one of them (a 400 that names it), drop it and repeat.
async function withExtras(key, extras, send) {
  let active = extras.filter((x) => !REFUSED_EXTRAS.has(key + '|' + x.name));
  for (;;) {
    const res = await send(active);
    if (res.status !== 400 || !active.length) return res;
    const t = res.text.toLowerCase();
    const culprit = active.find((x) => x.match.test(t));
    if (!culprit) return res;
    REFUSED_EXTRAS.add(key + '|' + culprit.name);
    active = active.filter((x) => x !== culprit); // shrinks every round: always ends
  }
}

/** truncated = the AI stopped at its length limit: the text may be cut off. */
function finish(text, model, usage, truncated = false) {
  const out = String(text || '').trim();
  if (!out) throw new AIError('empty', truncated ? 'max_tokens' : '');
  return { text: out, model, usage, truncated: !!truncated };
}

// ── Gemini ──────────────────────────────────────────────────────────────
function geminiPieces(d) {
  if (d.error) throw streamFail(d.error);
  if (d.promptFeedback && d.promptFeedback.blockReason) throw new AIError('refused', d.promptFeedback.blockReason);
  const cand = (d.candidates || [])[0];
  if (!cand) return { text: '', reason: '' };
  const reason = cand.finishReason || '';
  if (/SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(reason)) throw new AIError('refused', reason);
  const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  return { text, reason };
}

function geminiUsage(u = {}) {
  return { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) };
}

async function callGemini(cfg, o) {
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}`;
  const url = o.onText ? base + ':streamGenerateContent?alt=sse' : base + ':generateContent';
  const extras = [{ name: 'thinking', match: /thinking/ }];
  const res = await withExtras(`gemini|${cfg.model}`, extras, (active) => {
    const generationConfig = { maxOutputTokens: o.maxTokens + THINKING_ROOM };
    if (active.some((x) => x.name === 'thinking')) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    return request(o, url, { 'x-goog-api-key': cfg.apiKey }, {
      system_instruction: { parts: [{ text: o.system }] },
      contents: [{ role: 'user', parts: [{ text: o.user }] }],
      generationConfig,
    }, { stream: !!o.onText });
  });
  if (res.status !== 200) {
    // Google refuses unrestricted standard keys (AIza) since June 2026: the text says to make a new key
    const e = failFor(res.status, res.text);
    throw e.code === 'key' ? new AIError('key_gemini', e.detail) : e;
  }
  if (!res.stream) {
    const d = res.data || {};
    const { text, reason } = geminiPieces(d);
    if (!(d.candidates || []).length) throw new AIError('empty');
    return finish(text, cfg.model, geminiUsage(d.usageMetadata), reason === 'MAX_TOKENS');
  }
  let text = '';
  let reason = '';
  let usage = {};
  for await (const ev of res.stream) {
    if (!ev.data) continue;
    const piece = geminiPieces(ev.data);
    if (piece.text) {
      text += piece.text;
      o.onText(text);
    }
    if (piece.reason) reason = piece.reason;
    if (ev.data.usageMetadata) usage = ev.data.usageMetadata;
  }
  return finish(text, cfg.model, geminiUsage(usage), reason === 'MAX_TOKENS');
}

// ── OpenAI (Responses API) ──────────────────────────────────────────────
async function callOpenAI(cfg, o) {
  const extras = [{ name: 'reasoning', match: /reasoning/ }];
  const res = await withExtras(`openai|${cfg.model}`, extras, (active) => {
    const body = { model: cfg.model, instructions: o.system, input: o.user, max_output_tokens: o.maxTokens + THINKING_ROOM, store: false };
    if (active.some((x) => x.name === 'reasoning')) body.reasoning = { effort: 'low' };
    if (o.onText) body.stream = true;
    return request(o, 'https://api.openai.com/v1/responses', { authorization: 'Bearer ' + cfg.apiKey }, body, { stream: !!o.onText });
  });
  if (res.status !== 200) throw failFor(res.status, res.text);
  const usageOf = (u = {}) => ({ input: u.input_tokens || 0, output: u.output_tokens || 0 });
  if (!res.stream) {
    const d = res.data || {};
    const parts = [];
    for (const item of d.output || []) {
      if (item.type !== 'message') continue;
      for (const c of item.content || []) {
        if (c.type === 'refusal') throw new AIError('refused', c.refusal);
        if (c.type === 'output_text' && c.text) parts.push(c.text);
      }
    }
    let text = parts.join('').trim();
    if (!text && typeof d.output_text === 'string') text = d.output_text.trim();
    const reason = d.incomplete_details && d.incomplete_details.reason;
    if (reason === 'content_filter') throw new AIError('refused', reason);
    if (!text) throw new AIError('empty', reason || d.status);
    return finish(text, cfg.model, usageOf(d.usage), reason === 'max_output_tokens');
  }
  let text = '';
  let reason = '';
  let usage = {};
  for await (const ev of res.stream) {
    const d = ev.data;
    if (!d) continue;
    const type = d.type || ev.event;
    if (type === 'response.output_text.delta') {
      text += d.delta || '';
      o.onText(text);
    } else if (type === 'response.refusal.delta' || type === 'response.refusal.done') {
      throw new AIError('refused', d.delta || d.refusal);
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      const r = d.response || {};
      usage = r.usage || usage;
      reason = (r.incomplete_details && r.incomplete_details.reason) || reason;
      if (reason === 'content_filter') throw new AIError('refused', 'content_filter');
    } else if (type === 'response.failed') {
      throw streamFail((d.response && d.response.error) || {});
    } else if (type === 'error') {
      throw streamFail(d.error || d);
    }
  }
  return finish(text, cfg.model, usageOf(usage), reason === 'max_output_tokens');
}

// ── Claude (Messages API) ───────────────────────────────────────────────
async function callAnthropic(cfg, o) {
  const big = /^claude-(sonnet|opus)-5-5\b/.test(cfg.model);
  const extras = [{ name: 'effort', match: /output_config|effort/ }];
  if (big) extras.unshift({ name: 'fallbacks', match: /fallback|beta/ });
  const res = await withExtras(`anthropic|${cfg.model}`, extras, (active) => {
    const headers = {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    const body = {
      model: cfg.model,
      max_tokens: o.maxTokens + THINKING_ROOM,
      // the fixed part is cached; the thread part comes after it, outside the cache
      system: o.systemParts.map((text, i) => (i === 0 ? { type: 'text', text, cache_control: { type: 'ephemeral' } } : { type: 'text', text })),
      messages: [{ role: 'user', content: o.user }],
    };
    if (active.some((x) => x.name === 'effort')) body.output_config = { effort: 'low' };
    if (active.some((x) => x.name === 'fallbacks')) {
      // a decline in the cyber/frontier_llm categories is retried on Anthropic's side
      headers['anthropic-beta'] = ANTHROPIC_FALLBACK_BETA;
      body.fallbacks = 'default';
    }
    if (o.onText) body.stream = true;
    return request(o, 'https://api.anthropic.com/v1/messages', headers, body, { stream: !!o.onText });
  });
  if (res.status !== 200) throw failFor(res.status === 529 ? 503 : res.status, res.text);
  if (!res.stream) {
    const d = res.data || {};
    if (d.stop_reason === 'refusal') throw new AIError('refused', d.stop_details && d.stop_details.category);
    const text = (d.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
    if (!text) throw new AIError('empty', d.stop_reason);
    const u = d.usage || {};
    const input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    return finish(text, d.model || cfg.model, { input, output: u.output_tokens || 0 }, d.stop_reason === 'max_tokens');
  }
  let text = '';
  let model = cfg.model;
  let input = 0;
  let output = 0;
  let stop = '';
  for await (const ev of res.stream) {
    const d = ev.data;
    if (!d) continue;
    const type = d.type || ev.event;
    if (type === 'message_start') {
      // a new message starts from zero (a server-side fallback continues the same message,
      // with no new message_start: its text just keeps arriving)
      const m = d.message || {};
      const u = m.usage || {};
      text = '';
      model = m.model || model;
      input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    } else if (type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') {
      text += d.delta.text || '';
      o.onText(text);
    } else if (type === 'message_delta') {
      if (d.delta && d.delta.stop_reason) stop = d.delta.stop_reason;
      if (d.usage && d.usage.output_tokens != null) output = d.usage.output_tokens;
    } else if (type === 'error') {
      throw streamFail(d.error || d);
    }
  }
  if (stop === 'refusal') throw new AIError('refused', 'refusal');
  return finish(text, model, { input, output }, stop === 'max_tokens');
}

// ── Other AI (/chat/completions format) ─────────────────────────────────
async function callCompatible(cfg, o) {
  const headers = cfg.apiKey ? { authorization: 'Bearer ' + cfg.apiKey } : {};
  const body = {
    model: cfg.model,
    messages: [{ role: 'system', content: o.system }, { role: 'user', content: o.user }],
    max_tokens: o.maxTokens + THINKING_ROOM,
  };
  if (o.onText) body.stream = true;
  const res = await request(o, cfg.baseUrl + '/chat/completions', headers, body, { stream: !!o.onText });
  if (res.status !== 200) throw failFor(res.status, res.text, 'compatible', cfg.local);
  const usageOf = (u = {}) => ({ input: u.prompt_tokens || 0, output: u.completion_tokens || 0 });
  if (!res.stream) {
    const d = res.data || {};
    if (d.error) throw streamFail(d.error);
    const choice = (d.choices || [])[0];
    if (!choice) throw new AIError('empty');
    const msg = choice.message || {};
    if (choice.finish_reason === 'content_filter' || msg.refusal) throw new AIError('refused', msg.refusal || 'content_filter');
    const text = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content) ? msg.content.map((p) => (p && p.text) || '').join('') : '';
    return finish(stripThink(text), d.model || cfg.model, usageOf(d.usage), choice.finish_reason === 'length');
  }
  let text = '';
  let shown = '';
  let reason = '';
  let usage = {};
  for await (const ev of res.stream) {
    if (ev.raw === '[DONE]') break;
    const d = ev.data;
    if (!d) continue;
    if (d.error) throw streamFail(d.error);
    const choice = (d.choices || [])[0];
    if (choice) {
      const delta = choice.delta || {};
      if (delta.refusal) throw new AIError('refused', delta.refusal);
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        const now = stripThink(text);
        if (now && now !== shown) o.onText((shown = now));
      }
      if (choice.finish_reason) reason = choice.finish_reason;
    }
    if (d.usage) usage = d.usage;
  }
  if (reason === 'content_filter') throw new AIError('refused', reason);
  return finish(stripThink(text), cfg.model, usageOf(usage), reason === 'length');
}

// ── Company AI (own endpoint) ───────────────────────────────────────────
/**
 * Contract (POST, JSON):
 *   request:  { "system": "...", "prompt": "...", "max_tokens": 1500,   (20 to 3000, by task)
 *               "purpose": "reply|fast|learn", "model": "..." }
 *   header:   Authorization: Bearer <key>   (only when there is a key)
 *   response: { "text": "..." }  ("output", "content" or "response" also work, and so
 *             does a plain-text body). Optional: "usage": { input, output }.
 */
async function callCustom(cfg, o) {
  const headers = cfg.apiKey ? { authorization: 'Bearer ' + cfg.apiKey } : {};
  const res = await request(o, cfg.baseUrl, headers, {
    system: o.system,
    prompt: o.user,
    max_tokens: o.maxTokens,
    purpose: o.purpose,
    model: cfg.model || '',
  });
  if (res.status < 200 || res.status >= 300) throw failFor(res.status, res.text, 'custom', cfg.local);
  const d = res.data;
  let text = '';
  if (typeof d === 'string') {
    text = d;
  } else if (d && typeof d === 'object') {
    if (d.error) throw streamFail(typeof d.error === 'object' ? d.error : { message: String(d.error) });
    const v = d.text !== undefined ? d.text : d.output !== undefined ? d.output : d.content !== undefined ? d.content : d.response;
    text = typeof v === 'string' ? v : '';
  } else {
    text = res.text; // plain-text body
  }
  const obj = d && typeof d === 'object' ? d : {};
  const u = obj.usage && typeof obj.usage === 'object' ? obj.usage : {};
  return finish(stripThink(text), cfg.model || shortName(cfg), { input: Number(u.input) || 0, output: Number(u.output) || 0 }, obj.truncated === true);
}

const CALLS = { gemini: callGemini, openai: callOpenAI, anthropic: callAnthropic, compatible: callCompatible, custom: callCustom };

function resolve(cfg) {
  const p = PROVIDERS[cfg && cfg.provider];
  if (!p) throw new AIError('no_provider');
  const apiKey = String((cfg && cfg.apiKey) || '').trim();
  if (!apiKey && !p.keyOptional) throw new AIError('no_key');
  // a key copied masked (•••, …) or with a space inside: Chrome won't even send the request
  if (/[^\x21-\x7e]/.test(apiKey)) throw new AIError('key_format');
  let baseUrl = '';
  let local = false;
  if (p.needsUrl) {
    const u = checkBaseUrl(cfg.baseUrl, p.id);
    if (!u.ok) throw new AIError(u.error);
    baseUrl = u.url;
    local = u.local;
  }
  const model = String((cfg && cfg.model) || '').trim() || defaultModel(p.id);
  if (!model && p.id === 'compatible') throw new AIError('no_model');
  return { p, c: { provider: p.id, apiKey, model, baseUrl, local } };
}

/**
 * An address the person typed (Other AI, Company AI) only gets email after Chrome let Burnout
 * talk to it, which Test and save asks for, naming the site. Without that, a setting that
 * arrived some other way (a backup file) can't send anything there. The three main AIs are
 * allowed at install. Outside the extension (tests, previews) there's no permissions API.
 */
async function allowed(c) {
  const perms = globalThis.chrome && globalThis.chrome.permissions;
  if (!PROVIDERS[c.provider].needsUrl || !perms || typeof perms.contains !== 'function') return true;
  try {
    return await perms.contains({ origins: [originFor(c)] });
  } catch (e) {
    return false;
  }
}

/**
 * cfg = { provider, apiKey, model, baseUrl }. Returns { text, model, usage: {input, output}, truncated }.
 * system: a text, or [fixed part, thread part] (Claude keeps the fixed part cached).
 * onText(textSoFar) turns streaming on. purpose (reply | fast | learn) only goes to the own endpoint.
 * Throws AIError with a code the screen turns into text.
 */
export async function complete(cfg, { system, user, maxTokens = 2000, timeoutMs = 60000, fetchImpl, onText, purpose = 'fast' } = {}) {
  const { p, c } = resolve(cfg);
  if (!(await allowed(c))) throw new AIError('permission');
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const systemParts = [].concat(system || []).map((s) => String(s || '')).filter((s) => s.trim());
  const o = { system: systemParts.join('\n\n'), systemParts, user, maxTokens, timeoutMs, fetchImpl: f, purpose, kind: p.id, onText: null };
  const key = [p.id, c.model, c.baseUrl].join('|');
  if (typeof onText === 'function' && !p.noStream && !NO_STREAM.has(key)) {
    try {
      return await CALLS[p.id](c, { ...o, onText });
    } catch (e) {
      // a server that doesn't take streaming (a 400 with no explanation): repeat without it, and remember
      if (!(e instanceof AIError) || e.code !== 'bad_request') throw e;
      NO_STREAM.add(key);
    }
  }
  return CALLS[p.id](c, o);
}

/** Tests the configuration with a tiny question. Returns the model that answered. */
export async function testKey(cfg, opts = {}) {
  const r = await complete(cfg, { system: 'Reply with the single word OK.', user: 'ping', maxTokens: 20, timeoutMs: 30000, ...opts });
  return r.model;
}

/** Models of a compatible server (GET <address>/models). */
export async function listModels(cfg, { fetchImpl, timeoutMs = 15000 } = {}) {
  const u = checkBaseUrl(cfg && cfg.baseUrl, 'compatible');
  if (!u.ok) throw new AIError(u.error);
  const apiKey = String((cfg && cfg.apiKey) || '').trim();
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  const res = await request({ fetchImpl: f, timeoutMs, kind: 'compatible' }, u.url + '/models',
    apiKey ? { authorization: 'Bearer ' + apiKey } : {}, null, { method: 'GET' });
  if (res.status !== 200) throw failFor(res.status, res.text, 'compatible', u.local);
  const d = res.data || {};
  const list = Array.isArray(d.data) ? d.data : Array.isArray(d.models) ? d.models : Array.isArray(d) ? d : [];
  const ids = [...new Set(list.map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name)) || '')).filter(Boolean))];
  return ids.sort((a, b) => (a === 'openrouter/auto' ? -1 : b === 'openrouter/auto' ? 1 : a.localeCompare(b))).slice(0, 400);
}
