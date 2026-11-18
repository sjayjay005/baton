// Pull values out of a JSON payload with a glob-ish path, and find the Base64
// blobs in one without being told where they are.
//
//   data.file            exact keys (case-insensitive)
//   data.*.content       *  matches one key or array index
//   **.content           ** matches any depth, including none
//   items[0].blob        [n] indexes, [*] any index
//   *b64*                a * inside a segment globs part of the key
//   content              a single segment searches at any depth (so does *b64*)
//
// A leading `$.` is accepted so JSONPath habits keep working.

const MAX_DEPTH = 64;
const MAX_HITS = 500;

export function fmtPath(parts) {
  return parts.reduce((s, p) => (/^\d+$/.test(p) ? `${s}[${p}]` : s ? `${s}.${p}` : p), '');
}

export function parsePattern(pattern) {
  const segs = String(pattern)
    .trim()
    .replace(/^\$\.?/, '')
    .replace(/\[(\*|\d+)\]/g, '.$1')
    .split('.')
    .filter((s) => s !== '');
  // One segment on its own is almost always "find this key wherever it lives".
  if (segs.length === 1 && segs[0] !== '**') return ['**', segs[0]];
  return segs;
}

const segMatcher = (seg) => {
  if (!seg.includes('*')) {
    const want = seg.toLowerCase();
    return (key) => key.toLowerCase() === want;
  }
  const re = new RegExp(`^${seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
  return (key) => re.test(key);
};

const entries = (node) => (Array.isArray(node) ? node.map((v, i) => [String(i), v]) : node && typeof node === 'object' ? Object.entries(node) : null);

// Values whose path matches `pattern`, in document order.
export function pick(data, pattern, { limit = MAX_HITS } = {}) {
  const segs = parsePattern(pattern);
  if (!segs.length) return [];
  const matchers = segs.map((s) => (s === '**' ? '**' : segMatcher(s)));
  const hits = [];
  const seen = new Set();

  const walk = (node, si, path) => {
    if (hits.length >= limit || path.length > MAX_DEPTH) return;
    if (si === matchers.length) {
      hits.push({ path, value: node });
      return;
    }
    const m = matchers[si];
    if (m === '**') {
      walk(node, si + 1, path); // ** can match nothing
      const kids = entries(node);
      if (!kids || seen.has(node)) return;
      seen.add(node);
      for (const [k, v] of kids) walk(v, si, [...path, k]);
      seen.delete(node);
      return;
    }
    const kids = entries(node);
    if (!kids) return;
    for (const [k, v] of kids) if (m(k)) walk(v, si + 1, [...path, k]);
  };

  walk(data, 0, []);
  return hits;
}

// Does this string look like it could be a Base64 blob?
export function looksB64(value, { min = 64 } = {}) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (/^data:[^;,]*;base64,/i.test(s)) return true;
  const body = s.replace(/\s+/g, '');
  if (body.length < min) return false;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(body)) return false;
  // 4 Base64 chars carry 3 bytes, so a remainder of 1 can't be a whole blob.
  return body.replace(/=+$/, '').length % 4 !== 1;
}

// Every string in the payload that looks like Base64, longest first.
export function findB64(data, { min = 64, limit = 60 } = {}) {
  const hits = [];
  const seen = new Set();

  const walk = (node, path) => {
    if (hits.length >= limit || path.length > MAX_DEPTH) return;
    if (typeof node === 'string') {
      if (looksB64(node, { min })) hits.push({ path, value: node });
      return;
    }
    const kids = entries(node);
    if (!kids || seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of kids) walk(v, [...path, k]);
  };

  walk(data, []);
  return hits.sort((a, b) => b.value.length - a.value.length);
}

// JSON.parse, but only for things that are actually a JSON object or array.
export function parseJson(text) {
  const head = String(text).trimStart();
  if (!head.startsWith('{') && !head.startsWith('[')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
