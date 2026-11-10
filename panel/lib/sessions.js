// Recorded sessions (deterministic replays), stored in the extension's IndexedDB.
import { db } from './media.js';
import { isSecretField, MASK } from './format.js';
import { findJwt } from './jwt.js';

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('sessions', mode);
    const req = fn(t.objectStore('sessions'));
    t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const saveSession = (s) => tx('readwrite', (st) => st.put(s));
export const getSession = (id) => tx('readonly', (st) => st.get(id));
export const deleteSession = (id) => tx('readwrite', (st) => st.delete(id));
export async function listSessions() {
  const all = (await tx('readonly', (st) => st.getAll())) || [];
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export function sessionSummary(s) {
  return {
    actions: s.actions.length,
    requests: s.requests.length,
    errors: [...new Set(s.errors.map((e) => e.fp))].length,
    duration: (s.endedAt || s.startedAt) - s.startedAt,
  };
}

// Unique errors in order of first appearance.
export function uniqueErrors(errors) {
  const seen = new Map();
  for (const e of errors) if (!seen.has(e.fp)) seen.set(e.fp, e);
  return [...seen.values()];
}

// The one-shot note the page hook reads at document_start.
export function replayBoot(session, { actions = session.actions, runId, fast = false, speed = 1, strict = false } = {}) {
  return {
    mode: 'replay',
    runId,
    sessionId: session.id,
    seed: session.seed,
    startedAt: session.startedAt,
    storage: session.storage,
    randoms: session.randoms,
    uuids: session.uuids,
    actions,
    fast,
    speed,
    strict,
    maxGap: fast ? 400 : 1500,
  };
}

// For sharing: removes tokens and secrets from storage and cookies (the network tape stays,
// so most replays still work; apps that validate tokens locally may need the real values).
export function redactSession(s) {
  const clean = (list) =>
    list.map(([k, v]) => {
      if (isSecretField(k) || findJwt(v)) return [k, MASK];
      return [k, v];
    });
  return {
    ...s,
    redacted: true,
    storage: { local: clean(s.storage.local || []), session: clean(s.storage.session || []) },
    cookies: (s.cookies || []).map((c) => (isSecretField(c.name) || /sid|sess|auth|token|jwt/i.test(c.name) || findJwt(c.value) ? { ...c, value: MASK } : c)),
  };
}

export function exportSession(s, { redact = true } = {}) {
  return JSON.stringify({ baton: 'session', version: 1, session: redact ? redactSession(s) : s });
}

export function importSession(text) {
  const json = JSON.parse(text);
  const s = json && json.baton === 'session' ? json.session : json;
  if (!s || !Array.isArray(s.actions) || !Array.isArray(s.requests) || !s.storage) throw new Error('Not a Baton session file');
  return { ...s, id: crypto.randomUUID(), importedAt: Date.now(), name: s.name ? `${s.name} (imported)` : 'Imported session' };
}
