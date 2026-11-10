import { h, clear, copyText, toast, download } from '../lib/dom.js';
import { settings, setSetting, onSettingChange, shared, emit, on } from '../lib/settings.js';
import { toCurl, toFetch, toMarkdown, toAiText, prettyBody, isFailed, shortUrl, requestBody, maskHeaderValue, requestHeaders } from '../lib/format.js';
import { brunoCollection } from '../lib/bruno.js';
import { findJwt } from '../lib/jwt.js';
import { jwtChip } from '../lib/jwtview.js';
import { replayRequest } from '../lib/page.js';
import { mockFromRequest } from './mocks.js';

const MAX_REQUESTS = 1000;
const API_TYPES = new Set(['xhr', 'fetch', 'websocket', 'eventsource', 'ping', 'other']);
let nextId = 1;
let selectedId = null;
const checked = new Set();
const filters = { text: '', bodies: false, method: 'ALL', domain: 'ALL', status: 'ALL' };
let root, listEl, detailEl, countEl, domainSel, bulkEl, searchNote;
let searchToken = 0;

function readBody(entry) {
  return new Promise((resolve) => {
    if (typeof entry.getContent !== 'function') {
      resolve(entry.response && entry.response.content && entry.response.content.text != null ? entry.response.content.text : null);
      return;
    }
    entry.getContent((content, encoding) => {
      if (content == null) return resolve(null);
      if (encoding === 'base64') {
        const mime = (entry.response.content && entry.response.content.mimeType) || '';
        if (/json|text|xml|javascript|html|csv/i.test(mime)) {
          try {
            const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
            return resolve(new TextDecoder().decode(bytes));
          } catch {
            /* fall through */
          }
        }
        return resolve(`[binary ${mime || 'data'}, ${Math.round((content.length * 3) / 4)} bytes]`);
      }
      resolve(content);
    });
  });
}

function addEntry(entry) {
  const item = { id: nextId++, entry, bodyPromise: null, bodyText: undefined };
  item.body = () =>
    (item.bodyPromise ||= readBody(entry).then((t) => {
      item.bodyText = t;
      return t;
    }));
  shared.requests.push(item);
  if (shared.requests.length > MAX_REQUESTS) {
    const removed = shared.requests.splice(0, shared.requests.length - MAX_REQUESTS);
    removed.forEach((r) => (shared.pinned.delete(r.id), checked.delete(r.id)));
  }
  emit('requests-changed');
}

const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

function statusOk(s) {
  switch (filters.status) {
    case '2xx':
      return s >= 200 && s < 300;
    case '3xx':
      return s >= 300 && s < 400;
    case '4xx':
      return s >= 400 && s < 500;
    case '5xx':
      return s >= 500;
    case 'failed':
      return !s || s >= 400;
    default:
      return true;
  }
}

// Synchronous filters (everything except body search).
function baseFiltered() {
  return shared.requests.filter((r) => {
    const e = r.entry;
    if (settings.apiOnly && e._resourceType && !API_TYPES.has(e._resourceType)) return false;
    if (filters.method !== 'ALL' && e.request.method !== filters.method) return false;
    if (filters.domain !== 'ALL' && host(e.request.url) !== filters.domain) return false;
    if (!statusOk(e.response.status)) return false;
    return true;
  });
}

function textMatch(r, q) {
  const e = r.entry;
  if (`${e.request.method} ${e.request.url} ${e.response.status}`.toLowerCase().includes(q)) return 'url';
  if (!filters.bodies) return null;
  const pd = e.request.postData;
  if (pd && (pd.text || '').toLowerCase().includes(q)) return 'request body';
  if (typeof r.bodyText === 'string' && r.bodyText.toLowerCase().includes(q)) return 'response';
  return null;
}

