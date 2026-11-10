// Drives recording and replay in the inspected tab. Talks to the page hook through
// inspectedWindow.eval and a one-shot sessionStorage "boot" note.
import { evalInPage } from './page.js';
import { replayBoot } from './sessions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: chrome.runtime.lastError?.message })));

async function waitForLoad(origin, timeout = 30000) {
  const until = Date.now() + timeout;
  await sleep(300);
  while (Date.now() < until) {
    const ok = await evalInPage(`location.origin === ${JSON.stringify(origin)} && document.readyState !== 'loading' && !!window.__baton`).catch(() => false);
    if (ok) return true;
    await sleep(200);
  }
  throw new Error('The page didn’t load in time');
}

// Leaves a boot note for the next document load, then navigates to `url`.
async function bootAndGo(boot, url) {
  const origin = new URL(url).origin;
  const here = await evalInPage('location.origin').catch(() => null);
  if (here !== origin) {
    await evalInPage(`location.href = ${JSON.stringify(url)}`).catch(() => {});
    await waitForLoad(origin);
  }
  await evalInPage(`(() => {
    window.__batonBypass = true;
    try { sessionStorage.setItem('__baton_boot', ${JSON.stringify(JSON.stringify(boot))}); } finally { window.__batonBypass = false; }
    location.replace(${JSON.stringify(url)});
    return true;
  })()`);
  await waitForLoad(origin);
}

export async function startRecording() {
  const url = await evalInPage('location.href');
  if (!/^https?:/.test(url)) throw new Error('Open the web page you want to record first.');
  const id = crypto.randomUUID();
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const ck = await send({ type: 'cookies-get', url });
  await bootAndGo({ mode: 'record', id, seed }, url);
  return { id, seed, url, cookies: ck.ok ? ck.cookies : [] };
}

export async function recordingStatus() {
  return evalInPage(`(() => {
    const r = window.__baton && window.__baton.rec;
    if (!r) return null;
    return { id: r.id, actions: r.actions.length, requests: r.requests.length, errors: r.errors.length, ms: Date.now() - r.startedAt, truncated: r.truncated };
  })()`).catch(() => null);
}

// Returns the raw recording (or the rescued one if the page navigated away).
export async function stopRecording() {
  const r = await evalInPage('window.__baton && window.__baton.stopRecording ? window.__baton.stopRecording() : null').catch(() => null);
  if (r) return r;
  return evalInPage(`(() => {
    const raw = sessionStorage.getItem('__baton_rec_rescue');
    if (!raw) return null;
    window.__batonBypass = true;
    try { sessionStorage.removeItem('__baton_rec_rescue'); } finally { window.__batonBypass = false; }
    return JSON.parse(raw);
  })()`).catch(() => null);
}

// Stage what every replay of this session needs: the network tape and cookies.
export async function stageSession(session) {
  await chrome.storage.local.set({ replayTape: { id: session.id, entries: session.requests.filter((r) => !r.dropped || r.error) } });
  if (session.cookies && session.cookies.length) await send({ type: 'cookies-restore', url: session.url, cookies: session.cookies });
}

export async function clearStage() {
  await chrome.storage.local.remove('replayTape');
}

// One replay run. Resolves with the page hook's report.
export async function runReplay(session, { actions = session.actions, fast = false, strict = false, onProgress = () => {}, signal } = {}) {
  const runId = crypto.randomUUID();
  await bootAndGo(replayBoot(session, { actions, runId, fast, strict }), session.url);
  const est = actions.reduce((m, a) => Math.max(m, a.t), 0) - (actions[0] ? actions[0].t : 0);
  const until = Date.now() + (fast ? Math.min(est, actions.length * 400) : Math.min(est, actions.length * 1500)) + 30000;
  while (Date.now() < until) {
    if (signal && signal.aborted) throw new Error('Cancelled');
    const r = await evalInPage(`(() => {
      const r = window.__baton && window.__baton.replay;
      if (!r || r.runId !== ${JSON.stringify(runId)}) return null;
      return { done: r.done, total: r.total, step: r.step, finished: r.finished, errors: r.errors, unmatched: r.unmatched, served: r.served, log: r.log };
    })()`).catch(() => null);
    if (r) {
      onProgress(r);
      if (r.finished) return r;
    }
    await sleep(250);
  }
  throw new Error('Replay timed out');
}
