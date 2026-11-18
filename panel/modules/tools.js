// Tools: JWT decode / edit / sign, Base64 & URL encode-decode, Base64 → file,
// and the .npmrc editor.
// Works both inside DevTools and in the standalone tools page (no devtools APIs here).
import { h, clear, copyText, toast, download, downloadBlob, accordion } from '../lib/dom.js';
import { getStored, setStored, emit, on } from '../lib/settings.js';
import { decodeJwt, signJwt, verifyHmac, findJwt } from '../lib/jwt.js';
import { jwtDetails } from '../lib/jwtview.js';
import { utf8ToB64, bytesToB64, b64ToUtf8, b64ToBytes, looksBinary } from '../lib/b64.js';
import { sniff, sniffB64, b64Size } from '../lib/sniff.js';
import { pick, findB64, fmtPath, parseJson } from '../lib/jsonpick.js';
import { addMedia, stamp, fmtBytes } from '../lib/media.js';
import { GENERATORS, NANO_ALPHABET, formatId, encodeId, decodeUuid, decodeUlid, describeNanoId, identify } from '../lib/ids.js';
import { credentials, setToken, maskNpmrc, azureBlock } from '../lib/npmrc.js';

// Every tool is a section you can collapse; what you hide stays hidden next time.
const card = (id, title, ...kids) => {
  const acc = accordion(`tools.${id}`, title, true);
  clear(acc.body, ...kids);
  acc.el.id = id;
  return acc.el;
};
const area = (attrs) => h('textarea', { class: 'input mono', rows: 5, ...attrs });
const kvRows = (pairs) => h('table', { class: 'kv' }, h('tbody', {}, pairs.filter(Boolean).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, String(v))))));

function jwtTool() {
  const input = area({ placeholder: 'Paste a JWT (or "Bearer eyJ…")', 'aria-label': 'JWT to decode' });
  const view = h('div', {});
  const editor = h('div', { class: 'stack' });
  const header = area({ rows: 4, 'aria-label': 'JWT header JSON' });
  const payload = area({ rows: 8, 'aria-label': 'JWT payload JSON' });
  const alg = h('select', { class: 'input', 'aria-label': 'Algorithm' }, ['HS256', 'HS384', 'HS512', 'none'].map((a) => h('option', { value: a }, a)));
  const secret = h('input', { class: 'input mono', type: 'password', placeholder: 'HMAC secret', 'aria-label': 'Signing secret' });
  const out = area({ rows: 3, readonly: true, 'aria-label': 'Signed token' });
  const verifyOut = h('span', { class: 'small' });

  const decode = () => {
    const tok = findJwt(input.value) || input.value.trim();
    if (!tok) return clear(view);
    clear(view, jwtDetails(tok));
    try {
      const d = decodeJwt(tok);
      header.value = JSON.stringify(d.header, null, 2);
      payload.value = JSON.stringify(d.payload, null, 2);
      if (['HS256', 'HS384', 'HS512', 'none'].includes(d.header.alg)) alg.value = d.header.alg;
    } catch {
      /* shown in view */
    }
  };
  input.addEventListener('input', decode);
  const editClaim = (fn) => {
    try {
      const p = JSON.parse(payload.value || '{}');
      fn(p);
      payload.value = JSON.stringify(p, null, 2);
    } catch {
      toast('Payload isn’t valid JSON');
    }
  };
  const now = () => Math.floor(Date.now() / 1000);
  clear(
    editor,
    h('div', { class: 'grid-2' }, h('label', { class: 'field' }, h('span', {}, 'Header'), header), h('label', { class: 'field' }, h('span', {}, 'Payload'), payload)),
    h(
      'div',
      { class: 'row-form' },
      h('button', { type: 'button', class: 'chip', onclick: () => editClaim((p) => ((p.iat = now()), (p.exp = now() + 3600))) }, '⏱ Expires in 1h'),
      h('button', { type: 'button', class: 'chip', onclick: () => editClaim((p) => (p.exp = now() + 86400)) }, '📅 Expires in 1 day'),
      h('button', { type: 'button', class: 'chip', onclick: () => editClaim((p) => (p.exp = now() - 60)) }, '💀 Already expired'),
    ),
    h('div', { class: 'row-form' }, alg, secret),
    h(
      'div',
      { class: 'row-form' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn primary',
          onclick: async () => {
            try {
              const hd = { ...JSON.parse(header.value || '{}'), alg: alg.value };
              out.value = await signJwt(hd, JSON.parse(payload.value || '{}'), secret.value);
              toast('🔑 Token signed');
            } catch (e) {
              toast(e.message);
            }
          },
        },
        'Sign token',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn',
          onclick: async () => {
            const tok = findJwt(input.value);
            if (!tok) return toast('Paste a token above first');
            try {
              const ok = await verifyHmac(tok, secret.value);
              verifyOut.textContent = ok === null ? 'Only HS* tokens can be verified here' : ok ? '✅ Signature matches this secret' : '❌ Signature doesn’t match';
            } catch (e) {
              verifyOut.textContent = e.message;
            }
          },
        },
        'Verify with secret',
      ),
      verifyOut,
    ),
    out,
    h('div', { class: 'row-form' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => out.value && copyText(out.value) }, 'Copy signed token')),
    h('p', { class: 'muted small' }, 'Re-signing is for your own test environments. Everything happens locally; nothing is sent anywhere.'),
  );
  return card('jwt', '🔑 JWT', input, view, h('details', { class: 'sub' }, h('summary', {}, 'Edit & re-sign (HS256/384/512)'), editor));
}

