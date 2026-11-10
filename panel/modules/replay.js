// Replay tab: record a session, replay it deterministically, and shrink it to the
// smallest set of steps that still reproduces a bug (delta debugging).
import { h, clear, toast, download } from '../lib/dom.js';
import { emit, settings } from '../lib/settings.js';
import { listSessions, saveSession, deleteSession, sessionSummary, uniqueErrors, exportSession, importSession } from '../lib/sessions.js';
import { startRecording, stopRecording, recordingStatus, stageSession, clearStage, runReplay } from '../lib/replayer.js';
import { ddmin } from '../lib/ddmin.js';
import { addMedia, fmtDuration, stamp } from '../lib/media.js';

let root, recEl, listEl, runEl;
let sessions = [];
let recording = null; // { id, seed, url, cookies, startedAt }
let busy = false;
let abort = null;
let fastMode = true;
let strictMode = false;

const errBadge = (n) => h('span', { class: `jwt-chip ${n ? 'jwt-bad' : 'jwt-ok'}` }, n ? `${n} error${n === 1 ? '' : 's'}` : 'no errors');

async function refresh() {
  sessions = await listSessions();
  renderList();
}

// ---- Recording ----------------------------------------------------------------------
async function begin() {
  if (busy) return;
  try {
    clear(recEl, h('div', { class: 'muted small' }, 'Reloading the page to start a clean recording…'));
    recording = { ...(await startRecording()), startedAt: Date.now() };
    toast('● Recording. Use the page, then come back and stop.');
    renderRec();
  } catch (e) {
    recording = null;
    toast(e.message);
    renderRec();
  }
}

async function finishRec() {
  const raw = await stopRecording();
  const meta = recording;
  recording = null;
  if (!raw) {
    toast('Nothing was recorded (did the page reload or close?)');
    return renderRec();
  }
  const s = {
    ...raw,
    id: raw.id || crypto.randomUUID(),
    name: `${raw.title || new URL(raw.url).pathname} · ${new Date(raw.startedAt).toLocaleTimeString()}`,
    origin: new URL(raw.url).origin,
    cookies: meta ? meta.cookies : [],
    createdAt: Date.now(),
  };
  await saveSession(s);
  toast(`🔁 Session saved: ${s.actions.length} steps, ${s.requests.length} responses${s.ended === 'navigation' ? ' (stopped at a full page navigation)' : ''}`);
  renderRec();
  refresh();
}

let recTimer;
function renderRec() {
  clearInterval(recTimer);
  if (!recording) {
    return clear(
      recEl,
      h('div', { class: 'row-form' }, h('button', { type: 'button', class: 'btn primary', disabled: busy, onclick: begin }, '● Record a session'), h('span', { class: 'muted small' }, 'Reloads the page, then captures storage, cookies, every API response, clock, randomness and your clicks and typing, so the session can be replayed exactly.')),
    );
  }
  const stats = h('span', { class: 'mono small' }, 'starting…');
  clear(recEl, h('div', { class: 'row-form' }, h('span', { class: 'rec-live quick-btn btn' }, 'REC'), stats, h('span', { class: 'grow' }), h('button', { type: 'button', class: 'btn primary', onclick: finishRec }, '■ Stop & save')));
  recTimer = setInterval(async () => {
    const st = await recordingStatus();
    if (st) stats.textContent = `${fmtDuration(st.ms)} · ${st.actions} steps · ${st.requests} responses · ${st.errors} errors${st.truncated ? ' · size limit reached' : ''}`;
    else stats.textContent = 'page navigated, click Stop & save to keep what was captured';
  }, 1000);
}

// ---- Running ------------------------------------------------------------------------
function progressView(title) {
  const bar = h('progress', { max: 1, value: 0, class: 'progress', 'aria-label': title });
  const step = h('div', { class: 'muted small' }, 'Starting…');
  const box = h('section', { class: 'card stack' }, h('div', { class: 'section-head' }, h('h2', {}, title), h('span', { class: 'grow' }), h('button', { type: 'button', class: 'btn ghost', onclick: () => abort && abort.abort() }, 'Cancel')), bar, step);
  clear(runEl, box);
  return {
    update: (r) => {
      bar.max = Math.max(1, r.total);
      bar.value = r.done;
      step.textContent = `${r.done}/${r.total} · ${r.step}`;
    },
    text: (t) => (step.textContent = t),
    box,
  };
}

