import { h, clear, copyText, toast, timeStr } from '../lib/dom.js';
import { settings, shared, emit, getStored, setStored } from '../lib/settings.js';
import { evalInPage } from '../lib/page.js';
import { onFeed, onFeedStatus, startFeed } from '../lib/pagefeed.js';

let root, feedEl, noticeEl, runOut, snippetsEl, codeArea, nameInput, countEl;
let level = 'error';
let snippets = [];

function onConsoleEvents(list) {
  shared.consoleEntries.push(...list);
  if (shared.consoleEntries.length > 1000) shared.consoleEntries.splice(0, shared.consoleEntries.length - 1000);
  emit('console-changed');
  renderFeed();
}

function renderFeed() {
  const list = shared.consoleEntries.filter((e) => level === 'all' || e.level === level);
  countEl.textContent = `${shared.consoleEntries.filter((e) => e.level === 'error').length} errors · ${shared.consoleEntries.filter((e) => e.level === 'warn').length} warnings`;
  clear(
    feedEl,
    list.length
      ? list
          .slice()
          .reverse()
          .map((e) =>
            h(
              'div',
              { class: `log-item lv-${e.level}` },
              h(
                'div',
                { class: 'log-head' },
                h('span', { class: `badge lv-${e.level}` }, e.level),
                h('span', { class: 'muted mono small' }, timeStr(e.time)),
                h('span', { class: 'grow' }),
                h('button', { type: 'button', class: 'icon-btn', title: 'Copy', 'aria-label': 'Copy log entry', onclick: () => copyText(`[${e.level}] ${e.message}\n${e.stack || ''}`.trim()) }, '⧉'),
              ),
              h('div', { class: 'mono log-msg' }, e.message),
              e.stack ? h('details', {}, h('summary', {}, 'Stack'), h('pre', { class: 'code small' }, e.stack)) : null,
            ),
          )
      : h('div', { class: 'empty' }, level === 'error' ? 'No errors captured. Nice.' : 'Nothing captured yet.'),
  );
}

function show(value, isError = false) {
  runOut.className = `code run-out${isError ? ' error' : ''}`;
  runOut.textContent = value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function run(code) {
  if (!code.trim()) return;
  show('Running…');
  const id = `${Date.now()}-${Math.random()}`;
  // inspectedWindow.eval can't await promises, so expressions run in an async
  // wrapper that parks the settled value on window for us to collect.
  const wrapped = `window.__batonRun = undefined;
    (async () => { return (${code}
    ); })().then(
      v => { let out; try { out = JSON.parse(JSON.stringify(v === undefined ? null : v)); } catch { out = String(v); } window.__batonRun = { id: ${JSON.stringify(id)}, ok: true, v: out }; },
      e => { window.__batonRun = { id: ${JSON.stringify(id)}, ok: false, e: String((e && e.stack) || e) }; }
    ); true`;
  try {
    await evalInPage(wrapped);
  } catch {
    // Not a single expression (e.g. statements) — run it as-is, synchronously.
    try {
      return show(await evalInPage(code));
    } catch (err) {
      return show(err.message, true);
    }
  }
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const r = await evalInPage('window.__batonRun').catch(() => null);
    if (r && r.id === id) return r.ok ? show(r.v) : show(r.e, true);
    await new Promise((res) => setTimeout(res, 100));
  }
  show('Still running after 15s — check the page.', true);
}

function renderSnippets() {
  clear(
    snippetsEl,
    snippets.length
      ? snippets.map((s) =>
          h(
            'div',
            { class: 'snip' },
            h('button', { type: 'button', class: 'snip-name', title: s.code, onclick: () => (codeArea.value = s.code) }, s.name),
            h('button', { type: 'button', class: 'btn', onclick: () => ((codeArea.value = s.code), run(s.code)) }, 'Run'),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-btn',
                title: 'Delete',
                'aria-label': `Delete snippet ${s.name}`,
                onclick: async () => {
                  snippets = snippets.filter((x) => x.id !== s.id);
                  await setStored('snippets', snippets);
                  renderSnippets();
                },
              },
              '×',
            ),
          ),
        )
      : h('div', { class: 'muted small' }, 'Save snippets you run often — clear caches, log state, fake a user.'),
  );
}

export function mountConsole(container) {
  root = container;
  noticeEl = h('div', { class: 'notice', role: 'status' });
  feedEl = h('div', { class: 'feed' });
  countEl = h('span', { class: 'muted small' });
  runOut = h('pre', { class: 'code run-out', 'aria-live': 'polite' }, 'Result appears here.');
  snippetsEl = h('div', { class: 'snips' });
  codeArea = h('textarea', {
    class: 'input mono',
    rows: 5,
    placeholder: 'document.title\n// Ctrl/⌘ + Enter to run. await works too.',
    'aria-label': 'Code to run in the page',
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        run(codeArea.value);
      }
    },
  });
  nameInput = h('input', { class: 'input', placeholder: 'Snippet name', 'aria-label': 'Snippet name' });

  const levelSel = h('div', { class: 'seg', role: 'tablist' });
  const renderLevels = () =>
    clear(
      levelSel,
      [
        ['error', 'Errors'],
        ['warn', 'Warnings'],
        ['all', 'All'],
      ].map(([v, label]) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(level === v), class: level === v ? 'active' : '', onclick: () => ((level = v), renderLevels(), renderFeed()) }, label),
      ),
    );
  renderLevels();

  clear(
    root,
    h('div', { class: 'console-grid' },
      h(
        'section',
        { class: 'card feed-card' },
        h(
          'div',
          { class: 'section-head' },
          levelSel,
          countEl,
          h('span', { class: 'grow' }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn ghost',
              onclick: async () => {
                shared.consoleEntries.length = 0;
                
                emit('console-changed');
                renderFeed();
              },
            },
            'Clear',
          ),
        ),
        noticeEl,
        feedEl,
      ),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'section-head' }, h('h2', {}, 'Run in page')),
        codeArea,
        h(
          'div',
          { class: 'row-form' },
          h('button', { type: 'button', class: 'btn primary', onclick: () => run(codeArea.value) }, 'Run'),
          nameInput,
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: async () => {
                if (!codeArea.value.trim()) return toast('Write some code first');
                const name = nameInput.value.trim() || codeArea.value.trim().split('\n')[0].slice(0, 40);
                snippets = [...snippets, { id: crypto.randomUUID(), name, code: codeArea.value }];
                await setStored('snippets', snippets);
                nameInput.value = '';
                renderSnippets();
                toast('Snippet saved');
              },
            },
            'Save snippet',
          ),
        ),
        runOut,
        h('div', { class: 'section-head' }, h('h2', {}, 'Snippets')),
        snippetsEl,
      ),
    ),
  );

  chrome.devtools.network.onNavigated.addListener(() => {
    if (!settings.preserveLog) {
      shared.consoleEntries.length = 0;
      emit('console-changed');
      renderFeed();
    }
  });

  getStored('snippets', []).then((s) => {
    snippets = s;
    renderSnippets();
  });
  onFeed('console', onConsoleEvents);
  onFeedStatus((ok) => {
    noticeEl.textContent = ok ? '' : 'Baton isn’t hooked into this page yet. Reload the page (Baton hooks in at load). It can’t run on chrome:// pages.';
  });
  renderFeed();
  startFeed();
}