function b64Tool() {
  const input = area({ placeholder: 'Text or Base64', 'aria-label': 'Base64 input' });
  const output = area({ readonly: true, 'aria-label': 'Base64 output' });
  const urlSafe = h('input', { type: 'checkbox', id: 'b64-url' });
  const note = h('span', { class: 'muted small' });
  const encode = () => {
    output.value = utf8ToB64(input.value, { url: urlSafe.checked });
    note.textContent = `${output.value.length} chars`;
  };
  const decode = () => {
    try {
      const text = b64ToUtf8(input.value);
      if (looksBinary(text)) {
        const bytes = b64ToBytes(input.value);
        output.value = [...bytes.slice(0, 512)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
        note.textContent = `Binary data, ${bytes.length} bytes (hex preview)`;
        return;
      }
      try {
        output.value = JSON.stringify(JSON.parse(text), null, 2);
        note.textContent = 'Decoded JSON';
      } catch {
        output.value = text;
        note.textContent = `${text.length} chars`;
      }
    } catch (e) {
      note.textContent = e.message;
    }
  };
  const file = h('input', { type: 'file', hidden: true });
  file.addEventListener('change', () => {
    const f = file.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      output.value = r.result;
      note.textContent = `${f.name} as a data URL (${output.value.length} chars)`;
    };
    r.readAsDataURL(f);
    file.value = '';
  });
  return card(
    'base64',
    '🔤 Base64',
    input,
    h(
      'div',
      { class: 'row-form' },
      h('button', { type: 'button', class: 'btn primary', onclick: encode }, 'Encode →'),
      h('button', { type: 'button', class: 'btn primary', onclick: decode }, 'Decode →'),
      h('label', { class: 'check', for: 'b64-url' }, urlSafe, 'URL-safe'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => file.click() }, 'File → Base64'),
      file,
      h('button', { type: 'button', class: 'btn ghost', onclick: () => ((input.value = output.value), (output.value = '')) }, '⇅ Swap'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => output.value && copyText(output.value) }, 'Copy'),
      note,
    ),
    output,
  );
}

// The three conversions people ask for by name, plus whatever the bytes say they are.
const FORMATS = [
  { label: '📄 PDF', mime: 'application/pdf', ext: 'pdf' },
  { label: '🖼️ PNG', mime: 'image/png', ext: 'png' },
  { label: '🎵 MP3', mime: 'audio/mpeg', ext: 'mp3' },
];

const WHOLE = '(whole payload)';
const parentOf = (root, path) => path.slice(0, -1).reduce((n, k) => (n == null ? n : n[k]), root);