function compareView(session, r) {
  const want = uniqueErrors(session.errors);
  const got = new Set(r.errors.map((e) => e.fp));
  const extra = uniqueErrors(r.errors).filter((e) => !want.some((w) => w.fp === e.fp));
  const all = want.every((w) => got.has(w.fp));
  const failedSteps = r.log.filter((l) => !l.ok);
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: `replay-verdict ${want.length ? (all ? 'ok' : 'bad') : extra.length ? 'bad' : 'ok'}` }, want.length ? (all ? `✅ Reproduced: all ${want.length} recorded error${want.length === 1 ? '' : 's'} happened again` : `⚠️ Not reproduced: ${want.filter((w) => !got.has(w.fp)).length} of ${want.length} errors didn’t happen`) : extra.length ? '⚠️ Replay hit errors the recording didn’t have' : '✅ Replayed cleanly, same as the recording (no errors)'),
    want.length ? h('div', { class: 'stack' }, want.map((w) => h('div', { class: 'mono small' }, got.has(w.fp) ? '✓ ' : '✗ ', w.message.slice(0, 160)))) : null,
    extra.length ? h('details', {}, h('summary', {}, `New errors (${extra.length})`), extra.map((e) => h('div', { class: 'mono small' }, e.message.slice(0, 200)))) : null,
    h('div', { class: 'muted small' }, `${r.served} responses served from the recording · ${r.unmatched.length} went to the network${failedSteps.length ? ` · ${failedSteps.length} step${failedSteps.length === 1 ? '' : 's'} skipped` : ''}`),
    r.unmatched.length ? h('details', {}, h('summary', {}, 'Requests not in the recording'), h('pre', { class: 'code small' }, r.unmatched.join('\n'))) : null,
    failedSteps.length ? h('details', {}, h('summary', {}, 'Skipped steps'), failedSteps.map((l) => h('div', { class: 'small' }, `${l.i + 1}. ${session.actions[l.i]?.desc || ''}: ${l.note}`))) : null,
  );
}

async function guard(fn) {
  if (busy) return toast('Already running');
  busy = true;
  abort = new AbortController();
  renderList();
  try {
    await fn(abort.signal);
  } catch (e) {
    clear(runEl, h('section', { class: 'card' }, h('div', { class: 'error' }, e.message)));
  } finally {
    busy = false;
    abort = null;
    await clearStage();
    renderList();
  }
}

function replay(session, actions = session.actions, label = 'Replaying') {
  return guard(async (signal) => {
    const pv = progressView(`🔁 ${label}: ${session.name}`);
    await stageSession(session);
    const r = await runReplay(session, { actions, fast: fastMode, strict: strictMode, onProgress: pv.update, signal });
    clear(runEl, h('section', { class: 'card stack' }, h('div', { class: 'section-head' }, h('h2', {}, `🔁 ${label}: ${session.name}`)), compareView({ ...session, actions }, r)));
  });
}

function minimize(session, targetFp) {
  return guard(async (signal) => {
    const target = uniqueErrors(session.errors).find((e) => e.fp === targetFp);
    const pv = progressView(`🔬 Minimizing: ${session.name}`);
    await stageSession(session);
    const fails = async (subset) => {
      const r = await runReplay(session, { actions: subset, fast: true, strict: strictMode, signal, onProgress: (p) => pv.text(`${status.tests} replays · trying ${subset.length} of ${session.actions.length} steps · ${p.step}`) });
      return r.errors.some((e) => e.fp === targetFp);
    };
    const status = { tests: 0 };
    pv.text('Checking the bug reproduces with every step…');
    status.tests = 1;
    if (!(await fails(session.actions))) {
      throw new Error('The full replay didn’t reproduce that error, so it can’t be minimized. Try replaying at normal speed, or record again.');
    }
    const { result, tests } = await ddmin(session.actions, fails, {
      signal,
      onProgress: (p) => {
        status.tests = p.tests + 1;
        pv.box.querySelector('progress').removeAttribute('value');
        pv.text(`${status.tests} replays · smallest so far: ${p.size} steps`);
      },
    });
    renderMinimal(session, target, result, tests + 1);
  });
}

function renderMinimal(session, target, steps, tests) {
  const minimal = { ...session, id: crypto.randomUUID(), name: `${session.name} · minimal`, actions: steps, minimizedFrom: session.id, createdAt: Date.now() };
  const descs = steps.map((a) => a.desc || a.type);
  clear(
    runEl,
    h(
      'section',
      { class: 'card stack' },
      h('div', { class: 'section-head' }, h('h2', {}, '🔬 Minimal reproduction')),
      h('div', { class: 'replay-verdict ok' }, steps.length ? `${steps.length} of ${session.actions.length} steps still cause the bug (${tests} replays)` : `The bug happens on page load, no steps needed (${tests} replays)`),
      h('div', { class: 'mono small muted' }, `Error: ${target.message.slice(0, 200)}`),
      steps.length ? h('ol', { class: 'min-steps' }, descs.map((d) => h('li', {}, d))) : null,
      h(
        'div',
        { class: 'row-form' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => (emit('fill-steps', descs.length ? descs : ['Open the page']), emit('goto', 'report')) }, '✨ Use as repro steps'),
        h('button', { type: 'button', class: 'btn', onclick: async () => (await saveSession(minimal), toast('Saved as a new session'), refresh()) }, 'Save as session'),
        h('button', { type: 'button', class: 'btn', onclick: () => replay(minimal, steps, 'Replaying minimal') }, '▶ Replay it'),
        h('button', { type: 'button', class: 'btn', onclick: () => attach(minimal) }, '📎 Attach to bug report'),
      ),
    ),
  );
}

