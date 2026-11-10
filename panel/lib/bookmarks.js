// Company bookmarks, shared by the DevTools panel and the toolbar popup.
const KEY = 'bookmarks';

export function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; // no javascript:/data: links
  } catch {
    return null;
  }
}

export async function loadBookmarks() {
  const r = await chrome.storage.local.get(KEY);
  return Array.isArray(r[KEY]) ? r[KEY] : [];
}

export function saveBookmarks(list) {
  return chrome.storage.local.set({ [KEY]: list });
}

export function groupBookmarks(list, query = '') {
  const q = query.trim().toLowerCase();
  const groups = new Map();
  for (const b of list) {
    if (q && !`${b.name} ${b.url} ${b.group || ''}`.toLowerCase().includes(q)) continue;
    const g = b.group || 'General';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(b);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// Accepts Baton's export ({bookmarks:[...]}) or a plain array of {name,url,group}.
export function parseImport(text) {
  const json = JSON.parse(text);
  const arr = Array.isArray(json) ? json : json.bookmarks;
  if (!Array.isArray(arr)) throw new Error('Expected a list of bookmarks');
  return arr
    .map((b) => ({ id: crypto.randomUUID(), name: String(b.name || b.title || '').trim(), url: normalizeUrl(b.url), group: String(b.group || b.folder || '').trim() }))
    .filter((b) => b.url)
    .map((b) => ({ ...b, name: b.name || new URL(b.url).hostname }));
}

export function mergeBookmarks(existing, incoming) {
  const seen = new Set(existing.map((b) => b.url));
  return [...existing, ...incoming.filter((b) => !seen.has(b.url) && seen.add(b.url))];
}

export function exportJson(list) {
  return JSON.stringify({ baton: 'bookmarks', bookmarks: list.map(({ name, url, group }) => ({ name, url, group })) }, null, 2);
}
