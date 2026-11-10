import { h, clear, toast, download, toggleSwitch, timeStr } from '../lib/dom.js';
import { emit, getStored, setStored } from '../lib/settings.js';
import { RULE_TYPES, MATCH_KINDS, METHODS, newRule, describeRule, validateRule, urlMatches, exportRules, importRules } from '../lib/rules.js';
import { onFeed } from '../lib/pagefeed.js';

let root, listEl, editorEl, statusEl, hitsEl, pauseBox;
let rules = [];
let paused = false;
let draft = null; // rule being edited (copy)
let editingId = null;
let status = { errors: [], userScripts: true };
const hits = new Map(); // ruleId -> count (page hook)
let dnrHits = {};
const recent = [];

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false })));
}

async function save() {
  await setStored('rules', rules);
  setTimeout(refreshStatus, 400); // the service worker re-syncs on change
}

async function refreshStatus() {
  const r = await send({ type: 'rules-status' });
  if (r.ok) status = r;
  renderList();
  renderStatus();
}

function renderStatus() {
  const jsRules = rules.some((r) => r.type === 'js' && r.enabled);
  clear(
    statusEl,
    paused ? h('div', { class: 'notice' }, '⏸ All rules are paused.') : null,
    jsRules && status.userScripts === false
      ? h(
          'div',
          { class: 'notice' },
          '🧩 To inject JS, Chrome needs one switch: open chrome://extensions → Baton → Details → turn on “Allow user scripts” (on Chrome older than 138, turn on Developer mode instead). ',
          h('button', { type: 'button', class: 'linkish', onclick: () => navigator.clipboard?.writeText(`chrome://extensions/?id=${chrome.runtime.id}`).then(() => toast('Link copied, paste it in the address bar')) }, 'Copy the link'),
        )
      : null,
  );
}

function ruleErrors(id) {
  return (status.errors || []).filter((e) => e.ruleId === id).map((e) => e.message);
}

function renderList() {
  clear(
    listEl,
    rules.length
      ? rules.map((r, i) => {
          const t = RULE_TYPES[r.type];
          const count = (hits.get(r.id) || 0) + (dnrHits[r.id] || 0);
          const errs = ruleErrors(r.id);
          return h(
            'div',
            { class: `rule${r.enabled ? '' : ' off'}${editingId === r.id ? ' editing' : ''}` },
            toggleSwitch(
              r.enabled,
              async (v) => {
                r.enabled = v;
                await save();
                renderList();
              },
              `Enable ${r.name || t.label}`,
            ),
            h('span', { class: 'rule-icon', 'aria-hidden': 'true' }, t.icon),
            h(
              'div',
              { class: 'rule-text' },
              h('strong', {}, r.name || t.label, h('span', { class: 'muted small' }, ` · ${t.label} · ${t.scope}`)),
              h('code', {}, describeRule(r)),
              errs.length ? h('div', { class: 'rule-err' }, errs.join(' ')) : null,
            ),
            count ? h('span', { class: 'hits', title: 'Matches this session' }, `${count} hit${count === 1 ? '' : 's'}`) : null,
            h('button', { type: 'button', class: 'icon-btn', title: 'Move up', 'aria-label': `Move ${r.name} up`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
            h('button', { type: 'button', class: 'icon-btn', title: 'Edit', 'aria-label': `Edit ${r.name}`, onclick: () => edit(r) }, '✎'),
            h('button', { type: 'button', class: 'icon-btn', title: 'Duplicate', 'aria-label': `Duplicate ${r.name}`, onclick: () => edit({ ...structuredClone(r), id: newRule().id, name: `${r.name || t.label} copy` }, true) }, '⧉'),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-btn',
                title: 'Delete',
                'aria-label': `Delete ${r.name}`,
                onclick: async () => {
                  rules = rules.filter((x) => x.id !== r.id);
                  if (editingId === r.id) closeEditor();
                  await save();
                  renderList();
                },
              },
              '×',
            ),
          );
        })
      : h('div', { class: 'empty' }, 'No rules yet. Mock an API, force a 500, slow things down, point prod at staging, or block a script. Tip: in Network, select a request and click “Mock this”.'),
  );
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= rules.length) return;
  [rules[i], rules[j]] = [rules[j], rules[i]];
  save();
  renderList();
}

