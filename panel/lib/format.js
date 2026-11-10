// Pure formatting helpers: cURL / fetch / Markdown export and secret masking.
// No browser APIs here so it can be unit-tested in Node.

export const MASK = '••••••••';

const SECRET_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$|token|secret|api[-_]?key|session/i;
const SECRET_FIELD_RE =
  /pass(word|wd)?$|^pwd$|secret|token|api[-_]?key|authorization|cookie|session|^otp$|^pin$|cvv|card[-_]?number|^ssn$/i;

// Headers Chrome adds that make a replayed cURL worse, not better.
const SKIP_HEADERS = new Set(['content-length', 'host', 'connection', 'accept-encoding']);

export function isSecretHeader(name) {
  return SECRET_HEADER_RE.test(name);
}

export function isSecretField(name) {
  return SECRET_FIELD_RE.test(String(name));
}

export function maskHeaderValue(name, value) {
  if (!isSecretHeader(name)) return value;
  const m = /^(Bearer|Basic|Token|Digest)\s+/i.exec(value || '');
  return m ? `${m[1]} ${MASK}` : MASK;
}

function maskDeep(v) {
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = isSecretField(k) && (typeof val !== 'object' || val === null) ? MASK : maskDeep(val);
    }
    return out;
  }
  return v;
}

