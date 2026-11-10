// Polls the page hook's event buffer (window.__baton) and fans events out by kind:
// 'console', 'action', 'storage', 'mock'. One poll serves every tab.
import { evalInPage } from './page.js';

const listeners = new Map(); // kind -> Set(fn)
const statusListeners = new Set();
let lastSeq = 0;
let active = null; // true | false | null (unknown)
let timer = null;

export function onFeed(kind, fn) {
  if (!listeners.has(kind)) listeners.set(kind, new Set());
  listeners.get(kind).add(fn);
}

export function onFeedStatus(fn) {
  statusListeners.add(fn);
  if (active !== null) fn(active);
}

function setActive(v) {
  if (v === active) return;
  active = v;
  statusListeners.forEach((fn) => fn(v));
}

export function resetFeed() {
  lastSeq = 0;
}

export async function pollFeed() {
  try {
    const res = await evalInPage(`(() => {
      const b = window.__baton;
      if (!b) return null;
      return { seq: b.seq, events: b.events.filter(e => e.id > ${lastSeq}) };
    })()`);
    if (!res) return setActive(false);
    setActive(true);
    if (res.seq < lastSeq) {
      lastSeq = 0; // page reloaded: buffer restarted
      return;
    }
    lastSeq = res.seq;
    const byKind = new Map();
    for (const e of res.events) {
      if (!byKind.has(e.kind)) byKind.set(e.kind, []);
      byKind.get(e.kind).push(e);
    }
    for (const [kind, list] of byKind) (listeners.get(kind) || []).forEach((fn) => fn(list));
  } catch {
    /* navigating */
  }
}

export function startFeed() {
  if (timer) return;
  chrome.devtools.network.onNavigated.addListener(() => (lastSeq = 0));
  pollFeed();
  timer = setInterval(pollFeed, 1000);
}