function renderHits() {
  clear(
    hitsEl,
    recent.length
      ? recent
          .slice(-30)
          .reverse()
          .map((e) => h('div', { class: 'hit-row mono small' }, h('span', { class: 'muted' }, timeStr(e.time)), h('span', {}, RULE_TYPES[e.type]?.icon || ''), h('span', {}, e.method), h('span', { class: 'path' }, e.target), e.status ? h('span', { class: 'status st-warn' }, e.status) : null))
      : h('div', { class: 'muted small' }, 'Mocked and delayed fetch/XHR calls show up here. Mocked calls never reach the network, so they won’t appear in the Network tab.'),
  );
}

export function edit(rule, isNew = false) {
  draft = structuredClone(rule);
  editingId = isNew ? null : rule.id;
  renderEditor();
  renderList();
  editorEl.scrollIntoView({ block: 'nearest' });
}

function closeEditor() {
  draft = null;
  editingId = null;
  renderEditor();
  renderList();
}

function input(obj, key, attrs = {}) {
  const el = h(attrs.multiline ? 'textarea' : 'input', { class: `input${attrs.mono ? ' mono' : ''}`, ...attrs, multiline: null, mono: null });
  el.value = obj[key] ?? '';
  el.addEventListener('input', () => {
    obj[key] = attrs.type === 'number' ? Number(el.value) : el.value;
    if (attrs.onchanged) attrs.onchanged();
  });
  return el;
}

function select(obj, key, options, onchange) {
  const el = h('select', { class: 'input' }, options.map(([v, l]) => h('option', { value: v }, l)));
  el.value = obj[key];
  el.addEventListener('change', () => {
    obj[key] = el.value;
    if (onchange) onchange();
  });
  return el;
}