// A sibling key like fileName / name / attachmentName often carries the real filename.
function nameHint(root, path) {
  const parent = parentOf(root, path);
  if (!parent || typeof parent !== 'object') return '';
  const hit = Object.entries(parent).find(([k, v]) => typeof v === 'string' && /name/i.test(k) && /^[^/\\]{1,120}\.[a-z0-9]{2,5}$/i.test(v.trim()));
  return hit ? hit[1].trim() : '';
}

function fileTool() {
  let bytes = null;
  let type = null;
  let hint = '';
  let url = null;
  let active = null;

  const input = area({ rows: 6, placeholder: 'Paste Base64, a data: URL, or a whole JSON response payload', 'aria-label': 'Base64 or JSON payload' });
  const pattern = h('input', { class: 'input mono', placeholder: '**.content · data.*.fileB64 · *b64* · attachments[0].body', 'aria-label': 'JSON path' });
  const hitsEl = h('div', { class: 'stack' });
  const status = h('div', { class: 'status-line' });
  const note = h('div', { class: 'status-line bad' });
  const preview = h('div', { class: 'b64-preview' });

  const setStatus = (text, ok = true) => {
    status.textContent = text;
    status.classList.toggle('ok', ok);
    status.classList.toggle('bad', !ok);
  };

  const fileName = (ext) => {
    const base = hint.replace(/\.[^.]+$/, '');
    if (!base) return `baton-${stamp()}.${ext}`;
    return hint.toLowerCase().endsWith(`.${ext}`) ? hint : `${base}.${ext}`;
  };

  const showPreview = () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
    if (!bytes) return clear(preview);
    if (type.kind === 'text') {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 8192));
      return clear(preview, h('pre', { class: 'code' }, text + (bytes.length > 8192 ? '\n…' : '')));
    }
    if (type.kind === 'binary' || type.kind === 'empty') {
      const hex = [...bytes.subarray(0, 64)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return clear(preview, h('p', { class: 'muted small' }, 'No preview for this type. First bytes:'), h('pre', { class: 'code' }, hex));
    }
    url = URL.createObjectURL(new Blob([bytes], { type: type.mime }));
    if (type.kind === 'image') return clear(preview, h('img', { src: url, class: 'b64-img', alt: 'Decoded image' }));
    if (type.kind === 'audio') return clear(preview, h('audio', { src: url, controls: true, class: 'b64-audio' }));
    if (type.kind === 'video') return clear(preview, h('video', { src: url, controls: true, class: 'b64-video' }));
    clear(
      preview,
      h('iframe', { src: url, class: 'b64-pdf', title: 'Decoded PDF' }),
      h('p', { class: 'muted small' }, 'If the preview stays blank, DevTools is blocking the PDF viewer — save the file and open it instead.'),
    );
  };

  const load = (b64, { path = null, root = null } = {}) => {
    note.textContent = '';
    try {
      bytes = b64ToBytes(b64);
    } catch (e) {
      bytes = null;
      type = null;
      showPreview();
      return setStatus(e.message, false);
    }
    type = sniff(bytes);
    hint = path && root ? nameHint(root, path) : '';
    active = path ? fmtPath(path) || WHOLE : null;
    setStatus(`${type.label} · ${fmtBytes(bytes.length)}${active ? ` · from ${active}` : ''}${hint ? ` · ${hint}` : ''}`, type.kind !== 'empty');
    showPreview();
    renderHits();
  };

  let candidates = [];
  let payload = null;

  const renderHits = () => {
    clear(
      hitsEl,
      candidates.map((c) => {
        const label = fmtPath(c.path) || WHOLE;
        return h(
          'div',
          { class: `snap-item${label === active ? ' current' : ''}` },
          h('div', { class: 'toggle-text' }, h('strong', {}, c.type ? c.type.label : 'Not decodable'), h('code', {}, `${label} · ${fmtBytes(c.size)}`)),
          h('button', { type: 'button', class: label === active ? 'btn primary' : 'btn ghost', onclick: () => load(c.value, { path: c.path, root: payload }) }, label === active ? 'Loaded' : 'Use'),
        );
      }),
    );
  };

  const annotate = (hits) => hits.filter((x) => typeof x.value === 'string').map((x) => ({ ...x, type: sniffB64(x.value), size: b64Size(x.value) }));
  const knownFirst = (a, b) => Number(!!b.type && !['binary', 'empty'].includes(b.type.kind)) - Number(!!a.type && !['binary', 'empty'].includes(a.type.kind)) || b.size - a.size;

  const run = () => {
    const raw = input.value.trim();
    candidates = [];
    payload = null;
    active = null;
    clear(hitsEl);
    if (!raw) return setStatus('Paste something first', false);

    payload = parseJson(raw);
    if (!payload) return load(raw); // a plain Base64 string or data: URL

    const path = pattern.value.trim();
    const hits = path ? pick(payload, path) : findB64(payload);
    candidates = annotate(hits);
    if (!path) candidates.sort(knownFirst);
    if (!candidates.length) {
      bytes = null;
      showPreview();
      return setStatus(path ? (hits.length ? `${path} matched ${hits.length} value(s), but none were strings` : `Nothing in the payload matches ${path}`) : 'No Base64-looking strings in that payload — try a path like **.content', false);
    }
    const best = candidates[0];
    load(best.value, { path: best.path, root: payload });
  };

  const saveAs = (fmt) => {
    if (!bytes) return toast('Load something first');
    const f = fmt || type;
    note.textContent = fmt && type.mime !== fmt.mime && !['binary', 'empty'].includes(type.kind) ? `Saved as .${fmt.ext}, but these bytes look like ${type.label}.` : '';
    downloadBlob(fileName(f.ext), new Blob([bytes], { type: f.mime }));
    toast(`💾 Saved as .${f.ext}`);
  };

  const el = card(
    'b64file',
    '📄 Base64 → file',
    h('p', { class: 'muted small' }, 'Turn a Base64 blob into a PDF, PNG, MP3 or whatever it really is. Paste a whole JSON response and Baton finds the Base64 in it; narrow it down with a path if there are several.'),
    input,
    h('div', { class: 'row-form' }, pattern, h('button', { type: 'button', class: 'btn primary', onclick: run }, 'Find & decode →'), h('button', { type: 'button', class: 'btn ghost', onclick: () => ((pattern.value = ''), run()) }, '🔎 Find any')),
    status,
    hitsEl,
    h(
      'div',
      { class: 'row-form' },
      FORMATS.map((f) => h('button', { type: 'button', class: 'btn', onclick: () => saveAs(f) }, `Save ${f.label}`)),
      h('button', { type: 'button', class: 'btn primary', onclick: () => saveAs(null) }, '💾 Save as detected'),
    ),
    note,
    h(
      'div',
      { class: 'row-form' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn ghost',
          onclick: async () => {
            if (!bytes) return toast('Load something first');
            const name = fileName(type.ext);
            await addMedia({ kind: type.kind === 'image' ? 'image' : 'file', name, mime: type.mime, blob: new Blob([bytes], { type: type.mime }), size: bytes.length });
            toast(`📎 ${name} added to the report`);
          },
        },
        '📎 Add to report',
      ),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => (bytes ? copyText(`data:${type.mime};base64,${bytesToB64(bytes)}`) : toast('Load something first')) }, 'Copy data URL'),
    ),
    preview,
  );

  // Hand-off from a network response: Network → “📄 Base64 → file”.
  on('b64-payload', (text) => {
    input.value = text;
    pattern.value = '';
    run();
    el.scrollIntoView({ block: 'nearest' });
  });

  return el;
}

