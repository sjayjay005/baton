import { h, clear, copyText, toast, toggleSwitch, accordion, download, timeStr } from '../lib/dom.js';
import { settings, setSetting, getStored, setStored, on, shared } from '../lib/settings.js';
import { readStorage, setStorageItem, removeStorageItem, restoreStorage, importStorage, clearStorageExcept, pageUrl, reloadPage } from '../lib/page.js';
import { prettyBody, isBoolValue, isBoolOn, setBool, maskStorageEntries } from '../lib/format.js';
import { findJwt } from '../lib/jwt.js';
import { jwtChip } from '../lib/jwtview.js';

let root, originEl, errorEl, filterInput;
let acc = {};
let data = { origin: '', local: [], session: [] };
let lastJson = '';
let area = 'local';
let filter = '';
let editing = null; // { area, key }
let snapshots = [];
let locks = { local: [], session: [] };
let cyclers = [];
let cyclerDraft = null;
let cookies = [];
let cookieDraft = null;
let cookieError = '';

const AREA = { local: 'local', session: 'session' };
const matches = (k, v) => !filter || k.toLowerCase().includes(filter) || (v || '').toLowerCase().includes(filter);
const all = () => [...data.local.map(([k, v]) => ({ area: 'local', k, v })), ...data.session.map(([k, v]) => ({ area: 'session', k, v }))];
const valueOf = (a, k) => {
  const hit = (a === 'local' ? data.local : data.session).find(([key]) => key === k);
  return hit ? hit[1] : null;
};
const isLocked = (a, k) => (locks[a] || []).includes(k);
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: chrome.runtime.lastError?.message })));

async function afterChange() {
  if (settings.reloadOnToggle) reloadPage();
  refresh(true);
}

async function refresh(force = false) {
  try {
    const next = await readStorage();
    errorEl.textContent = '';
    const json = JSON.stringify(next);
    if (!force && json === lastJson) return;
    const originChanged = next.origin !== data.origin;
    data = next;
    lastJson = json;
    if (originChanged) {
      [snapshots, locks, cyclers] = await Promise.all([getStored(`snapshots:${data.origin}`, []), getStored(`locks:${data.origin}`, { local: [], session: [] }), getStored(`cyclers:${data.origin}`, [])]);
      loadCookies();
    }
    render();
  } catch (err) {
    errorEl.textContent = `Can't read storage on this page (${err.message}). Chrome internal pages are off limits.`;
  }
}

function busy() {
  const a = document.activeElement;
  return editing !== null || cookieDraft !== null || cyclerDraft !== null || (root.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.type !== 'checkbox' && a !== filterInput);
}

async function toggleLock(a, k) {
  const list = new Set(locks[a] || []);
  if (list.has(k)) list.delete(k);
  else list.add(k);
  locks = { ...locks, [a]: [...list] };
  await setStored(`locks:${data.origin}`, locks);
  toast(list.has(k) ? `🔒 ${k} locked. The page can’t change it.` : `🔓 ${k} unlocked`);
  render();
}

function lockBtn(a, k) {
  const l = isLocked(a, k);
  return h('button', { type: 'button', class: `icon-btn${l ? ' locked' : ''}`, title: l ? 'Unlock (let the page change it)' : 'Lock (stop the page changing it)', 'aria-label': `${l ? 'Unlock' : 'Lock'} ${k}`, 'aria-pressed': String(l), onclick: () => toggleLock(a, k) }, l ? '🔒' : '🔓');
}