let lastVisible = [];
async function renderList() {
  const token = ++searchToken;
  let rows = baseFiltered();
  const q = filters.text.trim().toLowerCase();
  const where = new Map();
  if (q) {
    if (filters.bodies) {
      const missing = rows.filter((r) => r.bodyText === undefined);
      if (missing.length) {
        searchNote.textContent = `Searching ${missing.length} response bodies…`;
        await Promise.all(missing.map((r) => r.body()));
        if (token !== searchToken) return;
      }
    }
    rows = rows.filter((r) => {
      const m = textMatch(r, q);
      if (m && m !== 'url') where.set(r.id, m);
      return !!m;
    });
  }
  searchNote.textContent = '';
  lastVisible = rows;
  countEl.textContent = `${rows.length} / ${shared.requests.length}`;
  renderDomains();
  renderBulk();
  clear(
    listEl,
    rows.length
      ? rows.map((r) => {
          const e = r.entry;
          const t = e.time || 0;
          const box = h('input', { type: 'checkbox', class: 'row-check', checked: checked.has(r.id), 'aria-label': `Select ${e.request.method} ${shortUrl(e.request.url)}` });
          box.addEventListener('change', () => {
            if (box.checked) checked.add(r.id);
            else checked.delete(r.id);
            renderBulk();
          });
          return h(
            'div',
            { class: `req-row${r.id === selectedId ? ' selected' : ''}`, role: 'listitem' },
            box,
            h(
              'button',
              { type: 'button', class: 'req-main', onclick: () => select(r.id), title: e.request.url },
              h('span', { class: `method m-${e.request.method.toLowerCase()}` }, e.request.method),
              h('span', { class: 'path' }, shortUrl(e.request.url)),
              where.has(r.id) ? h('span', { class: 'match-tag' }, `in ${where.get(r.id)}`) : null,
              shared.pinned.has(r.id) ? h('span', { class: 'pin', title: 'In report' }, '●') : null,
              h('span', { class: `status ${statusClass(e.response.status)}` }, e.response.status || 'ERR'),
              h('span', { class: `time${t >= 1000 ? ' slow-2' : t >= 500 ? ' slow-1' : ''}`, title: t >= 500 ? 'Slow request' : '' }, t ? `${Math.round(t)}ms` : ''),
            ),
          );
        })
      : h('div', { class: 'empty' }, shared.requests.length ? 'No requests match the filters.' : 'Waiting for requests… reload the page to capture everything.'),
  );
}

function renderDomains() {
  const domains = [...new Set(shared.requests.map((r) => host(r.entry.request.url)).filter(Boolean))].sort();
  const current = filters.domain;
  const want = ['ALL', ...domains].join('|');
  if (domainSel.dataset.list === want) return;
  domainSel.dataset.list = want;
  clear(domainSel, h('option', { value: 'ALL' }, 'All domains'), domains.map((d) => h('option', { value: d }, d)));
  domainSel.value = domains.includes(current) ? current : 'ALL';
}

function selectedItems() {
  return shared.requests.filter((r) => checked.has(r.id));
}

function renderBulk() {
  const items = selectedItems();
  const all = lastVisible.length > 0 && lastVisible.every((r) => checked.has(r.id));
  const allBox = h('input', { type: 'checkbox', checked: all, 'aria-label': 'Select all visible requests' });
  allBox.addEventListener('change', () => {
    lastVisible.forEach((r) => (allBox.checked ? checked.add(r.id) : checked.delete(r.id)));
    renderList();
  });
  const withBodies = async () => Promise.all(items.map(async (r) => ({ entry: r.entry, body: await r.body() })));
  clear(
    bulkEl,
    h('label', { class: 'check' }, allBox, items.length ? `${items.length} selected` : 'Select'),
    items.length
      ? [
          h('button', { type: 'button', class: 'btn', onclick: () => copyText(items.map((r) => toCurl(r.entry, { mask: settings.mask })).join('\n\n')) }, 'Copy cURL'),
          h('button', { type: 'button', class: 'btn', onclick: async () => copyText(toAiText(await withBodies(), { mask: settings.mask })) }, '🤖 Copy for AI'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: () => {
                const name = `Baton ${host(items[0].entry.request.url) || 'export'}`;
                const { zipBytes, folder } = brunoCollection(items.map((r) => r.entry), { name, mask: settings.mask });
                download(`${folder}.zip`, zipBytes, 'application/zip');
                toast('🐶 Bruno collection downloaded. Unzip it, then Bruno → Open Collection.');
              },
            },
            '🐶 Export to Bruno',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: () => {
                items.forEach((r) => shared.pinned.add(r.id));
                emit('requests-changed');
                toast(`Added ${items.length} to the bug report`);
              },
            },
            'Add to report',
          ),
          h('button', { type: 'button', class: 'btn ghost', onclick: () => (checked.clear(), renderList()) }, 'Clear selection'),
        ]
      : h('span', { class: 'muted small' }, 'Tick requests to copy them together, export to Bruno, or add them to a bug report.'),
  );
}

