// UTF-8 safe Base64 / Base64URL helpers.
export function utf8ToB64(text, { url = false } = {}) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const b64 = btoa(bin);
  return url ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64;
}

export function b64ToBytes(input) {
  let s = String(input).trim().replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (s.startsWith('data:')) s = s.slice(s.indexOf(',') + 1);
  if (/[^A-Za-z0-9+/=]/.test(s)) throw new Error('Not valid Base64');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function b64ToUtf8(input) {
  const bytes = b64ToBytes(input);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function looksBinary(text) {
  return /[\u0000-\u0008\u000E-\u001F]/.test(text) || text.includes('�');
}