export function tryParseJson(text) {
  if (typeof text !== 'string') return undefined;
  const t = text.trim();
  if (!t || !'{["'.includes(t[0])) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

// Masks secret fields in a JSON or form-encoded body. Returns the body unchanged otherwise.
export function maskBody(text, mimeType = '') {
  if (!text) return text;
  const json = tryParseJson(text);
  if (json !== undefined) return JSON.stringify(maskDeep(json));
  if (/x-www-form-urlencoded/i.test(mimeType) || /^[\w.%-]+=[^&]*(&[\w.%-]+=[^&]*)*$/.test(text.trim())) {
    try {
      const params = new URLSearchParams(text);
      let changed = false;
      for (const [k] of params) {
        if (isSecretField(k)) {
          params.set(k, MASK);
          changed = true;
        }
      }
      return changed ? params.toString().replace(/%E2%80%A2/g, '•') : text;
    } catch {
      return text;
    }
  }
  return text;
}

export function maskJsonValue(value) {
  return maskDeep(value);
}

export function prettyBody(text) {
  const json = tryParseJson(text);
  return json !== undefined ? JSON.stringify(json, null, 2) : text || '';
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function requestHeaders(entry, { mask = true } = {}) {
  return (entry.request.headers || [])
    .filter((h) => !h.name.startsWith(':') && !SKIP_HEADERS.has(h.name.toLowerCase()))
    .map((h) => ({ name: h.name, value: mask ? maskHeaderValue(h.name, h.value) : h.value }));
}

export function requestBody(entry, { mask = true } = {}) {
  const pd = entry.request.postData;
  if (!pd) return null;
  if (pd.text != null && pd.text !== '') {
    return { kind: 'raw', mimeType: pd.mimeType || '', text: mask ? maskBody(pd.text, pd.mimeType) : pd.text };
  }
  if (Array.isArray(pd.params) && pd.params.length) {
    const params = pd.params.map((p) => ({
      name: p.name,
      value: mask && isSecretField(p.name) ? MASK : p.value || '',
      fileName: p.fileName,
    }));
    return { kind: 'form', mimeType: pd.mimeType || '', params };
  }
  return null;
}

export function toCurl(entry, { mask = true } = {}) {
  const { method, url } = entry.request;
  const parts = [`curl ${shellQuote(url)}`];
  const body = requestBody(entry, { mask });
  if (method !== 'GET' || body) parts.push(`-X ${method}`);
  const isMultipart = body && body.kind === 'form' && /multipart/i.test(body.mimeType);
  for (const h of requestHeaders(entry, { mask })) {
    // curl sets its own multipart boundary
    if (isMultipart && h.name.toLowerCase() === 'content-type') continue;
    parts.push(`-H ${shellQuote(`${h.name}: ${h.value}`)}`);
  }
  if (body) {
    if (body.kind === 'raw') {
      parts.push(`--data-raw ${shellQuote(body.text)}`);
    } else if (isMultipart) {
      for (const p of body.params) {
        parts.push(`-F ${shellQuote(p.fileName ? `${p.name}=@${p.fileName}` : `${p.name}=${p.value}`)}`);
      }
    } else {
      const q = new URLSearchParams(body.params.map((p) => [p.name, p.value])).toString();
      parts.push(`--data-raw ${shellQuote(q)}`);
    }
  }
  return parts.join(' \\\n  ');
}

export function toFetch(entry, { mask = true } = {}) {
  const { method, url } = entry.request;
  const headers = {};
  for (const h of requestHeaders(entry, { mask })) headers[h.name] = h.value;
  const opts = { method, headers };
  const body = requestBody(entry, { mask });
  let bodyLine = '';
  if (body && body.kind === 'raw') {
    const json = tryParseJson(body.text);
    bodyLine = json !== undefined ? `JSON.stringify(${JSON.stringify(json, null, 2).replace(/\n/g, '\n  ')})` : JSON.stringify(body.text);
  } else if (body) {
    const q = new URLSearchParams(body.params.map((p) => [p.name, p.value])).toString();
    bodyLine = JSON.stringify(q);
  }
  let src = JSON.stringify(opts, null, 2);
  if (bodyLine) src = src.replace(/\n}$/, `,\n  "body": ${bodyLine}\n}`);
  return `await fetch(${JSON.stringify(url)}, ${src});`;
}

export function fence(text, lang = '') {
  let ticks = '```';
  while (text.includes(ticks)) ticks += '`';
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

export function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export function isFailed(entry) {
  const s = entry.response ? entry.response.status : 0;
  return s === 0 || s >= 400;
}

function truncate(text, max) {
  if (!text || text.length <= max) return text || '';
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

function langFor(text) {
  return tryParseJson(text) !== undefined ? 'json' : '';
}

// Markdown hand-off for a single request.
export function toMarkdown(entry, responseText, { mask = true, maxBody = 4000 } = {}) {
  const { method, url } = entry.request;
  const res = entry.response || {};
  const lines = [];
  lines.push(`### ${method} ${shortUrl(url)} → ${res.status || 'failed'} ${res.statusText || ''}`.trim());
  lines.push('');
  lines.push(`\`${url}\`${entry.time ? ` · ${Math.round(entry.time)} ms` : ''}`);
  lines.push('');
  lines.push('**cURL**');
  lines.push(fence(toCurl(entry, { mask }), 'bash'));
  const body = requestBody(entry, { mask });
  if (body) {
    const text =
      body.kind === 'raw'
        ? prettyBody(body.text)
        : body.params.map((p) => `${p.name}=${p.fileName ? `@${p.fileName}` : p.value}`).join('\n');
    lines.push('');
    lines.push('**Payload**');
    lines.push(fence(truncate(text, maxBody), langFor(text)));
  }
  if (responseText != null && responseText !== '') {
    let text = responseText;
    if (mask) {
      const json = tryParseJson(text);
      if (json !== undefined) text = JSON.stringify(maskJsonValue(json));
    }
    text = prettyBody(text);
    lines.push('');
    lines.push('**Response**');
    lines.push(fence(truncate(text, maxBody), langFor(text)));
  }
  return lines.join('\n');
}

export function maskStorageEntries(entries, { mask = true } = {}) {
  return entries.map(([k, v]) => {
    if (!mask) return [k, v];
    if (isSecretField(k)) return [k, MASK];
    const json = tryParseJson(v);
    if (json !== undefined && typeof json === 'object') return [k, JSON.stringify(maskJsonValue(json))];
    // Looks like a JWT
    if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(v || '')) return [k, MASK];
    return [k, v];
  });
}

// Full QA bug report.
export function buildReport({
  title = '',
  steps = '',
  expected = '',
  actual = '',
  env = null,
  requests = [],
  consoleEntries = [],
  storage = null,
  severity = '',
  attachments = [],
  timeline = '',
  mask = true,
  maxBody = 2000,
}) {
  const out = [];
  out.push(`## ${title.trim() || 'Bug report'}`);
  if (severity) {
    out.push('');
    out.push(`**Severity:** ${severity}`);
  }
  if (env) {
    out.push('');
    out.push('**Environment**');
    out.push(`- URL: ${env.url}`);
    out.push(`- Browser: ${env.userAgent}`);
    out.push(`- Viewport: ${env.viewport} @${env.dpr}x · Language: ${env.language}`);
    out.push(`- Captured: ${env.capturedAt}`);
  }
  if (steps.trim()) {
    out.push('');
    out.push('**Steps to reproduce**');
    steps
      .trim()
      .split('\n')
      .map((s) => s.replace(/^\s*(\d+[.)]|[-*])\s*/, '').trim())
      .filter(Boolean)
      .forEach((s, i) => out.push(`${i + 1}. ${s}`));
  }
  if (expected.trim()) {
    out.push('');
    out.push(`**Expected:** ${expected.trim()}`);
  }
  if (actual.trim()) {
    out.push('');
    out.push(`**Actual:** ${actual.trim()}`);
  }
  if (timeline) {
    out.push('');
    out.push('**Timeline (what happened, in order)**');
    out.push(fence(timeline));
  }
  if (consoleEntries.length) {
    out.push('');
    out.push(`**Console errors (${consoleEntries.length})**`);
    const text = consoleEntries
      .map((e) => `[${e.level}] ${e.message}${e.stack ? `\n${e.stack.split('\n').slice(0, 4).join('\n')}` : ''}`)
      .join('\n\n');
    out.push(fence(truncate(text, maxBody * 2)));
  }
  if (requests.length) {
    out.push('');
    out.push(`**Requests (${requests.length})**`);
    for (const r of requests) {
      out.push('');
      out.push(toMarkdown(r.entry, r.body, { mask, maxBody }).replace(/^### /, '#### '));
    }
  }
  if (storage) {
    const local = maskStorageEntries(storage.local || [], { mask });
    const session = maskStorageEntries(storage.session || [], { mask });
    out.push('');
    out.push('**Storage snapshot**');
    out.push(
      fence(
        truncate(JSON.stringify({ localStorage: Object.fromEntries(local), sessionStorage: Object.fromEntries(session) }, null, 2), maxBody * 2),
        'json',
      ),
    );
  }
  if (attachments.length) {
    const icon = { screenshot: '📸', recording: '🎬', gif: '🎞️', image: '🖼️' };
    out.push('');
    out.push(`**Attachments (${attachments.length})**`);
    for (const a of attachments) {
      if (a.sourceUrl && (a.kind === 'gif' || a.kind === 'image')) out.push(`![${a.name}](${a.sourceUrl})`);
      else out.push(`- ${icon[a.kind] || '📎'} ${a.name}${a.duration ? ` (${Math.round(a.duration / 1000)}s)` : ''}`);
    }
  }
  out.push('');
  out.push('_Captured with Baton_');
  return out.join('\n');
}

// ---- Boolean storage values ------------------------------------------------
const BOOL_FLIP = { true: 'false', false: 'true', 1: '0', 0: '1', True: 'False', False: 'True', TRUE: 'FALSE', FALSE: 'TRUE' };
const BOOL_ON = new Set(['true', '1', 'True', 'TRUE']);

export function isBoolValue(v) {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(BOOL_FLIP, v);
}
export function isBoolOn(v) {
  return BOOL_ON.has(v);
}
// Keeps the key's existing style: "1" ⇄ "0", "true" ⇄ "false", "TRUE" ⇄ "FALSE".
export function setBool(current, on) {
  if (!isBoolValue(current)) return on ? 'true' : 'false';
  return isBoolOn(current) === on ? current : BOOL_FLIP[current];
}

// Compact, token-friendly text for pasting into an AI assistant.
export function toAiText(items, { mask = true, maxBody = 1500 } = {}) {
  const min = (t) => {
    const j = tryParseJson(t);
    let s = j !== undefined ? JSON.stringify(mask ? maskJsonValue(j) : j) : String(t || '');
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > maxBody ? `${s.slice(0, maxBody)}… [+${s.length - maxBody} chars]` : s;
  };
  const NOISE = /^(accept|accept-language|user-agent|sec-|referer|origin|cache-control|pragma|priority|dnt|upgrade-insecure)/i;
  return items
    .map(({ entry, body }) => {
      const e = entry;
      const lines = [`${e.request.method} ${e.request.url} → ${e.response.status || 'failed'}${e.time ? ` (${Math.round(e.time)}ms)` : ''}`];
      const hs = requestHeaders(e, { mask }).filter((h) => !NOISE.test(h.name));
      if (hs.length) lines.push(`req headers: ${hs.map((h) => `${h.name}: ${h.value}`).join('; ')}`);
      const b = requestBody(e, { mask });
      if (b) lines.push(`req body: ${min(b.kind === 'raw' ? b.text : b.params.map((p) => `${p.name}=${p.value}`).join('&'))}`);
      if (body != null && body !== '') lines.push(`res body: ${min(body)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}
