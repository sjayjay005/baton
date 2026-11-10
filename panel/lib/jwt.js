// JWT decode, inspect and (HMAC) sign. Decoding never verifies signatures.
import { b64ToUtf8, utf8ToB64 } from './b64.js';

export const JWT_RE = /^[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*$/;

// Finds a JWT inside common wrappers: "Bearer x", quoted JSON strings, JSON objects with a token field.
export function findJwt(value) {
  if (!value) return null;
  let s = String(value).trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(s);
  if (bearer) s = bearer[1].trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (JWT_RE.test(s) && s.startsWith('eyJ')) return s;
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      for (const v of Object.values(obj)) if (typeof v === 'string' && v.startsWith('eyJ') && JWT_RE.test(v)) return v;
    } catch {
      /* not JSON */
    }
  }
  const m = /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/.exec(s);
  return m ? m[0] : null;
}

export function decodeJwt(token, now = Date.now()) {
  const parts = String(token).trim().split('.');
  if (parts.length !== 3) throw new Error('A JWT has three parts separated by dots');
  const header = JSON.parse(b64ToUtf8(parts[0]));
  const payload = JSON.parse(b64ToUtf8(parts[1]));
  const at = (k) => (typeof payload[k] === 'number' ? payload[k] * 1000 : null);
  const exp = at('exp');
  return {
    header,
    payload,
    signature: parts[2],
    issuedAt: at('iat'),
    notBefore: at('nbf'),
    expiresAt: exp,
    expired: exp !== null && exp <= now,
    expiresInMs: exp !== null ? exp - now : null,
  };
}

export function humanDuration(ms) {
  const abs = Math.abs(ms);
  const units = [
    ['d', 86400000],
    ['h', 3600000],
    ['m', 60000],
    ['s', 1000],
  ];
  const parts = [];
  let rest = abs;
  for (const [u, size] of units) {
    if (rest >= size && parts.length < 2) {
      parts.push(`${Math.floor(rest / size)}${u}`);
      rest %= size;
    }
  }
  return parts.join(' ') || '0s';
}

const HMAC = { HS256: 'SHA-256', HS384: 'SHA-384', HS512: 'SHA-512' };

// Signs header+payload. alg 'none' produces an unsigned token.
export async function signJwt(header, payload, secret = '') {
  const alg = header.alg || 'HS256';
  const head = utf8ToB64(JSON.stringify({ ...header, alg, typ: header.typ || 'JWT' }), { url: true });
  const body = utf8ToB64(JSON.stringify(payload), { url: true });
  const data = `${head}.${body}`;
  if (alg === 'none') return `${data}.`;
  const hash = HMAC[alg];
  if (!hash) throw new Error(`Baton can sign HS256/384/512 or “none”, not ${alg}.`);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  let bin = '';
  sig.forEach((b) => (bin += String.fromCharCode(b)));
  return `${data}.${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export async function verifyHmac(token, secret) {
  const [h, p, s] = token.split('.');
  const header = JSON.parse(b64ToUtf8(h));
  if (!HMAC[header.alg]) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: HMAC[header.alg] }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`)));
  let bin = '';
  sig.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === s;
}