const ID_ENCODINGS = [
  ['', 'No encoding'],
  ['base64', 'Base 64'],
  ['rfc7515', 'RFC 7515 (base64url)'],
  ['url', 'URL encode'],
];

function idTool() {
  const state = { kind: 'v4', count: 1, uppercase: false, hyphens: true, braces: false, quotes: false, commas: false, encoding: '', size: 21, alphabet: NANO_ALPHABET };
  const out = area({ rows: 8, readonly: true, spellcheck: false, 'aria-label': 'Generated IDs' });
  const note = h('div', { class: 'status-line' });
  const kindRow = h('div', { class: 'row-form' });
  const count = h('input', { class: 'input', type: 'number', min: 1, max: 1000, value: 1, 'aria-label': 'How many to generate' });
  const sizeIn = h('input', { class: 'input', type: 'number', min: 1, max: 255, value: 21, 'aria-label': 'NanoID length' });
  const alphaIn = h('input', { class: 'input mono', value: NANO_ALPHABET, 'aria-label': 'NanoID alphabet' });
  const encSel = h('select', { class: 'input', 'aria-label': 'Encoding' }, ID_ENCODINGS.map(([v, l]) => h('option', { value: v }, l)));
  const nanoRow = h('div', { class: 'row-form', hidden: true }, h('label', { class: 'field' }, h('span', {}, 'Length'), sizeIn), h('label', { class: 'field grow' }, h('span', {}, 'Alphabet'), alphaIn));

  const check = (key, label, title) => {
    const box = h('input', { type: 'checkbox', id: `id-${key}`, checked: state[key] });
    box.addEventListener('change', () => {
      state[key] = box.checked;
      generate();
    });
    return h('label', { class: 'check', for: `id-${key}`, title }, box, label);
  };
  const hyphenLabel = check('hyphens', 'Hyphens', 'UUIDs only — ULIDs and NanoIDs have none');

  const one = () => {
    const raw = GENERATORS[state.kind].make({ size: state.size, alphabet: state.alphabet });
    const text = formatId(raw, { uppercase: state.uppercase, hyphens: state.hyphens });
    return formatId(encodeId(text, state.encoding), { braces: state.braces, quotes: state.quotes });
  };

  const generate = () => {
    state.count = Math.min(1000, Math.max(1, Math.round(Number(count.value) || 1)));
    count.value = state.count;
    state.size = Math.min(255, Math.max(1, Math.round(Number(sizeIn.value) || 21)));
    state.alphabet = alphaIn.value;
    state.encoding = encSel.value;
    const g = GENERATORS[state.kind];
    try {
      const ids = Array.from({ length: state.count }, one);
      out.value = ids.join(state.commas ? ',\n' : '\n');
      note.className = 'status-line ok';
      note.textContent = `${ids.length} × ${g.label} · ${g.hint}`;
    } catch (e) {
      out.value = '';
      note.className = 'status-line bad';
      note.textContent = e.message;
    }
  };

  const renderKinds = () =>
    clear(
      kindRow,
      Object.entries(GENERATORS).map(([k, g]) =>
        h(
          'button',
          {
            type: 'button',
            class: `chip${state.kind === k ? ' active' : ''}`,
            title: g.hint,
            onclick: () => {
              state.kind = k;
              renderKinds();
              nanoRow.hidden = k !== 'nanoid';
              hyphenLabel.classList.toggle('dim', k !== 'v4' && k !== 'v7');
              generate();
            },
          },
          g.label,
        ),
      ),
    );
  renderKinds();
  for (const el of [count, sizeIn, alphaIn, encSel]) el.addEventListener('change', generate);
  generate();

  return card(
    'ids',
    '🆔 ID generator',
    kindRow,
    h('div', { class: 'row-form' }, h('label', { class: 'field' }, h('span', {}, 'How many (1–1000)'), count), h('label', { class: 'field grow' }, h('span', {}, 'Encoding'), encSel)),
    nanoRow,
    h('div', { class: 'row-form' }, hyphenLabel, check('braces', '{} Braces'), check('uppercase', 'Uppercase'), check('quotes', '" " Quotes'), check('commas', ', Commas')),
    h(
      'div',
      { class: 'row-form' },
      h('button', { type: 'button', class: 'btn primary', onclick: generate }, '🎲 Generate'),
      h('button', { type: 'button', class: 'btn', onclick: () => out.value && copyText(out.value) }, 'Copy'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => out.value && download(`${state.kind}-ids.txt`, out.value) }, 'Download .txt'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => (out.value ? emit('id-decode', out.value.split('\n')[0].replace(/[",]/g, '')) : toast('Generate one first')) }, 'Decode the first →'),
      note,
    ),
    out,
    h('p', { class: 'muted small' }, 'v7 and ULID carry the time they were made, and a batch generated in the same millisecond still sorts in order. Base 64 encodes the 128 raw bits of a UUID or ULID (so 22–24 chars), and the text of a NanoID.'),
  );
}

function idInspectTool() {
  const input = area({ rows: 2, placeholder: 'Paste a UUID, ULID or NanoID', 'aria-label': 'ID to decode' });
  const status = h('div', { class: 'status-line' });
  const table = h('div', {});
  const notesEl = h('div', { class: 'stack' });
  let canonical = '';

  const fail = (msg) => {
    canonical = '';
    status.className = 'status-line bad';
    status.textContent = `❌ ${msg}`;
    clear(table);
    clear(notesEl);
  };
  const pass = (label, rows, notes = []) => {
    status.className = 'status-line ok';
    status.textContent = `✅ ${label}`;
    clear(table, kvRows(rows));
    clear(notesEl, notes.map((n) => h('p', { class: 'muted small' }, n)));
  };

  const decode = () => {
    const raw = input.value.trim();
    if (!raw) {
      canonical = '';
      status.className = 'status-line';
      status.textContent = '';
      clear(table);
      clear(notesEl);
      return;
    }
    const kind = identify(raw);
    if (kind === 'ulid') {
      const d = decodeUlid(raw);
      if (!d.ok) return fail(d.error);
      canonical = d.canonical;
      return pass('Valid ULID', [
        ['ULID', d.canonical],
        ['Created', `${d.date} (${d.timestamp})`],
        ['Randomness', d.randomness],
        ['Same 128 bits as UUID', d.uuid],
      ]);
    }
    if (kind === 'nanoid') {
      const d = describeNanoId(raw);
      if (!d.ok) return fail(d.error);
      canonical = d.canonical;
      return pass(
        'Looks like a NanoID',
        [
          ['Length', `${d.length} characters${d.isDefaultLength ? ' (the default)' : ''}`],
          ['Distinct characters', d.distinct],
          ['Entropy', `~${d.bits} bits, assuming the standard 64-character alphabet`],
        ],
        ['A NanoID has no structure to read — no version and no timestamp — so this only checks the alphabet and reports its strength.'],
      );
    }
    const d = decodeUuid(raw);
    if (!d.ok) return fail(d.error);
    canonical = d.canonical;
    pass(
      d.special || `Valid UUID ${d.versionLabel.split(' ')[0]}`,
      [
        ['UUID', d.canonical],
        ['Version', d.versionLabel],
        ['Variant', d.variantLabel],
        d.date && ['Created', `${d.date} (${d.timestamp})`],
        d.counter !== undefined && ['Sub-ms counter', d.counter],
        d.clockSeq !== undefined && ['Clock sequence', d.clockSeq],
        d.node && ['Node', `${d.node}${d.nodeIsRandom ? ' (random)' : ''}`],
        d.localDomain && ['Local domain', d.localDomain],
        d.localId !== undefined && ['Local id', d.localId],
        ['Hex', d.hex],
        ['Base 64', encodeId(d.canonical, 'base64')],
      ],
      d.notes,
    );
  };
  input.addEventListener('input', decode);

  const el = card(
    'idcheck',
    '🔍 ID decoder & validator',
    input,
    status,
    table,
    notesEl,
    h(
      'div',
      { class: 'row-form' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => (canonical ? copyText(canonical) : toast('Paste an ID first')) }, 'Copy canonical form'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => ((input.value = ''), decode()) }, 'Clear'),
    ),
  );
  on('id-decode', (value) => {
    input.value = value;
    decode();
    el.open = true;
    el.scrollIntoView({ block: 'nearest' });
  });
  return el;
}

function urlTool() {
  const input = area({ rows: 3, placeholder: 'https://example.com/search?q=hello world&tags=a,b', 'aria-label': 'URL tool input' });
  const output = area({ rows: 3, readonly: true, 'aria-label': 'URL tool output' });
  const params = h('div', {});
  const run = (fn) => {
    try {
      output.value = fn(input.value);
    } catch (e) {
      output.value = `Error: ${e.message}`;
    }
  };
  const parse = () => {
    try {
      const u = new URL(input.value.trim());
      const rows = [['origin', u.origin], ['path', u.pathname], ['hash', u.hash || '—'], ...[...u.searchParams].map(([k, v]) => [`?${k}`, v])];
      clear(params, h('table', { class: 'kv' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))))));
    } catch {
      clear(params, h('div', { class: 'muted small' }, 'Not a full URL'));
    }
  };
  return card(
    'url',
    '🔗 URL encode / decode',
    input,
    h(
      'div',
      { class: 'row-form' },
      h('button', { type: 'button', class: 'btn', onclick: () => run(encodeURIComponent) }, 'Encode'),
      h('button', { type: 'button', class: 'btn', onclick: () => run((s) => decodeURIComponent(s.replace(/\+/g, ' '))) }, 'Decode'),
      h('button', { type: 'button', class: 'btn', onclick: parse }, 'Parse URL'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => output.value && copyText(output.value) }, 'Copy'),
    ),
    output,
    params,
  );
}

