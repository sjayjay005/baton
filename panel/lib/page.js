// Run code in the inspected page (the tab DevTools is attached to).
export function evalInPage(expression) {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, exc) => {
      if (exc && (exc.isException || exc.isError)) {
        reject(new Error(exc.value || exc.description || 'Evaluation failed'));
      } else {
        resolve(result);
      }
    });
  });
}

export const storageObj = (area) => (area === 'session' ? 'sessionStorage' : 'localStorage');

export function readStorage() {
  return evalInPage(`(() => ({
    origin: location.origin,
    local: Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]),
    session: Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])
  }))()`);
}

// Baton's own edits bypass key locks and are logged as "baton" in the history.
const bypass = (code) => `(() => { window.__batonBypass = true; try { ${code}; } finally { window.__batonBypass = false; } return true; })()`;

export function setStorageItem(area, key, value) {
  return evalInPage(bypass(`${storageObj(area)}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`));
}

export function removeStorageItem(area, key) {
  return evalInPage(bypass(`${storageObj(area)}.removeItem(${JSON.stringify(key)})`));
}

export function importStorage(data, { replace = false } = {}) {
  return evalInPage(
    bypass(`const d = ${JSON.stringify(data)};
      if (${replace}) { localStorage.clear(); sessionStorage.clear(); }
      for (const [k, v] of Object.entries(d.localStorage || {})) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      for (const [k, v] of Object.entries(d.sessionStorage || {})) sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v))`),
  );
}

// Clears both storages except the given keys ({ local: [...], session: [...] }).
export function clearStorageExcept(keep) {
  return evalInPage(
    bypass(`const keep = ${JSON.stringify(keep)};
      for (const [area, s] of [['local', localStorage], ['session', sessionStorage]]) {
        const saved = (keep[area] || []).filter(k => s.getItem(k) !== null).map(k => [k, s.getItem(k)]);
        s.clear();
        saved.forEach(([k, v]) => s.setItem(k, v));
      }`),
  );
}

export function restoreStorage(snapshot) {
  return evalInPage(
    bypass(`const s = ${JSON.stringify(snapshot)};
      localStorage.clear(); sessionStorage.clear();
      for (const [k, v] of s.local || []) localStorage.setItem(k, v);
      for (const [k, v] of s.session || []) sessionStorage.setItem(k, v)`),
  );
}

export function pageUrl() {
  return evalInPage('location.href');
}

// Replays a request from the page (so cookies and origin match). Resolves with
// { status, statusText, timeMs, headers, body } or { error }.
export async function replayRequest({ method, url, headers, body }) {
  const id = `${Date.now()}-${Math.random()}`;
  await evalInPage(`(() => {
    window.__batonReplay = undefined;
    const t0 = performance.now();
    fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: ${JSON.stringify(headers)}, body: ${JSON.stringify(body ?? null)}, credentials: 'include' })
      .then(async r => { const text = await r.text(); window.__batonReplay = { id: ${JSON.stringify(id)}, status: r.status, statusText: r.statusText, timeMs: Math.round(performance.now() - t0), headers: [...r.headers].map(([name, value]) => ({ name, value })), body: text.slice(0, 500000) }; })
      .catch(e => { window.__batonReplay = { id: ${JSON.stringify(id)}, error: String(e) }; });
    return true;
  })()`);
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const r = await evalInPage('window.__batonReplay').catch(() => null);
    if (r && r.id === id) return r;
    await new Promise((res) => setTimeout(res, 150));
  }
  return { error: 'Timed out after 60s' };
}

export function readEnvironment() {
  return evalInPage(`({
    url: location.href,
    userAgent: navigator.userAgent,
    viewport: innerWidth + '×' + innerHeight,
    dpr: devicePixelRatio,
    language: navigator.language
  })`);
}

export function reloadPage() {
  chrome.devtools.inspectedWindow.reload();
}
