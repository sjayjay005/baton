import { h, clear, copyText, toast, timeStr } from '../lib/dom.js';
import { settings, shared, emit, on } from '../lib/settings.js';
import { onFeed } from '../lib/pagefeed.js';
import { mergeTimeline, stepsFromActions, timelineText, relTime } from '../lib/timeline.js';
import { updateMedia, getMedia, fmtDuration } from '../lib/media.js';

const MAX = 2000;
let root, listEl, countEl;
let windowSec = 0; // 0 = everything
const types = { action: true, network: true, console: true, storage: true, mock: true };
let renderTimer;

function keep(arr, list) {
  arr.push(...list);
  if (arr.length > MAX) arr.splice(0, arr.length - MAX);
}

export function timelineItems({ sinceMs = 0, from = 0, to = Infinity } = {}) {
  const start = sinceMs ? Date.now() - sinceMs : from;
  const inRange = (t) => t >= start && t <= to;
  return mergeTimeline({
    actions: shared.actions.filter((a) => inRange(a.time)),
    consoleEntries: shared.consoleEntries.filter((c) => inRange(c.time)),
    requests: shared.requests.filter((r) => inRange(Date.parse(r.entry.startedDateTime) || 0)),
    storage: shared.storageLog.filter((s) => inRange(s.time)),
    mocks: shared.mockHits.filter((m) => inRange(m.time)),
  });
}

export function reproSteps({ sinceMs = 5 * 60 * 1000 } = {}) {
  const since = Date.now() - sinceMs;
  return stepsFromActions(shared.actions.filter((a) => a.time >= since));
}

function render() {
  if (!listEl) return;
  const items = timelineItems({ sinceMs: windowSec * 1000 }).filter((i) => types[i.type]);
  countEl.textContent = `${items.length} events`;
  const first = items.length ? items[0].time : 0;
  clear(
    listEl,
    items.length
      ? items
          .slice(-500)
          .map((i) =>
            h(
              'div',
              { class: `tl-row tl-${i.type} lv-${i.level}` },
              h('span', { class: 'mono small muted tl-time', title: new Date(i.time).toLocaleString() }, relTime(i.time - first)),
              h('span', { 'aria-hidden': 'true' }, i.icon),
              h('span', { class: 'tl-text' }, i.text),
            ),
          )
      : h('div', { class: 'empty' }, windowSec ? `Nothing in the last ${windowSec}s.` : 'Use the page: clicks, typing, navigation, requests, errors and storage changes appear here in order. Reload the page if nothing shows.'),
  );
  listEl.scrollTop = listEl.scrollHeight;
}

function schedule() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 150);
}

// Attach the events that happened during a recording so it can be played back in sync.
export async function attachTimelineToRecording({ id, startedAt, endedAt }) {
  if (!id || !startedAt) return;
  const items = timelineItems({ from: startedAt - 500, to: (endedAt || Date.now()) + 500 });
  await updateMedia(id, { startedAt, timeline: items });
}

export function openSyncedPlayer(media) {
  const url = URL.createObjectURL(media.blob);
  const video = h('video', { src: url, controls: true, class: 'sp-video', 'aria-label': media.name });
  const items = media.timeline || [];
  const rows = items.map((i) =>
    h(
      'button',
      { type: 'button', class: `sp-row tl-${i.type} lv-${i.level}`, onclick: () => ((video.currentTime = Math.max(0, (i.time - media.startedAt) / 1000)), video.play()) },
      h('span', { class: 'mono small muted' }, fmtDuration(Math.max(0, i.time - media.startedAt))),
      h('span', { 'aria-hidden': 'true' }, i.icon),
      h('span', { class: 'tl-text' }, i.text),
    ),
  );
  const list = h('div', { class: 'sp-list' }, rows.length ? rows : h('div', { class: 'muted small pad' }, 'No events were captured during this recording.'));
  video.addEventListener('timeupdate', () => {
    const now = media.startedAt + video.currentTime * 1000;
    let cur = -1;
    items.forEach((i, idx) => i.time <= now && (cur = idx));
    rows.forEach((r, idx) => r.classList.toggle('now', idx === cur));
    if (cur >= 0) rows[cur].scrollIntoView({ block: 'nearest' });
  });
  const close = () => {
    URL.revokeObjectURL(url);
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const overlay = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Recording with timeline', onmousedown: (e) => e.target === overlay && close() },
    h(
      'div',
      { class: 'modal-box sp-box' },
      h('div', { class: 'section-head' }, h('h2', {}, `🎬 ${media.name}`), h('span', { class: 'muted small' }, 'Click an event to jump to that moment'), h('span', { class: 'grow' }), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '×')),
      h('div', { class: 'sp-body' }, video, list),
    ),
  );
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
}

export function mountTimeline(container) {
  root = container;
  listEl = h('div', { class: 'tl-list', 'aria-live': 'off' });
  countEl = h('span', { class: 'muted small' });
  const winSel = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Time window' });
  const renderWin = () =>
    clear(
      winSel,
      [
        [30, 'Last 30s'],
        [60, 'Last 60s'],
        [300, '5 min'],
        [0, 'All'],
      ].map(([v, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(windowSec === v), class: windowSec === v ? 'active' : '', onclick: () => ((windowSec = v), renderWin(), render()) }, l)),
    );
  renderWin();
  const typeBoxes = Object.entries({ action: '👆 Actions', network: '🌐 Network', console: '🔴 Console', storage: '🗄️ Storage', mock: '🎭 Mocks' }).map(([k, l]) => {
    const b = h('input', { type: 'checkbox', id: `tl-${k}`, checked: types[k] });
    b.addEventListener('change', () => ((types[k] = b.checked), render()));
    return h('label', { class: 'check', for: `tl-${k}` }, b, l);
  });

  clear(
    root,
    h(
      'div',
      { class: 'toolbar' },
      winSel,
      ...typeBoxes,
      countEl,
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn', onclick: () => copyText(timelineText(timelineItems({ sinceMs: windowSec * 1000 }).filter((i) => types[i.type]))) }, 'Copy'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn primary',
          onclick: () => {
            const steps = reproSteps({ sinceMs: (windowSec || 300) * 1000 });
            if (!steps.length) return toast('No user actions captured yet');
            emit('fill-steps', steps);
            emit('goto', 'report');
          },
        },
        '✨ Use as repro steps',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn ghost',
          onclick: () => {
            shared.actions.length = 0;
            shared.storageLog.length = 0;
            shared.mockHits.length = 0;
            render();
          },
        },
        'Clear',
      ),
    ),
    h('p', { class: 'muted small' }, '⏪ Instant replay: Baton keeps recording what happens on the page, so after a bug, pick “Last 60s” to see exactly what led up to it. No need to have pressed record.'),
    listEl,
  );

  onFeed('action', (list) => (keep(shared.actions, list), emit('timeline-changed'), schedule()));
  onFeed('storage', (list) => (keep(shared.storageLog, list), emit('storage-log', list), schedule()));
  onFeed('mock', (list) => (keep(shared.mockHits, list), schedule()));
  on('requests-changed', schedule);
  on('console-changed', schedule);
  chrome.devtools.network.onNavigated.addListener(() => {
    if (!settings.preserveLog) {
      // Keep actions across navigations: a repro usually spans pages.
    }
  });
  setInterval(() => windowSec && root.offsetParent !== null && render(), 2000);
  render();
}

export function showTimeline() {
  render();
}