function statusClass(s) {
  if (!s || s >= 500) return 'st-err';
  if (s >= 400) return 'st-warn';
  if (s >= 300) return 'st-redirect';
  return 'st-ok';
}

function kvTable(pairs) {
  if (!pairs.length) return h('div', { class: 'muted' }, 'None');
  return h(
    'table',
    { class: 'kv' },
    h('tbody', {}, pairs.map(([k, v, raw]) => {
      const jwt = findJwt(raw ?? v);
      return h('tr', {}, h('th', {}, k), h('td', {}, v, jwt ? jwtChip(jwt, k) : null));
    })),
  );
}

const FORBIDDEN = /^(cookie|host|content-length|origin|referer|user-agent|accept-encoding|connection|sec-|proxy-|:)/i;

function replayPanel(e) {
  const method = h('select', { class: 'input', 'aria-label': 'Replay method' }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map((m) => h('option', { value: m }, m)));
  method.value = e.request.method;
  const url = h('input', { class: 'input mono grow', 'aria-label': 'Replay URL' });
  url.value = e.request.url;
  const headers = h('textarea', { class: 'input mono', rows: 4, 'aria-label': 'Replay headers, one per line' });
  headers.value = (e.request.headers || []).filter((x) => !FORBIDDEN.test(x.name)).map((x) => `${x.name}: ${x.value}`).join('\n');
  const body = h('textarea', { class: 'input mono', rows: 4, 'aria-label': 'Replay body' });
  const pd = e.request.postData;
  body.value = pd && pd.text ? prettyBody(pd.text) : '';
  const out = h('div', { class: 'stack' });
  const send = async () => {
    clear(out, h('div', { class: 'muted small' }, 'Sending…'));
    let b = body.value;
    try {
      b = JSON.stringify(JSON.parse(b)); // send compact JSON like the app did
    } catch {
      /* raw */
    }
    const hs = {};
    headers.value
      .split('\n')
      .map((l) => /^([^:]+):\s?(.*)$/.exec(l.trim()))
      .filter(Boolean)
      .forEach(([, k, v]) => (hs[k.trim()] = v));
    const r = await replayRequest({ method: method.value, url: url.value, headers: hs, body: ['GET', 'HEAD'].includes(method.value) ? null : b || null });
    if (r.error) return clear(out, h('div', { class: 'error' }, `Replay failed: ${r.error}. CORS rules of the page apply.`));
    const was = e.response.status;
    clear(
      out,
      h('div', { class: 'detail-head' }, h('span', { class: `status ${statusClass(r.status)}` }, `${r.status} ${r.statusText}`), h('span', { class: 'muted small' }, `${r.timeMs}ms · was ${was || 'failed'}${e.time ? ` in ${Math.round(e.time)}ms` : ''}`), r.status !== was ? h('span', { class: 'jwt-chip jwt-warn' }, 'status changed') : h('span', { class: 'jwt-chip jwt-ok' }, 'same status')),
      h('pre', { class: 'code' }, prettyBody(r.body).slice(0, 100000) || '(empty)'),
    );
  };
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'row-form' }, method, url),
    h('label', { class: 'field' }, h('span', {}, 'Headers (cookies are sent automatically by the browser)'), headers),
    h('label', { class: 'field' }, h('span', {}, 'Body'), body),
    h('div', { class: 'row-form' }, h('button', { type: 'button', class: 'btn primary', onclick: send }, '↻ Send from the page')),
    out,
  );
}

