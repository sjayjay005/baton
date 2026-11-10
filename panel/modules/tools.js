// Tools: JWT decode / edit / sign, Base64 & URL encode-decode, and the .npmrc editor.
// Works both inside DevTools and in the standalone tools page (no devtools APIs here).
import { h, clear, copyText, toast, download } from '../lib/dom.js';
import { getStored, setStored, emit } from '../lib/settings.js';
import { decodeJwt, signJwt, verifyHmac, findJwt } from '../lib/jwt.js';
import { jwtDetails } from '../lib/jwtview.js';
import { utf8ToB64, b64ToUtf8, b64ToBytes, looksBinary } from '../lib/b64.js';
import { credentials, setToken, maskNpmrc, azureBlock } from '../lib/npmrc.js';

const card = (title, ...kids) => h('section', { class: 'card stack' }, h('div', { class: 'section-head' }, h('h2', {}, title)), ...kids);
const area = (attrs) => h('textarea', { class: 'input mono', rows: 5, ...attrs });

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
  return card('🔑 JWT', input, view, h('details', { class: 'sub' }, h('summary', {}, 'Edit & re-sign (HS256/384/512)'), editor));
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
  const npm = npmrcTool({ standalone });
  npm.id = 'npmrc';
  clear(container, h('div', { class: 'tools-grid' }, h('div', { class: 'stack' }, jwtTool(), b64Tool(), urlTool()), h('div', { class: 'stack' }, npm)));
  if (location.hash === '#npmrc') npm.scrollIntoView();
}