// ---- Flags ---------------------------------------------------------------------------
function renderFlags() {
  const flags = all().filter((x) => isBoolValue(x.v));
  const shown = flags.filter((x) => matches(x.k, x.v));
  acc.flags.setCount(flags.length);
  const keyIn = h('input', { class: 'input', placeholder: 'feature.newCheckout', 'aria-label': 'New flag key', required: true });
  const areaSel = h('select', { class: 'input', 'aria-label': 'Storage for new flag' }, h('option', { value: 'local' }, 'localStorage'), h('option', { value: 'session' }, 'sessionStorage'));
  const styleSel = h('select', { class: 'input', 'aria-label': 'Flag value style' }, h('option', { value: 'true' }, 'true / false'), h('option', { value: '1' }, '1 / 0'));
  clear(
    acc.flags.body,
    shown.length
      ? h(
          'div',
          { class: 'flag-grid' },
          shown.map((x) => {
            const on = isBoolOn(x.v);
            return h(
              'div',
              { class: `flag${on ? ' on' : ''}` },
              toggleSwitch(
                on,
                async (c) => {
                  await setStorageItem(x.area, x.k, setBool(x.v, c));
                  afterChange();
                },
                `${x.k} (${x.area}Storage)`,
              ),
              h('span', { class: 'flag-key mono', title: x.k }, x.k),
              h('span', { class: `area-badge a-${x.area}` }, AREA[x.area]),
              h('span', { class: 'flag-val mono' }, x.v),
              lockBtn(x.area, x.k),
              h(
                'button',
                {
                  type: 'button',
                  class: 'icon-btn',
                  title: 'Delete key',
                  'aria-label': `Delete ${x.k}`,
                  onclick: async () => {
                    await removeStorageItem(x.area, x.k);
                    afterChange();
                  },
                },
                '×',
              ),
            );
          }),
        )
      : h('div', { class: 'muted small pad' }, flags.length ? 'No flags match the filter.' : 'No true/false or 1/0 keys on this page yet. Add one below.'),
    h(
      'form',
      {
        class: 'row-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const key = keyIn.value.trim();
          if (!key) return;
          await setStorageItem(areaSel.value, key, styleSel.value === '1' ? '1' : 'true');
          toast(`Added ${key}`);
          afterChange();
        },
      },
      keyIn,
      areaSel,
      styleSel,
      h('button', { type: 'submit', class: 'btn' }, 'Add flag'),
    ),
  );
}

// ---- Cyclers: keys that rotate through several values ----------------------------
async function saveCyclers() {
  await setStored(`cyclers:${data.origin}`, cyclers);
}