async function renderDetail() {
  const item = shared.requests.find((r) => r.id === selectedId);
  if (!item) {
    clear(detailEl, h('div', { class: 'empty' }, 'Select a request to inspect, replay, mock or share it.'));
    return;
  }
  const e = item.entry;
  const mask = settings.mask;
  const headerPairs = (list) => (list || []).filter((x) => !x.name.startsWith(':')).map((x) => [x.name, mask ? maskHeaderValue(x.name, x.value) : x.value, x.value]);
  const body = requestBody(e, { mask });
  const responsePre = h('pre', { class: 'code' }, 'Loading…');
  const pinned = shared.pinned.has(item.id);
  const replayBox = h('div', {});

  clear(
    detailEl,
    h(
      'div',
      { class: 'detail-head' },
      h('span', { class: `method m-${e.request.method.toLowerCase()}` }, e.request.method),
      h('span', { class: 'detail-url', title: e.request.url }, e.request.url),
      h('span', { class: `status ${statusClass(e.response.status)}` }, `${e.response.status || 'ERR'} ${e.response.statusText || ''}`),
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => copyText(toCurl(e, { mask: settings.mask })) }, 'Copy cURL'),
      h('button', { type: 'button', class: 'btn', onclick: () => copyText(toFetch(e, { mask: settings.mask })) }, 'Copy fetch'),
      h('button', { type: 'button', class: 'btn', onclick: async () => copyText(toAiText([{ entry: e, body: await item.body() }], { mask: settings.mask })) }, '🤖 Copy for AI'),
      h('button', { type: 'button', class: 'btn', onclick: () => clear(replayBox, replayPanel(e)) }, '↻ Replay'),
      h('button', { type: 'button', class: 'btn', onclick: async () => mockFromRequest(e, await item.body()) }, '🎭 Mock this'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: () => {
            if (shared.pinned.has(item.id)) shared.pinned.delete(item.id);
            else shared.pinned.add(item.id);
            emit('requests-changed');
            toast(shared.pinned.has(item.id) ? 'Added to report' : 'Removed from report');
            renderDetail();
          },
        },
        pinned ? 'Remove from report' : 'Add to report',
      ),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => copyText(toMarkdown(e, await item.body(), { mask: settings.mask })) }, 'Pass the baton'),
    ),
    replayBox,
    h(
      'details',
      { open: true },
      h('summary', {}, 'General'),
      kvTable([
        ['URL', e.request.url],
        ['Method', e.request.method],
        ['Status', `${e.response.status} ${e.response.statusText || ''}`],
        ['Type', e._resourceType || '—'],
        ['Time', e.time ? `${Math.round(e.time)} ms${e.time >= 1000 ? ' 🐢 slow' : e.time >= 500 ? ' (slowish)' : ''}` : '—'],
        ['Started', e.startedDateTime || '—'],
      ]),
    ),
    (() => {
      const u = new URL(e.request.url);
      const qp = [...u.searchParams];
      return qp.length ? h('details', {}, h('summary', {}, `Query params (${qp.length})`), kvTable(qp)) : null;
    })(),
    h('details', {}, h('summary', {}, `Request headers (${headerPairs(e.request.headers).length})`), kvTable(headerPairs(e.request.headers))),
    body
      ? h(
          'details',
          { open: true },
          h('summary', {}, 'Payload'),
          h('pre', { class: 'code' }, body.kind === 'raw' ? prettyBody(body.text) : body.params.map((p) => `${p.name}=${p.fileName ? `@${p.fileName}` : p.value}`).join('\n')),
        )
      : null,
    h('details', {}, h('summary', {}, `Response headers (${headerPairs(e.response.headers).length})`), kvTable(headerPairs(e.response.headers))),
    h('details', { open: true }, h('summary', {}, 'Response'), responsePre),
  );

  const text = await item.body();
  if (selectedId !== item.id) return;
  responsePre.textContent = text == null ? 'Response body not available (request finished before Baton opened, reload to capture).' : prettyBody(text).slice(0, 200000) || '(empty)';
}

function select(id) {
  selectedId = id;
  renderList();
  renderDetail();
}

