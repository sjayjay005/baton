import { h, clear, toast } from '../lib/dom.js';
import { getStored, setStored, emit } from '../lib/settings.js';
import { normalizeOrg, parseNpmrc, listProjects, listWorkItemTypes } from '../lib/azure.js';

const KEY = 'azure';
const DEFAULT_CFG = { org: '', pat: '', project: '', type: 'Bug', areaPath: '', iterationPath: '', tags: 'baton', attach: true };

export async function loadAzureConfig() {
  return { ...DEFAULT_CFG, ...(await getStored(KEY, {})) };
}

export function isAzureReady(cfg) {
  return !!(cfg.org && cfg.pat && cfg.project);
}

let root, statusEl, cfg, giphyKey = '';
let projects = [];
let types = [];

function setStatus(msg, kind = '') {
  statusEl.className = `status-line ${kind}`;
  statusEl.textContent = msg;
}

async function save(patch) {
  cfg = { ...cfg, ...patch };
  await setStored(KEY, cfg);
  emit('azure-changed', cfg);
}

async function connect() {
  setStatus('Connecting…');
  try {
    projects = await listProjects(cfg);
    if (!projects.length) throw new Error('Connected, but the PAT can’t see any projects.');
    if (!projects.includes(cfg.project)) await save({ project: projects[0] });
    types = await listWorkItemTypes(cfg, cfg.project);
    if (!types.includes(cfg.type)) await save({ type: types.includes('Bug') ? 'Bug' : types.includes('Issue') ? 'Issue' : types[0] });
    setStatus(`Connected to ${cfg.org} · ${projects.length} project${projects.length === 1 ? '' : 's'}`, 'ok');
  } catch (err) {
    setStatus(err.message, 'bad');
  }
  render();
}