function renderCyclers() {
  acc.cyclers.setCount(cyclers.length);
  const form = cyclerDraft
    ? (() => {
        const d = cyclerDraft;
        const inp = (k, label, attrs = {}) => {
          const el = h(attrs.multiline ? 'textarea' : 'input', { class: 'input', ...attrs, multiline: null });
          el.value = d[k] ?? '';
          el.addEventListener('input', () => (d[k] = el.value));
          return h('label', { class: 'field' }, h('span', {}, label), el);
        };
        const areaSel = h('select', { class: 'input' }, h('option', { value: 'local' }, 'localStorage'), h('option', { value: 'session' }, 'sessionStorage'));
        areaSel.value = d.area;
        areaSel.addEventListener('change', () => (d.area = areaSel.value));
        const slotSel = h('select', { class: 'input' }, h('option', { value: '' }, 'No shortcut'), [1, 2, 3].map((n) => h('option', { value: n }, `Shortcut slot ${n} (Alt+Shift+${n})`)));
        slotSel.value = d.slot || '';
        slotSel.addEventListener('change', () => (d.slot = slotSel.value ? Number(slotSel.value) : null));
        const reloadBox = h('input', { type: 'checkbox', checked: !!d.reload, id: 'cy-reload' });
        reloadBox.addEventListener('change', () => (d.reload = reloadBox.checked));
        return h(
          'form',
          {
            class: 'toggle-form',
            onsubmit: async (e) => {
              e.preventDefault();
              const values = String(d.valuesText || '')
                .split(/\n|,/)
                .map((v) => v.trim())
                .filter(Boolean);
              if (!d.key || values.length < 2) return toast('Add a key and at least two values');
              const c = { id: d.id || crypto.randomUUID(), label: d.label || d.key, area: d.area, key: d.key, values, slot: d.slot || null, reload: !!d.reload };
              if (c.slot) cyclers.forEach((x) => x.slot === c.slot && x.id !== c.id && (x.slot = null));
              cyclers = cyclers.filter((x) => x.id !== c.id).concat(c);
              cyclerDraft = null;
              await saveCyclers();
              render();
            },
          },
          inp('label', 'Label', { placeholder: 'API environment' }),
          inp('key', 'Key', { placeholder: 'apiEnv', required: true }),
          h('label', { class: 'field' }, h('span', {}, 'Storage'), areaSel),
          h('label', { class: 'field' }, h('span', {}, 'Keyboard shortcut'), slotSel),
          h('div', { class: 'full' }, inp('valuesText', 'Values (one per line or comma separated)', { multiline: true, rows: 3, placeholder: 'dev\nstaging\nprod' })),
          h('label', { class: 'check full', for: 'cy-reload' }, reloadBox, 'Reload the page after switching'),
          h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save cycler'), h('button', { type: 'button', class: 'btn ghost', onclick: () => ((cyclerDraft = null), render()) }, 'Cancel')),
        );
      })()
    : null;
  clear(
    acc.cyclers.body,
    h('div', { class: 'row-form' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => ((cyclerDraft = { area: 'local', valuesText: '' }), render()) }, '+ New cycler'), h('span', { class: 'muted small' }, 'Rotate a key through values like dark → light or dev → staging → prod. Change shortcut keys at chrome://extensions/shortcuts.')),
    form,
    cyclers.map((c) => {
      const cur = valueOf(c.area, c.key);
      const set = async (v) => {
        await setStorageItem(c.area, c.key, v);
        if (c.reload) reloadPage();
        else afterChange();
      };
      const next = () => set(c.values[(c.values.indexOf(cur) + 1) % c.values.length]);
      return h(
        'div',
        { class: 'cycler' },
        h('div', { class: 'toggle-text' }, h('strong', {}, c.label, c.slot ? h('span', { class: 'kbd' }, `Alt+Shift+${c.slot}`) : null), h('code', {}, `${c.area}.${c.key}`)),
        h('div', { class: 'chips' }, c.values.map((v) => h('button', { type: 'button', class: `chip${v === cur ? ' active' : ''}`, 'aria-pressed': String(v === cur), onclick: () => set(v) }, v))),
        h('button', { type: 'button', class: 'btn', onclick: next, title: 'Next value' }, '⟳ Next'),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Edit ${c.label}`, onclick: () => ((cyclerDraft = { ...c, valuesText: c.values.join('\n') }), render()) }, '✎'),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'aria-label': `Delete ${c.label}`,
            onclick: async () => {
              cyclers = cyclers.filter((x) => x.id !== c.id);
              await saveCyclers();
              render();
            },
          },
          '×',
        ),
      );
    }),
  );
}

// ---- Values --------------------------------------------------------------------------
function renderValues() {
  const list = (area === 'local' ? data.local : data.session).filter(([, v]) => !isBoolValue(v));
  const rows = list.filter(([k, v]) => matches(k, v));
  const countFor = (a) => (a === 'local' ? data.local : data.session).filter(([, v]) => !isBoolValue(v)).length;
  acc.values.setCount(countFor('local') + countFor('session'));
  const newKey = h('input', { class: 'input', placeholder: 'key', 'aria-label': 'New key' });
  const newVal = h('input', { class: 'input', placeholder: 'value', 'aria-label': 'New value' });
  clear(
    acc.values.body,
    h(
      'div',
      { class: 'seg', role: 'tablist' },
      ['local', 'session'].map((a) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(area === a), class: area === a ? 'active' : '', onclick: () => ((area = a), (editing = null), renderValues()) }, `${a}Storage (${countFor(a)})`)),
    ),
    rows.length
      ? h('table', { class: 'store-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Value'), h('th', { class: 'right' }, 'Actions'))), h('tbody', {}, rows.map(([k, v]) => valueRow(k, v))))
      : h('div', { class: 'muted small pad' }, list.length ? 'Nothing matches the filter.' : `No other ${area}Storage values.`),
    h(
      'form',
      {
        class: 'row-form',
        onsubmit: async (e) => {
          e.preventDefault();
          if (!newKey.value) return;
          await setStorageItem(area, newKey.value, newVal.value);
          afterChange();
        },
      },
      newKey,
      newVal,
      h('button', { type: 'submit', class: 'btn' }, `Add to ${area}Storage`),
    ),
  );
}

function valueRow(k, v) {
  if (editing && editing.area === area && editing.key === k) {
    const ta = h('textarea', { class: 'input mono', rows: 6, 'aria-label': `Value for ${k}` });
    ta.value = prettyBody(v);
    return h(
      'tr',
      {},
      h('td', { class: 'mono key' }, k),
      h('td', {}, ta),
      h(
        'td',
        { class: 'right nowrap' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn primary',
            onclick: async () => {
              let val = ta.value;
              try {
                val = JSON.stringify(JSON.parse(val));
              } catch {
                /* plain string */
              }
              await setStorageItem(area, k, val);
              editing = null;
              afterChange();
            },
          },
          'Save',
        ),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => ((editing = null), renderValues()) }, 'Cancel'),
      ),
    );
  }
  const jwt = findJwt(v);
  return h(
    'tr',
    { class: isLocked(area, k) ? 'locked-row' : '' },
    h('td', { class: 'mono key' }, k),
    h('td', { class: 'mono val', title: v }, (v || '').length > 160 ? `${v.slice(0, 160)}…` : v, jwt ? h('div', {}, jwtChip(jwt, k)) : null),
    h(
      'td',
      { class: 'right nowrap' },
      lockBtn(area, k),
      h('button', { type: 'button', class: 'icon-btn', title: 'Edit', 'aria-label': `Edit ${k}`, onclick: () => ((editing = { area, key: k }), renderValues()) }, '✎'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Copy value', 'aria-label': `Copy ${k}`, onclick: () => copyText(v) }, '⧉'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Make a cycler', 'aria-label': `Make ${k} a cycler`, onclick: () => ((cyclerDraft = { area, key: k, label: k, valuesText: `${v}\n` }), render()) }, '⟳'),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          title: 'Delete',
          'aria-label': `Delete ${k}`,
          onclick: async () => {
            await removeStorageItem(area, k);
            afterChange();
          },
        },
        '×',
      ),
    ),
  );
}

// ---- Cookies ------------------------------------------------------------------------
async function loadCookies() {
  const url = await pageUrl().catch(() => null);
  if (!url || !/^https?:/.test(url)) {
    cookies = [];
    cookieError = 'Cookies are only available on http(s) pages.';
    return renderCookies();
  }
  const r = await send({ type: 'cookies-get', url });
  cookieError = r.ok ? '' : r.error || 'Couldn’t read cookies';
  cookies = r.ok ? r.cookies.sort((a, b) => a.name.localeCompare(b.name)) : [];
  renderCookies();
}

function cookieUrl(c) {
  return `http${c.secure ? 's' : ''}://${String(c.domain).replace(/^\./, '')}${c.path || '/'}`;
}

async function saveCookie(d, original) {
  const pageHost = new URL(await pageUrl()).hostname;
  const domain = d.domain || pageHost;
  const details = { url: cookieUrl({ ...d, domain }), name: d.name, value: d.value ?? '', path: d.path || '/', secure: !!d.secure, httpOnly: !!d.httpOnly, sameSite: d.sameSite || 'lax' };
  if (!d.hostOnly) details.domain = domain;
  if (!d.session && d.expires) details.expirationDate = Math.floor(new Date(d.expires).getTime() / 1000);
  if (details.sameSite === 'no_restriction' && !details.secure) return toast('SameSite=None cookies must be Secure');
  if (original && (original.name !== d.name || original.domain !== d.domain || original.path !== d.path)) {
    await send({ type: 'cookie-remove', url: cookieUrl(original), name: original.name, storeId: original.storeId });
  }
  const r = await send({ type: 'cookie-set', details });
  if (!r.ok) return toast(r.error || 'Couldn’t save cookie');
  cookieDraft = null;
  toast('🍪 Cookie saved');
  if (settings.reloadOnToggle) reloadPage();
  loadCookies();
}

function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderCookieForm() {
  const d = cookieDraft;
  const original = d.__original;
  const inp = (k, label, attrs = {}) => {
    const el = h('input', { class: `input${attrs.mono ? ' mono' : ''}`, ...attrs, mono: null });
    el.value = d[k] ?? '';
    el.addEventListener('input', () => (d[k] = el.value));
    return h('label', { class: 'field' }, h('span', {}, label), el);
  };
  const check = (k, label) => {
    const b = h('input', { type: 'checkbox', checked: !!d[k], id: `ck-${k}` });
    b.addEventListener('change', () => (d[k] = b.checked));
    return h('label', { class: 'check', for: `ck-${k}` }, b, label);
  };
  const ss = h('select', { class: 'input' }, [['lax', 'Lax'], ['strict', 'Strict'], ['no_restriction', 'None'], ['unspecified', 'Not set']].map(([v, l]) => h('option', { value: v }, l)));
  ss.value = d.sameSite || 'lax';
  ss.addEventListener('change', () => (d.sameSite = ss.value));
  const valueEl = h('textarea', { class: 'input mono', rows: 3, 'aria-label': 'Cookie value' });
  valueEl.value = d.value ?? '';
  valueEl.addEventListener('input', () => (d.value = valueEl.value));
  return h(
    'form',
    {
      class: 'toggle-form',
      onsubmit: (e) => {
        e.preventDefault();
        if (!d.name) return toast('Cookie name is required');
        saveCookie(d, original);
      },
    },
    inp('name', 'Name', { mono: true, required: true }),
    inp('domain', 'Domain (blank = this host)', { mono: true, placeholder: '.example.com' }),
    h('label', { class: 'field full' }, h('span', {}, 'Value'), valueEl),
    inp('path', 'Path', { mono: true, placeholder: '/' }),
    h('label', { class: 'field' }, h('span', {}, 'SameSite'), ss),
    inp('expires', 'Expires', { type: 'datetime-local' }),
    h('div', { class: 'row-form' }, check('session', 'Session cookie'), check('secure', 'Secure'), check('httpOnly', 'HttpOnly'), check('hostOnly', 'Host only')),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save cookie'), h('button', { type: 'button', class: 'btn ghost', onclick: () => ((cookieDraft = null), renderCookies()) }, 'Cancel')),
  );
}

function renderCookies() {
  if (!acc.cookies) return;
  acc.cookies.setCount(cookies.length);
  const shown = cookies.filter((c) => matches(c.name, c.value));
  clear(
    acc.cookies.body,
    h('div', { class: 'row-form' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => ((cookieDraft = { path: '/', sameSite: 'lax', hostOnly: true, session: true }), renderCookies()) }, '+ Add cookie'), h('button', { type: 'button', class: 'btn ghost', onclick: loadCookies }, 'Refresh'), h('span', { class: 'muted small' }, 'Includes HttpOnly cookies the page itself can’t see.')),
    cookieError ? h('div', { class: 'muted small' }, cookieError) : null,
    cookieDraft ? renderCookieForm() : null,
    shown.length
      ? h(
          'table',
          { class: 'store-table cookie-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Value'), h('th', {}, 'Domain / path'), h('th', {}, 'Expires'), h('th', {}, 'Flags'), h('th', { class: 'right' }, ''))),
          h(
            'tbody',
            {},
            shown.map((c) => {
              const jwt = findJwt(c.value);
              return h(
                'tr',
                {},
                h('td', { class: 'mono key' }, c.name),
                h('td', { class: 'mono val', title: c.value }, c.value.length > 80 ? `${c.value.slice(0, 80)}…` : c.value, jwt ? h('div', {}, jwtChip(jwt, c.name)) : null),
                h('td', { class: 'mono small' }, `${c.domain}${c.path}`),
                h('td', { class: 'small' }, c.session ? 'Session' : new Date(c.expirationDate * 1000).toLocaleString()),
                h('td', { class: 'small' }, [c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite && c.sameSite !== 'unspecified' && `SameSite=${c.sameSite === 'no_restriction' ? 'None' : c.sameSite}`].filter(Boolean).join(' · ')),
                h(
                  'td',
                  { class: 'right nowrap' },
                  h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Edit cookie ${c.name}`, onclick: () => ((cookieDraft = { ...c, expires: c.session ? '' : toLocalInput(c.expirationDate * 1000), __original: c }), renderCookies()) }, '✎'),
                  h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Copy cookie ${c.name}`, onclick: () => copyText(c.value) }, '⧉'),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'icon-btn',
                      'aria-label': `Delete cookie ${c.name}`,
                      onclick: async () => {
                        await send({ type: 'cookie-remove', url: cookieUrl(c), name: c.name, storeId: c.storeId });
                        loadCookies();
                      },
                    },
                    '×',
                  ),
                ),
              );
            }),
          ),
        )
      : h('div', { class: 'muted small pad' }, cookies.length ? 'No cookies match the filter.' : 'No cookies for this page.'),
  );
}