export function mountNetwork(container) {
  root = container;
  let t;
  const filterInput = h('input', {
    type: 'search',
    class: 'input',
    placeholder: 'Search URL, method, status (and bodies)',
    'aria-label': 'Search requests',
    oninput: (ev) => {
      filters.text = ev.target.value;
      clearTimeout(t);
      t = setTimeout(renderList, filters.bodies ? 300 : 0);
    },
  });
  const bodiesBox = h('input', { type: 'checkbox', id: 'net-bodies' });
  bodiesBox.addEventListener('change', () => ((filters.bodies = bodiesBox.checked), renderList()));
  const sel = (key, options, label) => {
    const s = h('select', { class: 'input', 'aria-label': label }, options.map(([v, l]) => h('option', { value: v }, l)));
    s.value = filters[key];
    s.addEventListener('change', () => ((filters[key] = s.value), renderList()));
    return s;
  };
  const methodSel = sel('method', ['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((m) => [m, m === 'ALL' ? 'All methods' : m]), 'Method');
  const statusSel = sel('status', [['ALL', 'All statuses'], ['2xx', '2xx'], ['3xx', '3xx'], ['4xx', '4xx'], ['5xx', '5xx'], ['failed', 'Failed (4xx/5xx/ERR)']], 'Status');
  domainSel = sel('domain', [['ALL', 'All domains']], 'Domain');
  const apiBox = h('input', { type: 'checkbox', id: 'net-api', checked: settings.apiOnly });
  apiBox.addEventListener('change', () => setSetting('apiOnly', apiBox.checked));
  const preserveBox = h('input', { type: 'checkbox', id: 'net-preserve', checked: settings.preserveLog });
  preserveBox.addEventListener('change', () => setSetting('preserveLog', preserveBox.checked));
  countEl = h('span', { class: 'muted count' });
  searchNote = h('span', { class: 'muted small' });
  bulkEl = h('div', { class: 'bulk' });
  listEl = h('div', { class: 'req-list', role: 'list' });
  detailEl = h('div', { class: 'req-detail' });

  clear(
    root,
    h(
      'div',
      { class: 'toolbar' },
      filterInput,
      h('label', { class: 'check', for: 'net-bodies' }, bodiesBox, 'Search bodies'),
      methodSel,
      statusSel,
      domainSel,
      h('label', { class: 'check', for: 'net-api' }, apiBox, 'XHR / fetch only'),
      h('label', { class: 'check', for: 'net-preserve' }, preserveBox, 'Preserve log'),
      countEl,
      searchNote,
      h(
        'button',
        {
          type: 'button',
          class: 'btn ghost',
          onclick: () => {
            shared.requests.length = 0;
            shared.pinned.clear();
            checked.clear();
            selectedId = null;
            emit('requests-changed');
            renderDetail();
          },
        },
        'Clear',
      ),
    ),
    bulkEl,
    h('div', { class: 'split' }, listEl, detailEl),
  );

  chrome.devtools.network.getHAR((log) => {
    (log && log.entries ? log.entries : []).forEach(addEntry);
  });
  chrome.devtools.network.onRequestFinished.addListener(addEntry);
  chrome.devtools.network.onNavigated.addListener(() => {
    if (!settings.preserveLog) {
      shared.requests.length = 0;
      shared.pinned.clear();
      checked.clear();
      selectedId = null;
      emit('requests-changed');
      renderDetail();
    }
  });

  let pending;
  on('requests-changed', () => {
    clearTimeout(pending);
    pending = setTimeout(renderList, 100);
  });
  onSettingChange((key, value) => {
    if (key === 'mask') renderDetail();
    if (key === 'apiOnly') renderList();
    if (key === 'preserveLog') preserveBox.checked = value;
    if (key === 'mode') {
      filters.status = value === 'qa' ? 'failed' : 'ALL';
      statusSel.value = filters.status;
      renderList();
    }
  });

  if (settings.mode === 'qa') {
    filters.status = 'failed';
    statusSel.value = 'failed';
  }
  renderList();
  renderDetail();
}

// For other modules (Bruno export of the report's requests etc.)
export { requestHeaders };
