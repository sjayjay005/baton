// Baton page hook. Runs in the page's own JS world at document_start.
// - buffers console errors/warnings, user actions, storage changes and mock hits
//   in window.__baton (read by the DevTools panel; nothing leaves the page)
// - applies fetch/XHR mock + delay rules and storage key locks sent by content/bridge.js
(() => {
  if (window.__baton) return;
  const MAX = 600;
  const B = { seq: 0, events: [], config: { rules: [], locks: { local: [], session: [] }, paused: false } };
  Object.defineProperty(window, '__baton', { value: B, enumerable: false });

  // ---- Record / replay boot ---------------------------------------------------------
  // Baton writes a one-shot "boot" note into sessionStorage right before reloading the
  // page; we read it synchronously here, before any page script runs.
  const SPx = Storage.prototype;
  const rawGet = SPx.getItem;
  const rawSet = SPx.setItem;
  const rawRemove = SPx.removeItem;
  const rawClear = SPx.clear;
  const rawKey = SPx.key;
  let BOOT = null;
  try {
    const raw = rawGet.call(window.sessionStorage, '__baton_boot');
    if (raw) {
      BOOT = JSON.parse(raw);
      rawRemove.call(window.sessionStorage, '__baton_boot');
    }
  } catch {
    BOOT = null;
  }
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  const prng = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const fingerprint = (msg) => String(msg || '').split('\n')[0].replace(/\d+/g, '#').slice(0, 200);
  const snapshotStorage = () => {
    const read = (s) => {
      const out = [];
      try {
        for (let i = 0; i < s.length; i++) {
          const k = rawKey.call(s, i);
          if (k && !k.startsWith('__baton')) out.push([k, rawGet.call(s, k)]);
        }
      } catch {
        /* blocked storage */
      }
      return out;
    };
    return { local: read(window.localStorage), session: read(window.sessionStorage) };
  };
  const oGRV = crypto.getRandomValues.bind(crypto);
  const oUUID = crypto.randomUUID ? crypto.randomUUID.bind(crypto) : null;
  let REC = null;
  let REP = null;
  const MAX_BODY = 1024 * 1024;
  const MAX_TOTAL = 25 * 1024 * 1024;

  if (BOOT && BOOT.mode === 'record') {
    Math.random = prng(BOOT.seed);
    REC = { id: BOOT.id, seed: BOOT.seed, startedAt: realNow(), url: location.href, title: '', storage: snapshotStorage(), requests: [], actions: [], randoms: [], uuids: [], errors: [], bytes: 0, truncated: false, ended: null };
    crypto.getRandomValues = function (arr) {
      const r = oGRV(arr);
      if (REC && REC.randoms.length < 5000) REC.randoms.push(Array.from(arr));
      return r;
    };
    if (oUUID) {
      crypto.randomUUID = function () {
        const u = oUUID();
        if (REC && REC.uuids.length < 5000) REC.uuids.push(u);
        return u;
      };
    }
    B.stopRecording = () => {
      const r = REC;
      if (!r) return null;
      REC = null;
      r.ended = r.ended || 'stopped';
      r.endedAt = realNow();
      r.title = document.title;
      return r;
    };
    // A full page navigation ends the recording; keep what we have for the panel.
    window.addEventListener('pagehide', () => {
      if (!REC) return;
      const r = { ...REC, ended: 'navigation', endedAt: realNow(), title: document.title, nextUrl: '' };
      try {
        rawSet.call(window.sessionStorage, '__baton_rec_rescue', JSON.stringify(r));
      } catch {
        try {
          rawSet.call(window.sessionStorage, '__baton_rec_rescue', JSON.stringify({ ...r, requests: r.requests.map((q) => ({ ...q, body: null, dropped: true })) }));
        } catch {
          /* too big even without bodies */
        }
      }
    });
    B.rec = REC;
  }

  if (BOOT && BOOT.mode === 'replay') {
    // 1) Storage exactly as it was when recording started
    try {
      for (const [s, list] of [[window.localStorage, BOOT.storage.local], [window.sessionStorage, BOOT.storage.session]]) {
        rawClear.call(s);
        for (const [k, v] of list || []) rawSet.call(s, k, v);
      }
    } catch {
      /* storage blocked */
    }
    // 2) The same clock: Date runs from the recorded start time
    const offset = BOOT.startedAt - realNow();
    const vnow = () => realNow() + offset;
    function FakeDate(...a) {
      if (!new.target) return new RealDate(vnow()).toString();
      return a.length ? new RealDate(...a) : new RealDate(vnow());
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = vnow;
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    window.Date = FakeDate;
    // 3) The same randomness
    Math.random = prng(BOOT.seed);
    let ri = 0;
    let ui = 0;
    crypto.getRandomValues = function (arr) {
      const v = (BOOT.randoms || [])[ri];
      if (v && v.length === arr.length) {
        ri++;
        for (let i = 0; i < v.length; i++) arr[i] = v[i];
        return arr;
      }
      return oGRV(arr);
    };
    if (oUUID) crypto.randomUUID = () => ((BOOT.uuids || [])[ui] ? BOOT.uuids[ui++] : oUUID());
    REP = { runId: BOOT.runId, sessionId: BOOT.sessionId, total: (BOOT.actions || []).length, done: 0, step: 'Loading…', log: [], errors: [], unmatched: [], served: 0, finished: false, startedAt: realNow() };
    B.replay = REP;
  }

  const push = (kind, data) => {
    B.seq += 1;
    B.events.push({ id: B.seq, time: Date.now(), url: location.href, ...data, kind });
    if (B.events.length > MAX) B.events.splice(0, B.events.length - MAX);
  };
  const cleanStack = (s) =>
    String(s || '')
      .split('\n')
      .filter((l) => !/page-hook\.js|__baton|at Storage\.|at console\./.test(l))
      .slice(0, 8)
      .join('\n');

  // ---- Config from the extension (via content/bridge.js) ---------------------------
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  setTimeout(() => readyResolve(), 400); // never hold requests for long
  window.addEventListener('baton:config', (e) => {
    try {
      const cfg = JSON.parse(e.detail);
      B.config = { ...B.config, ...cfg };
    } catch {
      /* ignore */
    }
    readyResolve();
  });
  window.dispatchEvent(new CustomEvent('baton:hello'));
  window.addEventListener('baton:bridge-ready', () => window.dispatchEvent(new CustomEvent('baton:hello')));

  // ---- Console --------------------------------------------------------------------
  const fmt = (v) => {
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof v === 'string') return v;
    try {
      const seen = new WeakSet();
      return JSON.stringify(v, (k, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        return val;
      });
    } catch {
      return String(v);
    }
  };
  const consoleEvent = (level, args, stack) => {
    const message = Array.from(args).map(fmt).join(' ').slice(0, 5000);
    push('console', { level, message, stack: String(stack || '').slice(0, 4000) });
    if (level === 'error') {
      const e = { fp: fingerprint(message), message: message.slice(0, 500), t: realNow() - (REC ? REC.startedAt : REP ? REP.startedAt : 0) };
      if (REC && REC.errors.length < 200) REC.errors.push(e);
      if (REP && REP.errors.length < 200) REP.errors.push(e);
    }
  };
  for (const level of ['error', 'warn']) {
    const orig = console[level];
    console[level] = function (...args) {
      const err = args.find((a) => a instanceof Error);
      consoleEvent(level, args, err ? err.stack : cleanStack(new Error().stack));
      return orig.apply(this, args);
    };
  }
  window.addEventListener(
    'error',
    (e) => {
      if (e.error || e.message) consoleEvent('error', [e.error || e.message], e.error && e.error.stack ? e.error.stack : `${e.filename}:${e.lineno}:${e.colno}`);
      else if (e.target && e.target !== window) {
        const t = e.target;
        consoleEvent('error', [`Failed to load <${(t.tagName || '').toLowerCase()}> ${t.src || t.href || ''}`], '');
      }
    },
    true,
  );
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    consoleEvent('error', ['Unhandled promise rejection:', r], r && r.stack ? r.stack : '');
  });

  // ---- User actions -----------------------------------------------------------------
  const SECRET = /pass|pwd|secret|token|otp|pin|cvv|cvc|card|ssn|iban/i;
  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const labelOf = (el) => {
    if (el.labels && el.labels[0]) {
      const c = el.labels[0].cloneNode(true);
      c.querySelectorAll('input,select,textarea,option').forEach((n) => n.remove());
      const t = (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label') || el.getAttribute('title');
    if (aria) return aria.slice(0, 60);
    if (el.placeholder) return el.placeholder.slice(0, 60);
    return el.name || el.id || '';
  };
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const kind =
      tag === 'a' ? 'link' : tag === 'button' || role === 'button' || (tag === 'input' && /button|submit|reset/.test(el.type)) ? 'button' : tag === 'input' || tag === 'textarea' ? 'field' : tag === 'select' ? 'dropdown' : role || tag;
    const name = (tag === 'input' || tag === 'textarea' || tag === 'select' ? labelOf(el) : text(el) || labelOf(el) || el.value || '').slice(0, 60);
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy') || el.getAttribute('data-qa');
    const sel = testId ? `[data-testid="${testId}"]` : el.id ? `#${el.id}` : `${tag}${el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : ''}`;
    return { el: kind, name, selector: sel };
  };

  // Robust selector for replay: test ids, stable ids, names, then a short nth-of-type path.
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));
  const uniq = (sel) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const cssPath = (el) => {
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      const v = el.getAttribute(attr);
      if (v && uniq(`[${attr}="${esc(v)}"]`)) return `[${attr}="${esc(v)}"]`;
    }
    if (el.id && !/\d{4,}|^[a-f0-9-]{16,}$|:/i.test(el.id) && uniq(`#${esc(el.id)}`)) return `#${esc(el.id)}`;
    const tag = el.tagName.toLowerCase();
    if (el.name && uniq(`${tag}[name="${esc(el.name)}"]`)) return `${tag}[name="${esc(el.name)}"]`;
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement && parts.length < 8) {
      if (n !== el && n.id && !/\d{4,}|:/.test(n.id) && uniq(`#${esc(n.id)}`)) {
        parts.unshift(`#${esc(n.id)}`);
        break;
      }
      let part = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === n.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(n) + 1})`;
      }
      parts.unshift(part);
      n = parent;
    }
    return parts.join(' > ');
  };
  const recAction = (type, el, extra = {}) => {
    if (!REC || REC.actions.length >= 2000) return;
    REC.actions.push({ type, t: realNow() - REC.startedAt, path: cssPath(el), tag: el.tagName.toLowerCase(), text: text(el).slice(0, 80), name: labelOf(el), ...extra });
  };
  const isSecret = (el) => el.type === 'password' || SECRET.test(`${el.name} ${el.id} ${el.autocomplete} ${el.getAttribute('aria-label') || ''}`);
  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return; // ignore scripted clicks
      const el = e.target instanceof Element ? e.target.closest('a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[onclick]') || e.target : null;
      if (!el || /^(input|textarea|select)$/i.test(el.tagName) && !/checkbox|radio|button|submit|reset/.test(el.type)) return;
      if (el.tagName === 'LABEL') return; // the input's own click follows
      const d = describe(el);
      if (el.type === 'checkbox' || el.type === 'radio') return; // recorded on change
      push('action', { action: 'click', ...d });
      recAction('click', el, { desc: `Click “${d.name || d.selector}”` });
    },
    true,
  );
  document.addEventListener(
    'change',
    (e) => {
      if (!e.isTrusted) return;
      const el = e.target;
      if (!(el instanceof Element)) return;
      const d = describe(el);
      if (el.type === 'checkbox' || el.type === 'radio') {
        push('action', { action: el.checked ? 'check' : 'uncheck', ...d });
        recAction('check', el, { checked: el.checked, desc: `${el.checked ? 'Tick' : 'Untick'} “${d.name}”` });
      } else if (el.tagName === 'SELECT') {
        const optText = el.selectedOptions[0] ? text(el.selectedOptions[0]) : el.value;
        push('action', { action: 'select', value: optText, ...d });
        recAction('select', el, { value: el.value, optionText: optText, desc: `Select “${optText}” in “${d.name}”` });
      } else if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) {
        const secret = isSecret(el);
        push('action', { action: 'type', value: secret ? '••••••••' : String(el.value).slice(0, 80), ...d });
        recAction('type', el, secret ? { secret: true, value: null, desc: `Type a secret into “${d.name}”` } : { value: String(el.value).slice(0, 5000), desc: `Type “${String(el.value).slice(0, 40)}” into “${d.name}”` });
      }
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && e.target instanceof Element && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) {
        const el = e.target;
        push('action', { action: 'enter', ...describe(el), value: el.tagName === 'INPUT' && !isSecret(el) ? String(el.value).slice(0, 80) : '' });
        if (e.isTrusted) recAction('enter', el, { desc: `Press Enter in “${labelOf(el)}”` });
      }
    },
    true,
  );
  document.addEventListener(
    'submit',
    (e) => {
      const f = e.target;
      push('action', { action: 'submit', el: 'form', name: f.getAttribute('aria-label') || f.name || f.id || '', selector: f.id ? `#${f.id}` : 'form' });
      if (e.isTrusted || (REC && REC.actions.length && REC.actions[REC.actions.length - 1].type === 'enter')) recAction('submit', f, { desc: 'Submit the form' });
    },
    true,
  );
  const nav = (how) => push('action', { action: 'navigate', how, name: location.pathname + location.search + location.hash, el: 'page', selector: '' });
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...args) {
      const before = location.href;
      const r = orig.apply(this, args);
      if (location.href !== before && fn === 'pushState') nav('push');
      return r;
    };
  }
  window.addEventListener('popstate', () => nav('back/forward'));
  window.addEventListener('hashchange', () => nav('hash'));
  nav('load');

  // ---- Storage: change log + locks -------------------------------------------------
  const areaOf = (s) => {
    try {
      return s === window.localStorage ? 'local' : s === window.sessionStorage ? 'session' : null;
    } catch {
      return null;
    }
  };
  const locked = (area, key) => (B.config.locks?.[area] || []).includes(key);
  const SP = Storage.prototype;
  const oSet = SP.setItem;
  const oRemove = SP.removeItem;
  const oClear = SP.clear;
  const by = () => (window.__batonBypass ? 'baton' : 'page');
  SP.setItem = function (key, value) {
    const area = areaOf(this);
    key = String(key);
    if (!area) return oSet.call(this, key, value);
    const oldValue = this.getItem(key);
    if (locked(area, key) && !window.__batonBypass) {
      push('storage', { area, op: 'set', key, oldValue, newValue: String(value), blocked: true, by: 'page', stack: cleanStack(new Error().stack) });
      return;
    }
    oSet.call(this, key, value);
    if (oldValue !== String(value)) push('storage', { area, op: 'set', key, oldValue, newValue: String(value), by: by(), stack: by() === 'page' ? cleanStack(new Error().stack) : '' });
  };
  SP.removeItem = function (key) {
    const area = areaOf(this);
    key = String(key);
    if (!area) return oRemove.call(this, key);
    const oldValue = this.getItem(key);
    if (oldValue === null) return oRemove.call(this, key);
    if (locked(area, key) && !window.__batonBypass) {
      push('storage', { area, op: 'remove', key, oldValue, newValue: null, blocked: true, by: 'page', stack: cleanStack(new Error().stack) });
      return;
    }
    oRemove.call(this, key);
    push('storage', { area, op: 'remove', key, oldValue, newValue: null, by: by(), stack: by() === 'page' ? cleanStack(new Error().stack) : '' });
  };
  SP.clear = function () {
    const area = areaOf(this);
    if (!area) return oClear.call(this);
    const keep = window.__batonBypass ? [] : (B.config.locks?.[area] || []).filter((k) => this.getItem(k) !== null).map((k) => [k, this.getItem(k)]);
    const count = this.length;
    oClear.call(this);
    keep.forEach(([k, v]) => oSet.call(this, k, v));
    if (count) push('storage', { area, op: 'clear', key: '*', oldValue: `${count} keys`, newValue: keep.length ? `kept ${keep.length} locked` : null, by: by(), stack: by() === 'page' ? cleanStack(new Error().stack) : '' });
  };

  // ---- Request rules: mocks and delays for fetch/XHR -------------------------------
  const wildcard = (p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  const urlMatches = (m, url) => {
    if (!m || !m.value) return false;
    try {
      if (m.kind === 'equals') return url === m.value;
      if (m.kind === 'regex') return new RegExp(m.value).test(url);
      if (m.kind === 'wildcard') return wildcard(m.value).test(url);
      return url.includes(m.value);
    } catch {
      return false;
    }
  };
  const gqlOp = (body) => {
    if (typeof body !== 'string') return '';
    try {
      const j = JSON.parse(body);
      return (Array.isArray(j) ? j[0] : j)?.operationName || '';
    } catch {
      return '';
    }
  };
  const findRule = (method, url, body) => {
    if (B.config.paused) return null;
    for (const r of B.config.rules || []) {
      if (!r.enabled || (r.type !== 'mock' && r.type !== 'delay')) continue;
      if (r.match.method && r.match.method !== 'ANY' && r.match.method !== method) continue;
      if (!urlMatches(r.match, url)) continue;
      if (r.match.graphql && gqlOp(body) !== r.match.graphql) continue;
      return r;
    }
    return null;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(Number(ms) || 0, 120000))));
  const abs = (u) => {
    try {
      return new URL(u, location.href).href;
    } catch {
      return String(u);
    }
  };
  const hit = (r, method, url) => push('mock', { ruleId: r.id, ruleName: r.name, type: r.type, method, target: url, status: r.type === 'mock' ? r.status : null });
  const NO_BODY = new Set([101, 204, 205, 304]);

  // ---- Network: rules (mock/delay), recording and replay tape -----------------------
  const CACHE_BUSTERS = /^(_|t|ts|timestamp|cb|cachebust|cache_bust|nocache|rnd|rand|random|nonce)$/i;
  const normUrl = (url) => {
    try {
      const u = new URL(url);
      [...u.searchParams.keys()].forEach((k) => CACHE_BUSTERS.test(k) && u.searchParams.delete(k));
      u.hash = '';
      return u.href;
    } catch {
      return String(url);
    }
  };
  const pathKey = (url) => {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return String(url);
    }
  };
  let inflight = 0;

  // Replay tape (served instead of the network)
  let tapeResolve;
  const tapeReady = new Promise((r) => (tapeResolve = r));
  const byFull = new Map();
  const byPath = new Map();
  if (REP) {
    window.addEventListener('baton:tape', (e) => {
      try {
        const tape = JSON.parse(e.detail);
        if (tape && tape.id === BOOT.sessionId) {
          for (const entry of tape.entries || []) {
            const k1 = `${entry.method} ${normUrl(entry.url)}`;
            const k2 = `${entry.method} ${pathKey(entry.url)}`;
            if (!byFull.has(k1)) byFull.set(k1, []);
            if (!byPath.has(k2)) byPath.set(k2, []);
            byFull.get(k1).push(entry);
            byPath.get(k2).push(entry);
          }
        }
      } catch {
        /* bad tape */
      }
      tapeResolve();
    });
    // The bridge may load before or after us: ask now, and again when it says it's ready.
    let gotTape = false;
    window.addEventListener('baton:tape', () => (gotTape = true));
    const ask = () => !gotTape && window.dispatchEvent(new CustomEvent('baton:need-tape', { detail: BOOT.sessionId }));
    window.addEventListener('baton:bridge-ready', ask);
    ask();
    setTimeout(tapeResolve, 4000);
  } else tapeResolve();
  const takeTape = (method, url) => {
    for (const [map, key] of [[byFull, `${method} ${normUrl(url)}`], [byPath, `${method} ${pathKey(url)}`]]) {
      const hitEntry = (map.get(key) || []).find((e) => !e.__used);
      if (hitEntry) {
        hitEntry.__used = true;
        return hitEntry;
      }
    }
    return null;
  };
  const tapeBody = (entry) => {
    if (entry.body == null) return '';
    if (!entry.base64) return entry.body;
    const bin = atob(entry.body);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  const tapeDelay = (entry) => (BOOT && BOOT.fast ? 0 : Math.min(entry.ms || 0, 1500));

  // Recording responses
  const TEXTY = /json|text|xml|javascript|html|csv|graphql|x-www-form-urlencoded/i;
  const recordEntry = (entry) => {
    if (!REC) return;
    const size = typeof entry.body === 'string' ? entry.body.length : 0;
    if (REC.bytes + size > MAX_TOTAL) {
      REC.truncated = true;
      entry.body = null;
      entry.dropped = true;
    } else REC.bytes += size;
    if (REC.requests.length < 3000) REC.requests.push(entry);
  };
  const recordFetch = async (res, method, url, reqBody, t0, ms) => {
    try {
      const ct = res.headers.get('content-type') || '';
      const entry = { method, url, status: res.status, statusText: res.statusText, contentType: ct, t: t0 - REC.startedAt, ms: Math.round(ms), reqBody: typeof reqBody === 'string' ? reqBody.slice(0, 20000) : null, body: null, base64: false };
      if (TEXTY.test(ct) || !ct) {
        const t = await res.text();
        entry.body = t.length > MAX_BODY ? null : t;
        entry.dropped = t.length > MAX_BODY;
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length <= MAX_BODY) {
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
          entry.body = btoa(bin);
          entry.base64 = true;
        } else entry.dropped = true;
      }
      recordEntry(entry);
    } catch {
      /* body unreadable (opaque etc.) */
    }
  };

  const reqInfo = (input, init) => {
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    return {
      url: abs(isReq ? input.url : String(input)),
      method: String((init && init.method) || (isReq ? input.method : 'GET')).toUpperCase(),
      body: init && typeof init.body === 'string' ? init.body : undefined,
    };
  };

  const oFetch = window.fetch;
  const rulesFetch = async function (info, args, self) {
    await ready;
    const rule = REP ? null : findRule(info.method, info.url, info.body); // the tape wins during replay
    if (!rule) return oFetch.apply(self, args);
    hit(rule, info.method, info.url);
    if (rule.delay) await sleep(rule.delay);
    if (rule.type === 'delay') return oFetch.apply(self, args);
    const status = Number(rule.status) || 200;
    const res = new Response(NO_BODY.has(status) ? null : rule.body ?? '', {
      status,
      statusText: rule.statusText || '',
      headers: { 'content-type': rule.contentType || 'application/json', 'x-baton-mock': encodeURIComponent(rule.name || 'mock') },
    });
    Object.defineProperty(res, 'url', { value: info.url });
    return res;
  };

  window.fetch = async function (input, init) {
    let info;
    try {
      info = reqInfo(input, init);
    } catch {
      return oFetch.apply(this, arguments);
    }
    inflight++;
    try {
      if (REP) {
        await tapeReady;
        const entry = takeTape(info.method, info.url);
        if (entry) {
          REP.served++;
          await sleep(tapeDelay(entry));
          if (entry.error) throw new TypeError('Failed to fetch');
          const status = entry.status >= 200 && entry.status <= 599 ? entry.status : 200;
          const res = new Response(NO_BODY.has(status) ? null : tapeBody(entry), { status, statusText: entry.statusText || '', headers: { 'content-type': entry.contentType || 'application/json', 'x-baton-replay': '1' } });
          Object.defineProperty(res, 'url', { value: info.url });
          return res;
        }
        if (REP.unmatched.length < 200) REP.unmatched.push(`${info.method} ${info.url}`);
        if (BOOT.strict) throw new TypeError('Baton replay: request not in the recording');
      }
      const t0 = realNow();
      let res;
      try {
        res = await rulesFetch(info, arguments, this);
      } catch (err) {
        if (REC) recordEntry({ method: info.method, url: info.url, error: true, t: t0 - REC.startedAt, ms: realNow() - t0 });
        throw err;
      }
      if (REC) recordFetch(res.clone(), info.method, info.url, info.body, t0, realNow() - t0);
      return res;
    } finally {
      inflight--;
    }
  };

  const XP = XMLHttpRequest.prototype;
  const oOpen = XP.open;
  const oSend = XP.send;
  XP.open = function (method, url, ...rest) {
    this.__baton = { method: String(method).toUpperCase(), url: abs(url), async: rest.length ? rest[0] !== false : true };
    return oOpen.call(this, method, url, ...rest);
  };
  // Make an XHR finish with a canned response (mock rule or replay tape).
  const fakeXhr = (xhr, info, { status, statusText, contentType, body, label }) => {
    const textBody = NO_BODY.has(status) ? '' : typeof body === 'string' ? body : body ? new TextDecoder().decode(body) : '';
    let response = textBody;
    if (xhr.responseType === 'json') {
      try {
        response = JSON.parse(textBody);
      } catch {
        response = null;
      }
    } else if (xhr.responseType === 'blob') response = new Blob([body instanceof Uint8Array ? body : textBody], { type: contentType });
    else if (xhr.responseType === 'arraybuffer') response = body instanceof Uint8Array ? body.buffer : new TextEncoder().encode(textBody).buffer;
    const def = (k, v) => Object.defineProperty(xhr, k, { value: v, configurable: true });
    def('readyState', 4);
    def('status', status);
    def('statusText', statusText || '');
    def('responseURL', info.url);
    def('response', response);
    if (!xhr.responseType || xhr.responseType === 'text') def('responseText', textBody);
    def('getResponseHeader', (n) => (String(n).toLowerCase() === 'content-type' ? contentType : String(n).toLowerCase() === 'x-baton' ? label : null));
    def('getAllResponseHeaders', () => `content-type: ${contentType}\r\nx-baton: ${label}\r\n`);
    for (const type of ['readystatechange', 'load', 'loadend']) {
      const ev = type === 'readystatechange' ? new Event(type) : new ProgressEvent(type, { lengthComputable: true, loaded: textBody.length, total: textBody.length });
      xhr.dispatchEvent(ev);
    }
  };
  XP.send = function (body) {
    const xhr = this;
    const info = xhr.__baton || { method: 'GET', url: '', async: true };
    if (!info.async) return oSend.call(xhr, body); // synchronous XHR can't be deferred
    inflight++;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        inflight--;
      }
    };
    xhr.addEventListener('loadend', finish);
    if (REC) {
      const t0 = realNow();
      xhr.addEventListener('loadend', () => {
        if (!REC) return;
        const rt = xhr.responseType;
        let b = null;
        try {
          b = !rt || rt === 'text' ? xhr.responseText : rt === 'json' ? JSON.stringify(xhr.response) : null;
        } catch {
          b = null;
        }
        if (xhr.status === 0) return recordEntry({ method: info.method, url: info.url, error: true, t: t0 - REC.startedAt, ms: realNow() - t0 });
        recordEntry({ method: info.method, url: info.url, status: xhr.status, statusText: xhr.statusText, contentType: xhr.getResponseHeader('content-type') || '', t: t0 - REC.startedAt, ms: realNow() - t0, reqBody: typeof body === 'string' ? body.slice(0, 20000) : null, body: b && b.length > MAX_BODY ? null : b, base64: false, dropped: b === null });
      });
    }
    const go = async () => {
      if (REP) {
        await tapeReady;
        const entry = takeTape(info.method, info.url);
        if (entry && !entry.dropped) {
          REP.served++;
          return setTimeout(() => {
            if (entry.error) {
              const def = (k, v) => Object.defineProperty(xhr, k, { value: v, configurable: true });
              def('readyState', 4);
              def('status', 0);
              xhr.dispatchEvent(new ProgressEvent('error'));
              xhr.dispatchEvent(new ProgressEvent('loadend'));
              return;
            }
            fakeXhr(xhr, info, { status: entry.status || 200, statusText: entry.statusText, contentType: entry.contentType || 'application/json', body: tapeBody(entry), label: 'replay' });
          }, tapeDelay(entry));
        }
        if (REP.unmatched.length < 200) REP.unmatched.push(`${info.method} ${info.url}`);
      }
      const rule = REP ? null : findRule(info.method, info.url, typeof body === 'string' ? body : undefined);
      if (!rule) return oSend.call(xhr, body);
      hit(rule, info.method, info.url);
      setTimeout(() => {
        if (rule.type === 'delay') return oSend.call(xhr, body);
        fakeXhr(xhr, info, { status: Number(rule.status) || 200, statusText: rule.statusText, contentType: rule.contentType || 'application/json', body: String(rule.body ?? ''), label: rule.name });
      }, Math.max(0, Math.min(Number(rule.delay) || 0, 120000)));
    };
    // Wait for rules (and the replay tape) on the first requests of a page load.
    ready.then(go);
  };

  // ---- Replay driver: performs the recorded actions ----------------------------------
  if (REP) {
    const visible = (el) => el && el.isConnected && (el.offsetParent !== null || el.getClientRects().length > 0 || el.tagName === 'OPTION');
    const normText = (el) => text(el).slice(0, 80);
    const findEl = async (a, timeout = 5000) => {
      const until = realNow() + timeout;
      while (realNow() < until) {
        let el = null;
        try {
          el = a.path ? document.querySelector(a.path) : null;
        } catch {
          el = null;
        }
        if (!el && a.text) el = [...document.querySelectorAll(a.tag || '*')].find((e) => normText(e) === a.text && visible(e)) || null;
        if (!el && a.name && /input|select|textarea/.test(a.tag)) el = [...document.querySelectorAll(a.tag)].find((e) => labelOf(e) === a.name) || null;
        if (el && (visible(el) || a.type === 'submit')) return el;
        await sleep(100);
      }
      return null;
    };
    const fire = (el, type, Ctor, opts = {}) => {
      try {
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, ...opts }));
      } catch {
        el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      }
    };
    const setNative = (el, v) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(el, v);
      else el.value = v;
    };
    const perform = (a, el, prev) => {
      if (a.type === 'click') {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const o = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
        fire(el, 'pointerdown', window.PointerEvent || MouseEvent, o);
        fire(el, 'mousedown', MouseEvent, o);
        if (el.focus) el.focus();
        fire(el, 'pointerup', window.PointerEvent || MouseEvent, o);
        fire(el, 'mouseup', MouseEvent, o);
        el.click();
      } else if (a.type === 'type') {
        if (a.secret) return 'skipped (secret field, not recorded)';
        if (el.focus) el.focus();
        setNative(el, a.value ?? '');
        fire(el, 'input', window.InputEvent || Event, { inputType: 'insertText', data: a.value });
        fire(el, 'change', Event);
      } else if (a.type === 'select') {
        const opt = [...el.options].find((o) => o.value === a.value) || [...el.options].find((o) => text(o) === a.optionText);
        if (!opt) return 'option not found';
        setNative(el, opt.value);
        fire(el, 'input', Event);
        fire(el, 'change', Event);
      } else if (a.type === 'check') {
        if (el.checked !== a.checked) el.click();
      } else if (a.type === 'enter') {
        for (const t of ['keydown', 'keypress', 'keyup']) fire(el, t, KeyboardEvent, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
      } else if (a.type === 'submit') {
        if (!prev || prev.type !== 'enter') return 'skipped (submitted by the previous click)';
        if (el.requestSubmit) el.requestSubmit();
        else el.submit();
      }
      return 'ok';
    };
    const drive = async () => {
      await tapeReady;
      if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
      await sleep(BOOT.fast ? 150 : 400);
      const acts = BOOT.actions || [];
      let prevT = acts.length ? acts[0].t - 300 : 0;
      let prev = null;
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i];
        const gap = Math.min(Math.max((a.t - prevT) / (BOOT.speed || 1), BOOT.fast ? 30 : 80), BOOT.maxGap || 1500);
        await sleep(gap);
        prevT = a.t;
        REP.step = a.desc || a.type;
        const el = await findEl(a, BOOT.fast ? 2500 : 5000);
        if (!el) REP.log.push({ i, ok: false, note: 'element not found' });
        else {
          try {
            const note = perform(a, el, prev);
            REP.log.push({ i, ok: note === 'ok', note });
          } catch (err) {
            REP.log.push({ i, ok: false, note: String(err && err.message) });
          }
        }
        REP.done = i + 1;
        prev = a;
      }
      REP.step = 'Waiting for the page to settle…';
      await sleep(BOOT.fast ? 600 : 1200);
      const until = realNow() + 5000;
      while (inflight > 0 && realNow() < until) await sleep(100);
      await sleep(250);
      REP.finished = true;
      REP.endedAt = realNow();
      REP.step = 'Done';
    };
    drive();
  }
})();
