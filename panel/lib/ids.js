// Generate and take apart the IDs that turn up in APIs: UUID v4/v7, ULID and
// NanoID. Everything is local and uses crypto.getRandomValues.

const HEX = '0123456789abcdef';
// Crockford's base32: no I, L, O or U, so a ULID can't spell a typo.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const NANO_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes) => [...bytes].map((b) => HEX[b >> 4] + HEX[b & 15]).join('');

export function bytesToUuid(bytes) {
  const s = hex(bytes);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export function uuidV4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = rand(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return bytesToUuid(b);
}

// RFC 9562 v7: a 48-bit unix-ms prefix, so IDs sort by creation time. Within one
// millisecond a 12-bit counter in rand_a keeps a batch strictly increasing.
let v7Last = -1;
let v7Seq = 0;
export function uuidV7(now = Date.now()) {
  if (now === v7Last) v7Seq = (v7Seq + 1) & 0x0fff;
  else {
    v7Last = now;
    v7Seq = rand(1)[0] & 0x0f; // leave room to count up inside this ms
  }
  const b = rand(16);
  b[0] = Math.floor(now / 2 ** 40) & 0xff;
  b[1] = Math.floor(now / 2 ** 32) & 0xff;
  b[2] = Math.floor(now / 2 ** 24) & 0xff;
  b[3] = Math.floor(now / 2 ** 16) & 0xff;
  b[4] = Math.floor(now / 2 ** 8) & 0xff;
  b[5] = now & 0xff;
  b[6] = 0x70 | (v7Seq >> 8);
  b[7] = v7Seq & 0xff;
  b[8] = (b[8] & 0x3f) | 0x80;
  return bytesToUuid(b);
}

const base32Time = (ms) => {
  let out = '';
  for (let i = 0, t = ms; i < 10; i++, t = Math.floor(t / 32)) out = CROCKFORD[t % 32] + out;
  return out;
};

// The low 5 bits of a uniform byte are uniform over the 32-char alphabet.
const randomCrockford = (n) => [...rand(n)].map((b) => CROCKFORD[b & 31]).join('');

// Bump a Crockford string by one, right to left, for same-millisecond ULIDs.
function bumpBase32(s) {
  const chars = [...s];
  for (let i = chars.length - 1; i >= 0; i--) {
    const next = CROCKFORD.indexOf(chars[i]) + 1;
    if (next < 32) {
      chars[i] = CROCKFORD[next];
      return chars.join('');
    }
    chars[i] = CROCKFORD[0]; // carry
  }
  return null; // overflowed 80 bits of randomness in one ms: start over
}

let ulidLast = -1;
let ulidRand = '';
export function ulid(now = Date.now()) {
  if (now === ulidLast && ulidRand) ulidRand = bumpBase32(ulidRand) || randomCrockford(16);
  else {
    ulidLast = now;
    ulidRand = randomCrockford(16);
  }
  return base32Time(now) + ulidRand;
}

// Rejection sampling, so a custom alphabet whose length isn't a power of two
// still comes out uniform.
export function nanoId(size = 21, alphabet = NANO_ALPHABET) {
  const chars = [...new Set([...String(alphabet || '')])];
  if (chars.length < 2) throw new Error('A NanoID alphabet needs at least 2 different characters');
  if (!(size >= 1)) throw new Error('NanoID length must be at least 1');
  const mask = (2 << (31 - Math.clz32((chars.length - 1) | 1))) - 1;
  const step = Math.max(1, Math.ceil((1.6 * mask * size) / chars.length));
  let out = '';
  while (out.length < size) {
    for (const b of rand(step)) {
      const c = chars[b & mask];
      if (c !== undefined && (out += c).length === size) break;
    }
  }
  return out;
}

export const GENERATORS = {
  v4: { label: 'UUID v4', hint: 'Random. The usual GUID.', make: () => uuidV4() },
  v7: { label: 'UUID v7', hint: 'Time-ordered, so it sorts and indexes well.', make: () => uuidV7() },
  ulid: { label: 'ULID', hint: '26 chars, Crockford base32, time-ordered.', make: () => ulid() },
  nanoid: { label: 'NanoID', hint: 'Short and URL-safe. 21 chars by default.', make: (o = {}) => nanoId(o.size, o.alphabet) },
};

// ---- formatting ------------------------------------------------------------

export function formatId(id, { uppercase = false, hyphens = true, braces = false, quotes = false } = {}) {
  let s = String(id);
  if (!hyphens && UUID_RE.test(s)) s = s.replace(/-/g, '');
  if (uppercase) s = s.toUpperCase();
  if (braces) s = `{${s}}`;
  if (quotes) s = `"${s}"`;
  return s;
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

// '' | base64 | rfc7515 (base64url, unpadded) | url.
// UUIDs and ULIDs encode their 128 raw bits; anything else encodes its text.
export function encodeId(id, encoding) {
  if (!encoding) return id;
  if (encoding === 'url') return encodeURIComponent(id);
  const bytes = idBytes(id);
  const raw = b64(bytes || new TextEncoder().encode(id));
  if (encoding === 'rfc7515') return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return raw;
}

// The 16 bytes behind a UUID or ULID, or null if it isn't one.
export function idBytes(id) {
  const s = String(id).trim().replace(/^[{("']|["')}]$/g, '');
  const h = s.replace(/^urn:uuid:/i, '').replace(/-/g, '');
  if (/^[0-9a-f]{32}$/i.test(h)) return Uint8Array.from(h.match(/../g).map((p) => parseInt(p, 16)));
  if (/^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/i.test(s)) return ulidBytes(s.toUpperCase());
  return null;
}

// 26 Crockford chars carry 130 bits; the canonical ULID is the low 128.
function ulidBytes(s) {
  const bits = [];
  for (const c of s) {
    const v = CROCKFORD.indexOf(c);
    for (let i = 4; i >= 0; i--) bits.push((v >> i) & 1);
  }
  const out = new Uint8Array(16);
  const start = bits.length - 128;
  for (let i = 0; i < 128; i++) if (bits[start + i]) out[i >> 3] |= 128 >> (i & 7);
  return out;
}

// ---- decoding --------------------------------------------------------------

const VARIANTS = [
  [0x80, 0xc0, 'RFC 4122 / 9562 (the standard one)'],
  [0x00, 0x80, 'NCS, backwards compatible (legacy)'],
  [0xc0, 0xe0, 'Microsoft GUID (legacy)'],
  [0xe0, 0xe0, 'Reserved for the future'],
];

const VERSIONS = {
  1: 'v1 — time + MAC address',
  2: 'v2 — DCE security',
  3: 'v3 — name-based, MD5',
  4: 'v4 — random',
  5: 'v5 — name-based, SHA-1',
  6: 'v6 — v1 reordered to sort by time',
  7: 'v7 — unix time + random (sortable)',
  8: 'v8 — vendor-specific',
};

// 100-nanosecond ticks since 1582-10-15 -> epoch ms.
const GREGORIAN_OFFSET_MS = 12219292800000;
const iso = (ms) => (Number.isFinite(ms) && Math.abs(ms) < 8.64e15 ? new Date(ms).toISOString() : null);

export function decodeUuid(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'Nothing to decode' };
  const stripped = raw.replace(/^[{("']/, '').replace(/["')}]$/, '').replace(/^urn:uuid:/i, '');
  const h = stripped.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) {
    return { ok: false, error: /^[0-9a-f-]*$/i.test(stripped) ? `Expected 32 hex digits, got ${h.length}` : 'Not a UUID — expected hex digits with optional hyphens, braces or a urn:uuid: prefix' };
  }

  const bytes = Uint8Array.from(h.match(/../g).map((p) => parseInt(p, 16)));
  const hyphenated = UUID_RE.test(stripped);
  const out = {
    ok: true,
    canonical: bytesToUuid(bytes),
    hex: h,
    bytes,
    hyphenated,
    version: bytes[6] >> 4,
    versionLabel: VERSIONS[bytes[6] >> 4] || `v${bytes[6] >> 4} — unknown`,
    variantLabel: (VARIANTS.find(([v, mask]) => (bytes[8] & mask) === v) || [, , 'Unrecognised'])[2],
    notes: [],
  };
  if (h === '0'.repeat(32)) return { ...out, version: null, versionLabel: 'none — nil UUID', special: 'Nil UUID (all zeroes)', notes: ['Usually a placeholder for "no id".'] };
  if (h === 'f'.repeat(32)) return { ...out, version: null, versionLabel: 'none — max UUID', special: 'Max UUID (all ones)', notes: ['The highest possible UUID, handy as a sort sentinel.'] };

  if (out.version === 1 || out.version === 6) {
    const ticks =
      out.version === 1
        ? (BigInt(bytes[6] & 0x0f) << 56n) | (BigInt(bytes[7]) << 48n) | (BigInt(bytes[4]) << 40n) | (BigInt(bytes[5]) << 32n) | (BigInt(bytes[0]) << 24n) | (BigInt(bytes[1]) << 16n) | (BigInt(bytes[2]) << 8n) | BigInt(bytes[3])
        : (BigInt(bytes[0]) << 52n) |
          (BigInt(bytes[1]) << 44n) |
          (BigInt(bytes[2]) << 36n) |
          (BigInt(bytes[3]) << 28n) |
          (BigInt(bytes[4]) << 20n) |
          (BigInt(bytes[5]) << 12n) |
          (BigInt(bytes[6] & 0x0f) << 8n) |
          BigInt(bytes[7]);
    out.timestamp = Number(ticks / 10000n) - GREGORIAN_OFFSET_MS;
    out.date = iso(out.timestamp);
    out.clockSeq = ((bytes[8] & 0x3f) << 8) | bytes[9];
    out.node = [...bytes.slice(10)].map((b) => HEX[b >> 4] + HEX[b & 15]).join(':');
    out.nodeIsRandom = !!(bytes[10] & 0x01);
    out.notes.push(out.nodeIsRandom ? 'The node has the multicast bit set, so it is random rather than a real MAC address.' : 'The node looks like a real MAC address — v1 UUIDs can leak which machine made them.');
  }
  if (out.version === 7) {
    out.timestamp = bytes.slice(0, 6).reduce((n, b) => n * 256 + b, 0);
    out.date = iso(out.timestamp);
    out.counter = ((bytes[6] & 0x0f) << 8) | bytes[7];
    if (out.timestamp > Date.now() + 86400000) out.notes.push('The timestamp is in the future.');
  }
  if (out.version === 2) {
    out.localDomain = ['person (POSIX UID)', 'group (POSIX GID)', 'org'][bytes[9]] || `domain ${bytes[9]}`;
    out.localId = bytes.slice(0, 4).reduce((n, b) => n * 256 + b, 0);
  }
  if (out.version === 3 || out.version === 5) out.notes.push('Name-based: a hash of a namespace plus a name, so it has no timestamp and repeats for the same input.');
  if (out.version === 4) out.notes.push('122 random bits. There is no timestamp to read.');
  if (!hyphenated) out.notes.push('Given without hyphens; the canonical form is above.');
  return out;
}

export function decodeUlid(input) {
  const s = String(input || '')
    .trim()
    .toUpperCase();
  if (!s) return { ok: false, error: 'Nothing to decode' };
  if (s.length !== 26) return { ok: false, error: `A ULID is 26 characters, got ${s.length}` };
  const bad = [...s].find((c) => CROCKFORD.indexOf(c) === -1);
  if (bad) return { ok: false, error: `“${bad}” isn’t in Crockford base32 (I, L, O and U are excluded)` };
  if (s[0] > '7') return { ok: false, error: 'The timestamp overflows 48 bits (the first character must be 0–7)' };
  let timestamp = 0;
  for (const c of s.slice(0, 10)) timestamp = timestamp * 32 + CROCKFORD.indexOf(c);
  return { ok: true, canonical: s, timestamp, date: iso(timestamp), randomness: s.slice(10), uuid: bytesToUuid(ulidBytes(s)) };
}

// What did someone just paste?
export function identify(input) {
  const s = String(input || '')
    .trim()
    .replace(/^[{("']|["')}]$/g, '')
    .replace(/^urn:uuid:/i, '');
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s)) return 'uuid';
  if (/^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/i.test(s)) return 'ulid';
  // Hex with hyphens in roughly the right place is a UUID someone mistyped —
  // say so, rather than passing it off as a NanoID.
  if (/^[0-9a-f-]{8,40}$/i.test(s) && (s.match(/-/g) || []).length >= 2) return 'uuid';
  if (s && /^[A-Za-z0-9_-]+$/.test(s)) return 'nanoid';
  return 'unknown';
}

// NanoID has no structure to read, so describe its strength instead.
export function describeNanoId(input) {
  const s = String(input || '').trim();
  if (!s) return { ok: false, error: 'Nothing to decode' };
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return { ok: false, error: 'Contains characters outside the URL-safe NanoID alphabet' };
  return {
    ok: true,
    canonical: s,
    length: s.length,
    distinct: new Set([...s]).size,
    bits: Math.round(s.length * Math.log2(NANO_ALPHABET.length)),
    isDefaultLength: s.length === 21,
  };
}