function renderEditor() {
  if (!draft) return clear(editorEl);
  const d = draft;
  const t = RULE_TYPES[d.type];
  const errBox = h('div', { class: 'rule-err' });
  const testInput = h('input', { class: 'input mono', placeholder: 'Paste a URL to test the match', 'aria-label': 'Test URL' });
  const testOut = h('span', { class: 'small' });
  const runTest = () => {
    if (!testInput.value) return (testOut.textContent = '');
    const ok = urlMatches(d.match, testInput.value);
    testOut.textContent = ok ? '✅ matches' : '❌ no match';
  };
  testInput.addEventListener('input', runTest);
  const field = (label, el, hint) => h('label', { class: 'field' }, h('span', {}, label), el, hint ? h('span', { class: 'muted small' }, hint) : null);
  const isPageLevel = d.type === 'css' || d.type === 'js';

  const typeSpecific = [];
  if (d.type === 'mock') {
    const bodyEl = input(d, 'body', { multiline: true, rows: 10, mono: true, 'aria-label': 'Response body' });
    typeSpecific.push(
      h('div', { class: 'grid-3' }, field('Status', input(d, 'status', { type: 'number', min: 200, max: 599 })), field('Content type', select(d, 'contentType', [['application/json', 'application/json'], ['text/plain', 'text/plain'], ['text/html', 'text/html'], ['application/xml', 'application/xml']])), field('Delay (ms)', input(d, 'delay', { type: 'number', min: 0, step: 100 }))),
      h('div', { class: 'row-form' }, ...[200, 201, 204, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503].map((s) => h('button', { type: 'button', class: 'chip', onclick: () => ((d.status = s), renderEditor()) }, s))),
      field('Response body', bodyEl),
      h(
        'div',
        { class: 'row-form' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn ghost',
            onclick: () => {
              try {
                d.body = JSON.stringify(JSON.parse(d.body), null, 2);
                bodyEl.value = d.body;
              } catch {
                toast('Body isn’t valid JSON');
              }
            },
          },
          'Format JSON',
        ),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => ((d.body = '{\n  "error": "Something went wrong",\n  "code": "INTERNAL"\n}'), (d.status = 500), renderEditor()) }, '💥 Error template'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => ((d.body = '[]'), (d.status = 200), renderEditor()) }, '🫙 Empty list'),
      ),
    );
  }
  if (d.type === 'delay') typeSpecific.push(field('Delay (ms)', input(d, 'delay', { type: 'number', min: 0, step: 100 }), 'Adds latency before the request is sent. Great for testing spinners and timeouts.'));
  if (d.type === 'redirect') typeSpecific.push(field('Send to URL', input(d, 'target', { placeholder: 'https://staging.example.com/api/v2/users', mono: true }), d.match.kind === 'regex' ? 'With regex you can use \\1, \\2… for capture groups.' : 'Applies to every request type (scripts, images, XHR…).'));
  if (d.type === 'host') typeSpecific.push(field('New host', input(d, 'target', { placeholder: 'staging.example.com or http://localhost:3000', mono: true }), 'Keeps the path and query, swaps host (and scheme/port if given).'));
  if (d.type === 'headers') {
    const rowsEl = h('div', { class: 'stack' });
    const renderRows = () =>
      clear(
        rowsEl,
        d.headers.map((hd, i) =>
          h(
            'div',
            { class: 'header-row' },
            select(hd, 'target', [['request', 'Request'], ['response', 'Response']]),
            select(hd, 'op', [['set', 'Set'], ['remove', 'Remove']], renderRows),
            input(hd, 'name', { placeholder: 'Header name', mono: true }),
            hd.op === 'remove' ? h('span', {}) : input(hd, 'value', { placeholder: 'Value', mono: true }),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove header row', onclick: () => (d.headers.splice(i, 1), renderRows()) }, '×'),
          ),
        ),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => (d.headers.push({ target: 'request', op: 'set', name: '', value: '' }), renderRows()) }, '+ Header'),
      );
    renderRows();
    typeSpecific.push(rowsEl);
  }
  if (d.type === 'css') typeSpecific.push(field('CSS', input(d, 'code', { multiline: true, rows: 8, mono: true, placeholder: '.cookie-banner { display: none !important; }' })));
  if (d.type === 'js') {
    typeSpecific.push(
      field('JavaScript', input(d, 'code', { multiline: true, rows: 8, mono: true, placeholder: "console.log('Hello from Baton');" }), 'Runs in the page on load. Needs Chrome’s “Allow user scripts” switch for Baton.'),
      field('Run at', select(d, 'runAt', [['document_start', 'Page start'], ['document_end', 'DOM ready'], ['document_idle', 'After load']])),
    );
  }

  clear(
    editorEl,
    h(
      'form',
      {
        class: 'card stack rule-editor',
        onsubmit: async (e) => {
          e.preventDefault();
          const errs = validateRule(d);
          if (errs.length) return (errBox.textContent = errs.join(' '));
          d.name = d.name.trim() || `${t.label} ${d.match.value.slice(0, 40)}`;
          const idx = rules.findIndex((r) => r.id === d.id);
          if (idx >= 0) rules[idx] = d;
          else rules.unshift(d);
          await save();
          toast(`${t.icon} Rule saved`);
          closeEditor();
        },
      },
      h('div', { class: 'section-head' }, h('h2', {}, `${t.icon} ${editingId ? 'Edit' : 'New'} rule: ${t.label}`), h('span', { class: 'muted small' }, `applies to ${t.scope}`)),
      h(
        'div',
        { class: 'grid-2' },
        field('Name', input(d, 'name', { placeholder: 'e.g. Checkout returns 500' })),
        field(
          'Type',
          select(
            d,
            'type',
            Object.entries(RULE_TYPES).map(([k, v]) => [k, `${v.icon} ${v.label}`]),
            () => {
              draft = { ...newRule(d.type), id: d.id, name: d.name, enabled: d.enabled, match: d.match };
              renderEditor();
            },
          ),
        ),
      ),
      h(
        'div',
        { class: isPageLevel ? 'grid-2' : 'grid-match' },
        field(isPageLevel ? 'Pages where' : 'Requests where', select(d.match, 'kind', Object.entries(MATCH_KINDS), runTest)),
        field('Value', input(d.match, 'value', { placeholder: isPageLevel ? 'example.com' : '/api/v1/checkout', mono: true, onchanged: runTest })),
        isPageLevel ? null : field('Method', select(d.match, 'method', METHODS.map((m) => [m, m]))),
      ),
      d.type === 'mock' || d.type === 'delay' ? field('GraphQL operation (optional)', input(d.match, 'graphql', { placeholder: 'GetCart', mono: true }), 'Only matches requests whose body has this operationName.') : null,
      h('div', { class: 'row-form' }, testInput, testOut),
      ...typeSpecific,
      errBox,
      h('div', { class: 'row-form' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save rule'), h('button', { type: 'button', class: 'btn ghost', onclick: closeEditor }, 'Cancel')),
    ),
  );
}

export function mountMocks(container) {
  root = container;
  listEl = h('div', { class: 'stack' });
  editorEl = h('div', {});
  statusEl = h('div', { class: 'stack' });
  hitsEl = h('div', { class: 'hits-list' });
  pauseBox = toggleSwitch(false, async (v) => {
    paused = !v;
    await setStored('rulesPaused', paused);
    renderStatus();
  }, 'Rules on');
  const typeSel = h('select', { class: 'input', 'aria-label': 'Rule type' }, Object.entries(RULE_TYPES).map(([k, v]) => h('option', { value: k }, `${v.icon} ${v.label}`)));
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    try {
      const incoming = importRules(await f.text());
      rules = [...rules, ...incoming];
      await save();
      renderList();
      toast(`Imported ${incoming.length} rules`);
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
    fileInput.value = '';
  });

  clear(
    root,
    h(
      'div',
      { class: 'toolbar' },
      typeSel,
      h('button', { type: 'button', class: 'btn primary', onclick: () => edit(newRule(typeSel.value), true) }, '+ New rule'),
      h('span', { class: 'grow' }),
      h('label', { class: 'check' }, pauseBox, 'Rules on'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => fileInput.click() }, 'Import'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => download('baton-rules.json', exportRules(rules), 'application/json') }, 'Export for team'),
      fileInput,
    ),
    statusEl,
    editorEl,
    h('section', { class: 'card stack' }, h('div', { class: 'section-head' }, h('h2', {}, 'Rules'), h('span', { class: 'muted small' }, 'Top rule wins when several match')), listEl),
    h('section', { class: 'card stack' }, h('div', { class: 'section-head' }, h('h2', {}, 'Recent mock hits')), hitsEl),
  );

  onFeed('mock', (list) => {
    for (const e of list) {
      hits.set(e.ruleId, (hits.get(e.ruleId) || 0) + 1);
      recent.push(e);
    }
    if (recent.length > 200) recent.splice(0, recent.length - 200);
    renderList();
    renderHits();
    emit('mock-hits', list);
  });
  setInterval(async () => {
    if (root.offsetParent === null) return;
    const r = await send({ type: 'dnr-matches', tabId: chrome.devtools.inspectedWindow.tabId });
    if (r.ok && JSON.stringify(r.counts) !== JSON.stringify(dnrHits)) {
      dnrHits = r.counts;
      renderList();
    }
  }, 3000);
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && c.rulesStatus) {
      status = c.rulesStatus.newValue || status;
      renderList();
      renderStatus();
    }
  });

  Promise.all([getStored('rules', []), getStored('rulesPaused', false)]).then(([r, p]) => {
    rules = r;
    paused = p;
    pauseBox.checked = !p;
    renderList();
    renderHits();
    refreshStatus();
  });
}

// Used by the Network tab's "Mock this".
export function mockFromRequest(entry, body) {
  const u = new URL(entry.request.url);
  const ct = (entry.response.content && entry.response.content.mimeType) || 'application/json';
  edit(
    newRule('mock', {
      name: `${entry.request.method} ${u.pathname}`,
      match: { kind: 'contains', value: u.origin + u.pathname, method: entry.request.method, graphql: '' },
      status: entry.response.status >= 200 ? entry.response.status : 200,
      contentType: /json/.test(ct) ? 'application/json' : /html/.test(ct) ? 'text/html' : /xml/.test(ct) ? 'application/xml' : 'text/plain',
      body: (() => {
        try {
          return JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          return body || '';
        }
      })(),
    }),
    true,
  );
  emit('goto', 'mocks');
}