// ---- History (who changed what) + rollback ---------------------------------------------
let historyFilterAll = false;
function renderHistory() {
  const log = shared.storageLog.filter((e) => e.url && data.origin && e.url.startsWith(data.origin));
  const shown = log.filter((e) => historyFilterAll || e.by !== 'baton').slice(-150).reverse();
  acc.history.setCount(log.length);
  const allBox = h('input', { type: 'checkbox', checked: historyFilterAll, id: 'hist-all' });
  allBox.addEventListener('change', () => ((historyFilterAll = allBox.checked), renderHistory()));
  clear(
    acc.history.body,
    h('div', { class: 'row-form' }, h('label', { class: 'check', for: 'hist-all' }, allBox, 'Include changes made by Baton'), h('span', { class: 'muted small' }, 'Every setItem/removeItem/clear the page makes, with the code that did it.')),
    shown.length
      ? shown.map((e) =>
          h(
            'div',
            { class: `hist-row${e.blocked ? ' blocked' : ''}` },
            h('span', { class: 'mono small muted' }, timeStr(e.time)),
            h('span', { class: `area-badge a-${e.area}` }, e.area),
            h(
              'div',
              { class: 'hist-main' },
              h('div', { class: 'mono small' }, e.blocked ? '🔒 blocked ' : '', e.op === 'clear' ? 'clear()' : `${e.op === 'remove' ? 'remove' : 'set'} ${e.key}`, e.by === 'baton' ? h('span', { class: 'muted' }, ' (Baton)') : null),
              e.op !== 'clear' ? h('div', { class: 'mono small muted hist-diff' }, `${e.oldValue === null ? '∅' : String(e.oldValue).slice(0, 80)} → ${e.newValue === null ? '∅' : String(e.newValue).slice(0, 80)}`) : h('div', { class: 'muted small' }, `${e.oldValue}${e.newValue ? `, ${e.newValue}` : ''}`),
              e.stack ? h('details', {}, h('summary', {}, 'Who did it'), h('pre', { class: 'code small' }, e.stack)) : null,
            ),
            e.op !== 'clear' && !e.blocked
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn ghost',
                    title: 'Put the old value back',
                    onclick: async () => {
                      if (e.oldValue === null) await removeStorageItem(e.area, e.key);
                      else await setStorageItem(e.area, e.key, e.oldValue);
                      toast(`↩ ${e.key} rolled back`);
                      afterChange();
                    },
                  },
                  '↩ Roll back',
                )
              : null,
          ),
        )
      : h('div', { class: 'muted small pad' }, 'No storage changes recorded yet on this site.'),
  );
}