function npmrcTool({ standalone }) {
  let text = '';
  let handle = null;
  let fileName = '.npmrc';
  let dirty = false;
  const editor = area({ rows: 12, spellcheck: false, 'aria-label': '.npmrc contents' });
  const masked = h('pre', { class: 'code' });
  const showBox = h('input', { type: 'checkbox', id: 'npmrc-show' });
  const status = h('span', { class: 'muted small' });
  const credsEl = h('div', { class: 'stack' });
  const sync = () => {
    editor.hidden = !showBox.checked;
    masked.hidden = showBox.checked;
    masked.textContent = maskNpmrc(text) || '(empty)';
    status.textContent = `${fileName}${handle ? '' : ' (not linked to a file: Save downloads a copy)'}${dirty ? ' · unsaved changes' : ''}`;
    renderCreds();
  };
  editor.addEventListener('input', () => {
    text = editor.value;
    dirty = true;
    sync();
  });
  showBox.addEventListener('change', () => {
    editor.value = text;
    sync();
  });

  const setText = (t, markDirty = true) => {
    text = t;
    editor.value = t;
    dirty = markDirty;
    sync();
  };

  const renderCreds = () => {
    const creds = credentials(text);
    clear(
      credsEl,
      creds.length
        ? creds.map((c) =>
            h(
              'div',
              { class: 'snap-item' },
              h('div', { class: 'toggle-text' }, h('strong', {}, c.azure ? `Azure DevOps · ${c.org}${c.feed ? ` / ${c.feed}` : ''}` : c.prefix), h('code', {}, `${c.prefix} · ${c.kind || 'no token'}${c.token ? ` · ${c.token.slice(0, 4)}…(${c.token.length} chars)` : ''}`)),
              c.token ? h('button', { type: 'button', class: 'btn ghost', onclick: () => copyText(c.token) }, 'Copy token') : null,
              c.token && c.azure
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn',
                      onclick: async () => {
                        const cfg = await getStored('azure', {});
                        await setStored('azure', { ...cfg, pat: c.token, org: cfg.org || c.org });
                        emit('azure-changed', { ...cfg, pat: c.token, org: cfg.org || c.org });
                        toast('Token saved for Azure Boards');
                      },
                    },
                    'Use for Azure Boards',
                  )
                : null,
            ),
          )
        : h('div', { class: 'muted small' }, text ? 'No registry credentials found.' : 'Open your .npmrc to see its credentials.'),
    );
  };

  const open = async () => {
    if (window.showOpenFilePicker) {
      try {
        const [hnd] = await window.showOpenFilePicker({ multiple: false, excludeAcceptAllOption: false });
        handle = hnd;
        fileName = hnd.name;
        setText(await (await hnd.getFile()).text(), false);
        toast(`Opened ${hnd.name}`);
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (!standalone) {
          // DevTools panels can't show file pickers that write back; use the tools tab.
          toast('Opening the .npmrc editor in a tab so it can save back to the file');
          chrome.runtime.sendMessage({ type: 'open-tools', hash: '#npmrc' });
          return;
        }
      }
    }
    fileInput.click();
  };
  const fileInput = h('input', { type: 'file', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    handle = null;
    fileName = f.name;
    setText(await f.text(), false);
    fileInput.value = '';
  });
  const save = async () => {
    if (handle) {
      try {
        if ((await handle.queryPermission?.({ mode: 'readwrite' })) !== 'granted') await handle.requestPermission?.({ mode: 'readwrite' });
        const w = await handle.createWritable();
        await w.write(text);
        await w.close();
        dirty = false;
        sync();
        return toast(`💾 Saved ${fileName}`);
      } catch (e) {
        toast(`Couldn’t write the file (${e.message}). Downloading a copy instead.`);
      }
    }
    download('.npmrc', text, 'text/plain');
    dirty = false;
    sync();
  };

  // Rotate
  const newPat = h('input', { class: 'input mono', type: 'password', placeholder: 'New Azure DevOps PAT', 'aria-label': 'New PAT' });
  // Generate
  const g = { org: '', project: '', feed: '', pat: '' };
  const gIn = (k, ph, type = 'text') => {
    const el = h('input', { class: 'input mono', placeholder: ph, type, 'aria-label': ph });
    el.addEventListener('input', () => (g[k] = el.value.trim()));
    return el;
  };
  const regBox = h('input', { type: 'checkbox', id: 'npmrc-reg' });

  sync();
  return card(
    'npmrc',
    '📦 .npmrc',
    h('p', { class: 'muted small' }, 'Open your user .npmrc (~/.npmrc, or %USERPROFILE%\\.npmrc on Windows) or a project one. Rotate an expired Azure DevOps PAT in one go, or add a feed. Secrets stay on this machine. On a Mac, press ⌘⇧. in the picker to show hidden files.'),
    h(
      'div',
      { class: 'row-form' },
      h('button', { type: 'button', class: 'btn primary', onclick: open }, 'Open .npmrc…'),
      fileInput,
      h('button', { type: 'button', class: 'btn', onclick: save }, '💾 Save'),
      h('label', { class: 'check', for: 'npmrc-show' }, showBox, 'Show & edit secrets'),
      status,
    ),
    masked,
    editor,
    h('div', { class: 'section-head' }, h('h2', {}, 'Credentials found')),
    credsEl,
    h(
      'details',
      { class: 'sub', open: true },
      h('summary', {}, '🔁 Rotate Azure DevOps token'),
      h('p', { class: 'muted small' }, 'Replaces every Azure DevOps _password (base64) and _authToken in this file with the new PAT.'),
      h(
        'div',
        { class: 'row-form' },
        newPat,
        h(
          'button',
          {
            type: 'button',
            class: 'btn primary',
            onclick: () => {
              if (!newPat.value.trim()) return toast('Paste the new PAT first');
              const r = setToken(text, newPat.value.trim(), 'azure');
              if (!r.changed) return toast('No Azure DevOps credentials found to replace');
              setText(r.text);
              newPat.value = '';
              toast(`🔁 Updated ${r.changed} line${r.changed === 1 ? '' : 's'}. Click Save to write the file.`);
            },
          },
          'Replace tokens',
        ),
      ),
    ),
    h(
      'details',
      { class: 'sub' },
      h('summary', {}, '➕ Add an Azure Artifacts feed'),
      h('div', { class: 'grid-2' }, gIn('org', 'Organization'), gIn('project', 'Project (only for project-scoped feeds)'), gIn('feed', 'Feed name'), gIn('pat', 'PAT (Packaging read)', 'password')),
      h('label', { class: 'check', for: 'npmrc-reg' }, regBox, 'Also add registry= and always-auth (project .npmrc)'),
      h(
        'div',
        { class: 'row-form' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn',
            onclick: () => {
              if (!g.org || !g.feed || !g.pat) return toast('Organization, feed and PAT are required');
              setText(`${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${azureBlock({ ...g, includeRegistry: regBox.checked })}\n`);
              toast('Feed added. Click Save to write the file.');
            },
          },
          'Append block',
        ),
      ),
    ),
  );
}

export function mountTools(container, { standalone = false } = {}) {
  clear(
    container,
    h(
      'div',
      { class: 'tools-grid' },
      h('div', { class: 'stack' }, jwtTool(), b64Tool(), fileTool(), urlTool()),
      h('div', { class: 'stack' }, idTool(), idInspectTool(), npmrcTool({ standalone })),
    ),
  );
  // Each card() sets its own element id, so #npmrc or #ids in the URL jumps to it.
  const target = location.hash && container.querySelector(location.hash);
  if (target) {
    target.open = true;
    target.scrollIntoView();
  }
}