async function attach(session) {
  const blob = new Blob([exportSession(session, { redact: settings.mask })], { type: 'application/json' });
  await addMedia({ kind: 'file', name: `session-${stamp()}.baton-session.json`, mime: 'application/json', blob, size: blob.size });
  toast('📎 Session attached to the bug report. Devs import it in Replay to watch the bug happen.');
}

// ---- Sessions list ------------------------------------------------------------------
function renderList() {
  clear(
    listEl,
    sessions.length
      ? sessions.map((s) => {
          const sum = sessionSummary(s);
          const errs = uniqueErrors(s.errors);
          const targetSel = errs.length ? h('select', { class: 'input', 'aria-label': 'Error to minimize for' }, errs.map((e) => h('option', { value: e.fp }, e.message.slice(0, 90)))) : null;
          return h(
            'div',
            { class: 'session' },
            h(
              'div',
              { class: 'session-head' },
              h('strong', {}, s.name),
              errBadge(errs.length),
              s.redacted ? h('span', { class: 'jwt-chip jwt-warn', title: 'Tokens were removed before sharing; the app may see you as logged out' }, 'redacted') : null,
              s.ended === 'navigation' ? h('span', { class: 'jwt-chip', title: 'Recording stopped when the page fully navigated' }, 'ends at navigation') : null,
              h('span', { class: 'grow' }),
              h('span', { class: 'muted small' }, `${sum.actions} step${sum.actions === 1 ? '' : 's'} · ${sum.requests} response${sum.requests === 1 ? '' : 's'} · ${fmtDuration(sum.duration)} · ${new Date(s.startedAt).toLocaleString()}`),
            ),
            h('div', { class: 'muted small mono' }, s.url),
            h(
              'div',
              { class: 'row-form' },
              h('button', { type: 'button', class: 'btn primary', disabled: busy, onclick: () => replay(s) }, '▶ Replay'),
              targetSel ? [targetSel, h('button', { type: 'button', class: 'btn', disabled: busy || !s.actions.length, title: 'Find the fewest steps that still cause this error', onclick: () => minimize(s, targetSel.value) }, '🔬 Minimize')] : null,
              h('button', { type: 'button', class: 'btn ghost', onclick: () => (emit('fill-steps', s.actions.map((a) => a.desc || a.type)), emit('goto', 'report')) }, '✨ Steps'),
              h('button', { type: 'button', class: 'btn ghost', onclick: () => attach(s) }, '📎 Attach'),
              h('button', { type: 'button', class: 'btn ghost', onclick: () => download(`${(s.name || 'session').replace(/[^a-z0-9]+/gi, '-').slice(0, 50)}.baton-session.json`, exportSession(s, { redact: settings.mask }), 'application/json') }, '⤓ Export'),
              h(
                'button',
                {
                  type: 'button',
                  class: 'icon-btn',
                  'aria-label': `Delete ${s.name}`,
                  onclick: async () => {
                    await deleteSession(s.id);
                    refresh();
                  },
                },
                '×',
              ),
            ),
          );
        })
      : h('div', { class: 'empty' }, 'No sessions yet. Record one, or import a .baton-session.json a teammate sent you.'),
  );
}

export function mountReplay(container) {
  root = container;
  recEl = h('section', { class: 'card stack' });
  listEl = h('div', { class: 'stack' });
  runEl = h('div', {});
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    try {
      const s = importSession(await f.text());
      await saveSession(s);
      toast(`Imported “${s.name}”`);
      refresh();
    } catch (e) {
      toast(`Import failed: ${e.message}`);
    }
    fileInput.value = '';
  });
  const fastBox = h('input', { type: 'checkbox', id: 'rp-fast', checked: fastMode });
  fastBox.addEventListener('change', () => (fastMode = fastBox.checked));
  const strictBox = h('input', { type: 'checkbox', id: 'rp-strict', checked: strictMode });
  strictBox.addEventListener('change', () => (strictMode = strictBox.checked));

  clear(
    root,
    h(
      'div',
      { class: 'toolbar' },
      h('label', { class: 'check', for: 'rp-fast' }, fastBox, 'Fast replay (shrink pauses)'),
      h('label', { class: 'check', for: 'rp-strict' }, strictBox, 'Offline (block requests not in the recording)'),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => fileInput.click() }, 'Import session'),
      fileInput,
    ),
    recEl,
    runEl,
    h('section', { class: 'card stack' }, h('div', { class: 'section-head' }, h('h2', {}, 'Sessions')), listEl),
    h(
      'p',
      { class: 'muted small' },
      'How it works: replays restore the starting storage and cookies, serve every API response from the recording, pin the clock and random numbers, then repeat your clicks and typing. Minimize uses delta debugging to find the fewest steps that still cause the error. Limits: one page load per session (a full navigation ends it), no WebSockets or Web Workers, and secret fields (passwords) aren’t recorded.',
    ),
  );
  renderRec();
  refresh();
}

export function showReplay() {
  if (root) refresh();
}