// ---- Snapshots ----------------------------------------------------------------------
function renderSnapshots() {
  acc.snapshots.setCount(snapshots.length);
  const nameInput = h('input', { class: 'input', placeholder: 'Snapshot name, e.g. logged-in admin', 'aria-label': 'Snapshot name' });
  const save = () => setStored(`snapshots:${data.origin}`, snapshots);
  clear(
    acc.snapshots.body,
    h(
      'form',
      {
        class: 'row-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const name = nameInput.value.trim() || new Date().toLocaleString();
          snapshots = [{ id: crypto.randomUUID(), name, at: Date.now(), local: data.local, session: data.session }, ...snapshots].slice(0, 30);
          await save();
          toast('Snapshot saved');
          renderSnapshots();
        },
      },
      nameInput,
      h('button', { type: 'submit', class: 'btn' }, 'Save snapshot'),
    ),
    snapshots.map((s) =>
      h(
        'div',
        { class: 'snap-item' },
        h('div', { class: 'toggle-text' }, h('strong', {}, s.name), h('span', { class: 'muted small' }, `${s.local.length} local · ${s.session.length} session · ${new Date(s.at).toLocaleString()}`)),
        h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: async () => {
              await restoreStorage(s);
              toast(`Restored “${s.name}”`);
              afterChange();
            },
          },
          'Restore',
        ),
        h('button', { type: 'button', class: 'icon-btn', title: 'Copy JSON', 'aria-label': `Copy ${s.name} as JSON`, onclick: () => copyText(JSON.stringify({ localStorage: Object.fromEntries(s.local), sessionStorage: Object.fromEntries(s.session) }, null, 2)) }, '⧉'),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            title: 'Delete',
            'aria-label': `Delete ${s.name}`,
            onclick: async () => {
              snapshots = snapshots.filter((x) => x.id !== s.id);
              await save();
              renderSnapshots();
            },
          },
          '×',
        ),
      ),
    ),
  );
}