function render() {
  const field = (key, label, attrs = {}) => {
    const input = h('input', { class: 'input', id: `az-${key}`, ...attrs });
    input.value = cfg[key] || '';
    input.addEventListener('change', () => save({ [key]: key === 'org' ? normalizeOrg(input.value) : input.value.trim() }).then(() => key === 'org' && render()));
    return h('label', { class: 'field', for: `az-${key}` }, h('span', {}, label), input);
  };

  const patInput = h('input', { class: 'input mono', id: 'az-pat', type: 'password', autocomplete: 'off', placeholder: cfg.pat ? '•••••••• saved' : 'Paste a Personal Access Token' });
  patInput.addEventListener('change', () => {
    if (patInput.value.trim()) save({ pat: patInput.value.trim() }).then(() => toast('PAT saved'));
  });

  const npmrcFile = h('input', { type: 'file', hidden: true });
  const npmrcText = h('textarea', { class: 'input mono', rows: 4, placeholder: '//pkgs.dev.azure.com/ORG/_packaging/FEED/npm/registry/:_password=…', 'aria-label': '.npmrc contents' });
  const useNpmrc = async (text) => {
    const found = parseNpmrc(text);
    if (!found.length) return toast('No Azure DevOps token found in that .npmrc');
    const best = found.find((f) => f.org) || found[0];
    await save({ pat: best.pat, org: cfg.org || best.org });
    npmrcText.value = '';
    toast(`Token imported${best.org ? ` for ${best.org}` : ''}`);
    render();
    connect();
  };
  npmrcFile.addEventListener('change', async () => {
    if (npmrcFile.files[0]) await useNpmrc(await npmrcFile.files[0].text());
    npmrcFile.value = '';
  });

  const projectSel = h('select', { class: 'input', id: 'az-project', disabled: !projects.length }, (projects.length ? projects : [cfg.project || 'Connect to load projects']).map((p) => h('option', { value: p }, p)));
  projectSel.value = cfg.project;
  projectSel.addEventListener('change', async () => {
    await save({ project: projectSel.value });
    types = await listWorkItemTypes(cfg, cfg.project).catch(() => []);
    render();
  });
  const typeSel = h('select', { class: 'input', id: 'az-type', disabled: !types.length }, (types.length ? types : [cfg.type]).map((t) => h('option', { value: t }, t)));
  typeSel.value = cfg.type;
  typeSel.addEventListener('change', () => save({ type: typeSel.value }));
  const attachBox = h('input', { type: 'checkbox', id: 'az-attach', checked: cfg.attach });
  attachBox.addEventListener('change', () => save({ attach: attachBox.checked }));

  clear(
    root,
    h(
      'section',
      { class: 'card stack narrow' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Azure Boards')),
      h('p', { class: 'muted small' }, 'Connect once, then create bugs from the Bug report tab straight onto your board.'),
      field('org', 'Organization', { placeholder: 'contoso or https://dev.azure.com/contoso' }),
      h('label', { class: 'field', for: 'az-pat' }, h('span', {}, 'Personal Access Token'), patInput),
      h(
        'details',
        { class: 'sub' },
        h('summary', {}, 'Import the token from your .npmrc'),
        h(
          'p',
          { class: 'muted small' },
          'Azure Artifacts stores it base64-encoded as ',
          h('code', {}, ':_password='),
          ' in the .npmrc in your home folder (',
          h('code', {}, '~/.npmrc'),
          ' or ',
          h('code', {}, '%USERPROFILE%\\.npmrc'),
          '). Pick the file or paste its contents. It’s read here and never uploaded. On a Mac, press ⌘⇧. in the file picker to show hidden files.',
        ),
        h('div', { class: 'row-form' }, h('button', { type: 'button', class: 'btn', onclick: () => npmrcFile.click() }, 'Choose .npmrc file'), npmrcFile),
        npmrcText,
        h('div', { class: 'row-form' }, h('button', { type: 'button', class: 'btn', onclick: () => useNpmrc(npmrcText.value) }, 'Use pasted .npmrc')),
        h('p', { class: 'notice small' }, 'npm feed tokens are often scoped to “Packaging” only. Creating bugs needs “Work Items (Read & write)”. If connecting fails, create a PAT with that scope in Azure DevOps → User settings → Personal access tokens.'),
      ),
      h(
        'div',
        { class: 'row-form' },
        h('button', { type: 'button', class: 'btn primary', onclick: connect }, projects.length ? 'Reconnect' : 'Connect'),
        cfg.pat
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn ghost',
                onclick: async () => {
                  await save({ pat: '' });
                  projects = [];
                  types = [];
                  setStatus('PAT removed.');
                  render();
                },
              },
              'Forget PAT',
            )
          : null,
      ),
      statusEl,
      h('div', { class: 'grid-2' }, h('label', { class: 'field', for: 'az-project' }, h('span', {}, 'Project'), projectSel), h('label', { class: 'field', for: 'az-type' }, h('span', {}, 'Work item type'), typeSel)),
      h('div', { class: 'grid-2' }, field('areaPath', 'Area path (optional)', { placeholder: 'Project\\Team' }), field('iterationPath', 'Iteration (optional)', { placeholder: 'Project\\Sprint 12' })),
      field('tags', 'Tags (semicolon separated)', { placeholder: 'baton; qa' }),
      h('label', { class: 'check', for: 'az-attach' }, attachBox, 'Attach the .baton.json bundle to each bug'),
      h('p', { class: 'muted small' }, 'The PAT is stored in this browser profile’s extension storage (not encrypted) and only sent to dev.azure.com. Use “Forget PAT” on shared machines.'),
    ),
    giphySection(),
  );
}

function giphySection() {
  const input = h('input', { class: 'input mono', id: 'giphy-key', type: 'password', autocomplete: 'off', placeholder: giphyKey ? '•••••••• saved' : 'Paste your GIPHY API key' });
  input.addEventListener('change', async () => {
    giphyKey = input.value.trim();
    await setStored('giphyKey', giphyKey);
    toast(giphyKey ? 'GIPHY key saved 🎞️' : 'GIPHY key removed');
    render();
  });
  return h(
    'section',
    { class: 'card stack narrow' },
    h('div', { class: 'section-head' }, h('h2', {}, 'GIFs 🎞️')),
    h('p', { class: 'muted small' }, 'GIF search uses GIPHY. Get a free key at developers.giphy.com → Create an App → API. Beta keys are rate-limited; you can still paste GIF links or upload GIFs without one.'),
    h('label', { class: 'field', for: 'giphy-key' }, h('span', {}, 'GIPHY API key'), input),
    giphyKey
      ? h('div', { class: 'row-form' }, h('button', { type: 'button', class: 'btn ghost', onclick: async () => { giphyKey = ''; await setStored('giphyKey', ''); render(); } }, 'Remove key'))
      : null,
  );
}

export async function mountSettings(container) {
  giphyKey = await getStored('giphyKey', '');
  root = container;
  statusEl = h('div', { class: 'status-line', role: 'status' });
  cfg = await loadAzureConfig();
  render();
  if (cfg.pat && cfg.org) connect();
}
