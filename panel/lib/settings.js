// Persistent settings + small cross-module state, backed by chrome.storage.local.
const DEFAULTS = { mode: 'dev', mask: true, preserveLog: false, apiOnly: true, open: {}, theme: 'auto', reloadOnToggle: false };

const listeners = new Set();
export const settings = { ...DEFAULTS };

export async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  Object.assign(settings, DEFAULTS, stored.settings || {});
  settings.open = { ...(settings.open || {}) };
  return settings;
}

export async function setSetting(key, value) {
  settings[key] = value;
  await chrome.storage.local.set({ settings: { ...settings } });
  listeners.forEach((fn) => fn(key, value));
}

export function onSettingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function getStored(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? fallback;
}

export function setStored(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

// Shared in-memory state between tabs (network + console feed the report).
export const shared = {
  requests: [], // { id, entry, bodyPromise }
  pinned: new Set(), // request ids pinned for the report
  consoleEntries: [],
  actions: [], // user actions from the page hook
  storageLog: [], // storage changes from the page hook
  mockHits: [],
  events: new EventTarget(),
};

export function emit(name, detail) {
  shared.events.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, fn) {
  shared.events.addEventListener(name, (e) => fn(e.detail));
}