// ---- Import / export / clear ---------------------------------------------------------
function exportObj() {
  return { origin: data.origin, localStorage: Object.fromEntries(data.local), sessionStorage: Object.fromEntries(data.session) };
}

function aiText() {
  const mask = settings.mask;
  const fmt = (list) => maskStorageEntries(list, { mask }).map(([k, v]) => `- ${k}: ${String(v).length > 300 ? `${String(v).slice(0, 300)}…` : v}`).join('\n') || '(empty)';
  return `Storage for ${data.origin}\n\nlocalStorage:\n${fmt(data.local)}\n\nsessionStorage:\n${fmt(data.session)}${cookies.length ? `\n\ncookies:\n${cookies.map((c) => `- ${c.name}: ${mask && /token|session|auth|sid|jwt/i.test(c.name) ? '••••••••' : c.value.slice(0, 120)}${c.httpOnly ? ' (HttpOnly)' : ''}`).join('\n')}` : ''}`;
}

function openImport() {
  const ta = h('textarea', { class: 'input mono', rows: 12, placeholder: '{\n  "localStorage": { "theme": "dark" },\n  "sessionStorage": {}\n}', 'aria-label': 'Storage JSON' });
  const replace = h('input', { type: 'checkbox', id: 'imp-replace' });
  const close = () => overlay.remove();
  const overlay = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Import storage', onmousedown: (e) => e.target === overlay && close() },
    h(
      'div',
      { class: 'modal-box jwt-box stack' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Import storage JSON'), h('span', { class: 'grow' }), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '×')),
      h('p', { class: 'muted small' }, 'Paste an export from Baton or any object shaped like { "localStorage": {…}, "sessionStorage": {…} }. A flat object goes into localStorage.'),
      ta,
      h('label', { class: 'check', for: 'imp-replace' }, replace, 'Replace everything (clear first)'),
      h(
        'div',
        { class: 'row-form' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn primary',
            onclick: async () => {
              let obj;
              try {
                obj = JSON.parse(ta.value);
              } catch (e) {
                return toast(`Invalid JSON: ${e.message}`);
              }
              if (!obj.localStorage && !obj.sessionStorage) obj = { localStorage: obj };
              await importStorage(obj, { replace: replace.checked });
              close();
              toast('Storage imported');
              afterChange();
            },
          },
          'Import',
        ),
        h('button', { type: 'button', class: 'btn ghost', onclick: close }, 'Cancel'),
      ),
    ),
  );
  document.body.append(overlay);
  ta.focus();
}

