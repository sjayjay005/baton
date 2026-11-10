// Screenshots, recordings and GIFs, kept in IndexedDB (shared by the panel and the recorder window).
// Changes are announced on a BroadcastChannel so every open Baton page stays in sync.

const DB = 'baton';
const STORE = 'media';
export const channel = new BroadcastChannel('baton-media');
if (channel.unref) channel.unref(); // Node (tests): don't keep the process alive

let dbPromise;
export function db() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const KIND_ICON = { screenshot: '📸', recording: '🎬', gif: '🎞️', image: '🖼️', file: '📎' };

export function isImage(m) {
  return m.kind === 'screenshot' || m.kind === 'gif' || m.kind === 'image';
}

export async function addMedia(item) {
  const rec = { id: crypto.randomUUID(), createdAt: Date.now(), include: true, ...item };
  await tx('readwrite', (s) => s.put(rec));
  channel.postMessage({ type: 'changed' });
  return rec;
}

export async function updateMedia(id, patch) {
  const cur = await getMedia(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await tx('readwrite', (s) => s.put(next));
  channel.postMessage({ type: 'changed' });
  return next;
}

export function getMedia(id) {
  return tx('readonly', (s) => s.get(id));
}

export async function listMedia() {
  const all = (await tx('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteMedia(id) {
  await tx('readwrite', (s) => s.delete(id));
  channel.postMessage({ type: 'changed' });
}

export async function clearMedia() {
  await tx('readwrite', (s) => s.clear());
  channel.postMessage({ type: 'changed' });
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
