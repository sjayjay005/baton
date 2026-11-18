// Guess a file type from its leading bytes, so a blob of Base64 can be saved
// with the right name and previewed the right way.
import { b64ToBytes } from './b64.js';

export const UNKNOWN = { mime: 'application/octet-stream', ext: 'bin', label: 'Unknown binary', kind: 'binary' };

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const at = (bytes, offset, sig) => sig.every((b, i) => b == null || bytes[offset + i] === b);

// Ordered: the first match wins, so container-brand checks come before generic ones.
const SIGS = [
  { sig: ascii('%PDF'), mime: 'application/pdf', ext: 'pdf', label: 'PDF', kind: 'pdf' },
  { sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: 'image/png', ext: 'png', label: 'PNG image', kind: 'image' },
  { sig: [0xff, 0xd8, 0xff], mime: 'image/jpeg', ext: 'jpg', label: 'JPEG image', kind: 'image' },
  { sig: ascii('GIF8'), mime: 'image/gif', ext: 'gif', label: 'GIF image', kind: 'image' },
  { sig: ascii('RIFF'), also: [8, ascii('WEBP')], mime: 'image/webp', ext: 'webp', label: 'WebP image', kind: 'image' },
  { sig: ascii('RIFF'), also: [8, ascii('WAVE')], mime: 'audio/wav', ext: 'wav', label: 'WAV audio', kind: 'audio' },
  { sig: ascii('BM'), mime: 'image/bmp', ext: 'bmp', label: 'BMP image', kind: 'image' },
  { sig: [0x00, 0x00, 0x01, 0x00], mime: 'image/x-icon', ext: 'ico', label: 'Icon', kind: 'image' },
  { sig: ascii('ID3'), mime: 'audio/mpeg', ext: 'mp3', label: 'MP3 audio (ID3)', kind: 'audio' },
  { sig: ascii('OggS'), mime: 'audio/ogg', ext: 'ogg', label: 'Ogg audio', kind: 'audio' },
  { sig: ascii('fLaC'), mime: 'audio/flac', ext: 'flac', label: 'FLAC audio', kind: 'audio' },
  { sig: [0x1a, 0x45, 0xdf, 0xa3], mime: 'video/webm', ext: 'webm', label: 'WebM / Matroska', kind: 'video' },
  { sig: ascii('%!PS'), mime: 'application/postscript', ext: 'ps', label: 'PostScript', kind: 'binary' },
  { sig: [0x1f, 0x8b], mime: 'application/gzip', ext: 'gz', label: 'Gzip archive', kind: 'binary' },
  { sig: ascii('PK'), mime: 'application/zip', ext: 'zip', label: 'Zip archive (or docx/xlsx/jar)', kind: 'binary' },
];

// `ftyp` boxes at offset 4 tell the MP4 family apart by brand.
const FTYP = [
  { brands: ['M4A ', 'M4B '], mime: 'audio/mp4', ext: 'm4a', label: 'MP4 audio', kind: 'audio' },
  { brands: ['qt  '], mime: 'video/quicktime', ext: 'mov', label: 'QuickTime video', kind: 'video' },
];

// An MP3 without an ID3 tag starts on a frame sync: 11 set bits, then an MPEG
// version and layer that aren't the reserved 0b00.
function mp3Frame(bytes) {
  if (bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return false;
  return (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) !== 0x00;
}

function asText(bytes) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096));
  if (text.includes('�') || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return null;
  return text;
}

export function sniff(bytes) {
  if (!bytes || !bytes.length) return { ...UNKNOWN, label: 'Empty', kind: 'empty' };
  for (const s of SIGS) {
    if (!at(bytes, 0, s.sig)) continue;
    if (s.also && !at(bytes, s.also[0], s.also[1])) continue;
    return { mime: s.mime, ext: s.ext, label: s.label, kind: s.kind };
  }
  if (at(bytes, 4, ascii('ftyp'))) {
    const brand = String.fromCharCode(...bytes.subarray(8, 12));
    const hit = FTYP.find((f) => f.brands.includes(brand));
    return hit ? { mime: hit.mime, ext: hit.ext, label: hit.label, kind: hit.kind } : { mime: 'video/mp4', ext: 'mp4', label: `MP4 video (${brand.trim()})`, kind: 'video' };
  }
  if (mp3Frame(bytes)) return { mime: 'audio/mpeg', ext: 'mp3', label: 'MP3 audio', kind: 'audio' };

  const text = asText(bytes);
  if (text == null) return UNKNOWN;
  const head = text.trimStart();
  if (/^<svg[\s>]/i.test(head) || (head.startsWith('<?xml') && /<svg[\s>]/i.test(head))) return { mime: 'image/svg+xml', ext: 'svg', label: 'SVG image', kind: 'image' };
  if (head.startsWith('{') || head.startsWith('[')) {
    try {
      JSON.parse(text);
      return { mime: 'application/json', ext: 'json', label: 'JSON', kind: 'text' };
    } catch {
      /* not whole JSON (or truncated): fall through to text */
    }
  }
  if (head.startsWith('<')) return { mime: 'text/html', ext: 'html', label: 'HTML / XML', kind: 'text' };
  return { mime: 'text/plain', ext: 'txt', label: 'Text', kind: 'text' };
}

// Decoded size of a Base64 string, without decoding it.
export function b64Size(input) {
  let s = String(input).trim();
  if (s.startsWith('data:')) s = s.slice(s.indexOf(',') + 1);
  s = s.replace(/\s+/g, '');
  const pad = (s.match(/=+$/) || [''])[0].length;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

// Sniff a Base64 string by decoding only its first few bytes: cheap enough to
// run over every candidate found in a payload.
export function sniffB64(input, { bytes = 64 } = {}) {
  let s = String(input).trim();
  if (s.startsWith('data:')) s = s.slice(s.indexOf(',') + 1);
  s = s.replace(/\s+/g, '').slice(0, Math.ceil(bytes / 3) * 4);
  s = s.slice(0, s.length - (s.length % 4));
  if (!s) return null;
  try {
    return sniff(b64ToBytes(s));
  } catch {
    return null;
  }
}

// The mime a data: URL declares, if the string is one.
export function dataUrlMime(input) {
  const m = /^data:([^;,]+)/.exec(String(input).trim());
  return m ? m[1] : null;
}