function render() {
  originEl.textContent = data.origin || '';
  renderFlags();
  renderCyclers();
  renderValues();
  renderCookies();
  renderHistory();
  renderSnapshots();
}

export function mountStorage(container) {
  root = container;
  originEl = h('span', { class: 'muted mono small' });
  errorEl = h('div', { class: 'error', role: 'alert' });
  filterInput = h('input', {
    type: 'search',
    class: 'input',
    placeholder: 'Filter keys, values and cookies',
    'aria-label': 'Filter storage',
    oninput: (e) => {
      filter = e.target.value.toLowerCase();
      renderFlags();
      renderValues();
      renderCookies();
    },
  });
  acc = {
    flags: accordion('storage.flags', 'Flags', true),
    cyclers: accordion('storage.cyclers', 'Cyclers', true),
    values: accordion('storage.values', 'Values', true),
    cookies: accordion('storage.cookies', 'Cookies', false),
    history: accordion('storage.history', 'History', false),
    snapshots: accordion('storage.snapshots', 'Snapshots', false),
  };
  const reloadBox = h('input', { type: 'checkbox', id: 'st-reload', checked: settings.reloadOnToggle });
  reloadBox.addEventListener('change', () => setSetting('reloadOnToggle', reloadBox.checked));

  clear(
    root,
    h(
      'div',
      { class: 'toolbar' },
      filterInput,
      originEl,
      h('label', { class: 'check', for: 'st-reload' }, reloadBox, 'Reload page after a change'),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => copyText(aiText()) }, '🤖 Copy for AI'),
      h('button', { type: 'button', class: 'btn ghost', onclick: openImport }, 'Import'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => download(`storage-${data.origin.replace(/[^a-z0-9]+/gi, '-')}.json`, JSON.stringify(exportObj(), null, 2), 'application/json') }, 'Export'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn ghost',
          title: 'Clears local and session storage but keeps locked keys',
          onclick: async () => {
            await clearStorageExcept(locks);
            const kept = (locks.local || []).length + (locks.session || []).length;
            toast(`Storage cleared${kept ? `, kept ${kept} locked key${kept === 1 ? '' : 's'}` : ''}`);
            afterChange();
          },
        },
        'Clear (keep 🔒)',
      ),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => refresh(true) }, 'Refresh'),
    ),
    errorEl,
    ...Object.values(acc).map((a) => a.el),
  );

  on('storage-log', () => renderHistory());
  chrome.devtools.network.onNavigated.addListener(() => setTimeout(() => refresh(true), 300));
  setInterval(() => {
    if (root.offsetParent !== null && !busy()) refresh();
  }, 2000);
  refresh(true);
}

export function showStorage() {
  if (root) {
    refresh(true);
    loadCookies();
  }
}
