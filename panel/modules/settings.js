import { h, clear, toast } from '../lib/dom.js';
import { getStored, setStored, emit } from '../lib/settings.js';
import { normalizeOrg, parseNpmrc, listProjects, listWorkItemTypes, listClassificationNodes, listStories, getWorkItem, STORY_TYPES } from '../lib/azure.js';

const KEY = 'azure';
const DEFAULT_CFG = { org: '', pat: '', project: '', type: 'Bug', areaPath: '', iterationPath: '', tags: 'baton', attach: true, parentId: null, parentTitle: '' };

export async function loadAzureConfig() {
  return { ...DEFAULT_CFG, ...(await getStored(KEY, {})) };
}

export function isAzureReady(cfg) {
  return !!(cfg.org && cfg.pat && cfg.project);
}

let root, statusEl, cfg, giphyKey = '';
let projects = [];
let types = [];
let iterations = [];
let areas = [];
let stories = [];
let storyEls = null;

function setStatus(msg, kind = '') {
  statusEl.className = `status-line ${kind}`;
  statusEl.textContent = msg;
}

async function save(patch) {
  cfg = { ...cfg, ...patch };
  await setStored(KEY, cfg);
  emit('azure-changed', cfg);
}

// Only the backlog types this project actually has, so the story list isn't
// filtered down to nothing on a custom process template.
const storyTypes = () => STORY_TYPES.filter((t) => types.includes(t));

async function loadNodes() {
  [iterations, areas] = await Promise.all([listClassificationNodes(cfg, cfg.project, 'iterations').catch(() => []), listClassificationNodes(cfg, cfg.project, 'areas').catch(() => [])]);
}

async function connect() {
  setStatus('Connecting…');
  try {
    projects = await listProjects(cfg);
    if (!projects.length) throw new Error('Connected, but the PAT can’t see any projects.');
    if (!projects.includes(cfg.project)) await save({ project: projects[0] });
    types = await listWorkItemTypes(cfg, cfg.project);
    if (!types.includes(cfg.type)) await save({ type: types.includes('Bug') ? 'Bug' : types.includes('Issue') ? 'Issue' : types[0] });
    await loadNodes();
    setStatus(`Connected to ${cfg.org} · ${projects.length} project${projects.length === 1 ? '' : 's'} · ${iterations.length} iteration${iterations.length === 1 ? '' : 's'}`, 'ok');
  } catch (err) {
    setStatus(err.message, 'bad');
  }
  render();
  if (isAzureReady(cfg) && iterations.length) loadStories();
}

// ---- the story (parent work item) picker ------------------------------------
// These elements outlive re-renders, so typing in the search box isn't
// interrupted every time something else on the page changes.
function ensureStoryEls() {
  if (storyEls) return storyEls;
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search titles…', 'aria-label': 'Search work items' });
  const onlySprint = h('input', { type: 'checkbox', id: 'az-only-sprint', checked: true });
  const sel = h('select', { class: 'input', id: 'az-parent', 'aria-label': 'Story to link bugs to' });
  const status = h('div', { class: 'status-line', role: 'status' });
  const idIn = h('input', { class: 'input', type: 'number', min: 1, placeholder: '…or a work item id', 'aria-label': 'Work item id' });
  search.addEventListener('keydown', (e) => e.key === 'Enter' && loadStories());
  onlySprint.addEventListener('change', loadStories);
  sel.addEventListener('change', () => {
    const id = Number(sel.value) || null;
    const picked = stories.find((s) => s.id === id);
    save({ parentId: id, parentTitle: picked ? picked.title : id ? cfg.parentTitle : '' }).then(render);
  });
  storyEls = { search, onlySprint, sel, status, idIn };
  return storyEls;
}

function renderStoryOptions() {
  const { sel } = ensureStoryEls();
  clear(
    sel,
    h('option', { value: '' }, '— no parent —'),
    stories.map((s) => h('option', { value: String(s.id) }, `#${s.id} · ${s.type}${s.state ? ` · ${s.state}` : ''} — ${s.title}`)),
  );
  // Keep a saved parent selectable even when it isn't in the current results.
  if (cfg.parentId && !stories.some((s) => s.id === cfg.parentId)) sel.append(h('option', { value: String(cfg.parentId) }, `#${cfg.parentId} — ${cfg.parentTitle || 'saved'}`));
  sel.value = cfg.parentId ? String(cfg.parentId) : '';
}

async function loadStories() {
  const els = ensureStoryEls();
  if (!isAzureReady(cfg)) return;
  els.status.className = 'status-line';
  els.status.textContent = 'Looking for work items…';
  try {
    stories = await listStories(cfg, cfg.project, {
      types: storyTypes(),
      iterationPath: els.onlySprint.checked ? cfg.iterationPath : '',
      search: els.search.value.trim(),
    });
    renderStoryOptions();
    const scope = els.onlySprint.checked && cfg.iterationPath ? ` in ${cfg.iterationPath}` : ' across the project';
    els.status.className = `status-line ${stories.length ? 'ok' : 'bad'}`;
    els.status.textContent = stories.length ? `${stories.length} work item${stories.length === 1 ? '' : 's'}${scope}` : `Nothing found${scope}. Try another sprint, clear the search, or untick “Only this sprint”.`;
  } catch (err) {
    els.status.className = 'status-line bad';
    els.status.textContent = err.message;
  }
}

async function useTypedId() {
  const els = ensureStoryEls();
  const id = Number(els.idIn.value);
  if (!id) return toast('Enter a work item id first');
  els.status.className = 'status-line';
  els.status.textContent = `Checking #${id}…`;
  try {
    const item = await getWorkItem(cfg, id);
    await save({ parentId: item.id, parentTitle: item.title });
    stories = [item, ...stories.filter((s) => s.id !== item.id)];
    els.idIn.value = '';
    render();
    els.status.className = 'status-line ok';
    els.status.textContent = `#${item.id} · ${item.type} — ${item.title}`;
  } catch (err) {
    els.status.className = 'status-line bad';
    els.status.textContent = err.message;
  }
}

const shortDate = (s) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

function render() {
  const field = (key, label, attrs = {}) => {
    const input = h('input', { class: 'input', id: `az-${key}`, ...attrs });
    input.value = cfg[key] || '';
    input.addEventListener('change', () => save({ [key]: key === 'org' ? normalizeOrg(input.value) : input.value.trim() }).then(() => key === 'org' && render()));
    return h('label', { class: 'field', for: `az-${key}` }, h('span', {}, label), input);
  };

  // A real picker once the tree has loaded; plain text until then, so settings
  // still work — and keep what you typed — without a connection.
  const pathPicker = (key, label, nodes, placeholder) => {
    if (!nodes.length) return field(key, label, { placeholder });
    const sel = h('select', { class: 'input', id: `az-${key}` }, [
      h('option', { value: '' }, '— none —'),
      // Indent with non-breaking spaces: browsers collapse ordinary leading
      // whitespace in an <option>, which would flatten the tree.
      ...nodes.map((n) => {
        const span = n.startDate ? ` (${shortDate(n.startDate)}–${shortDate(n.finishDate)})` : '';
        return h('option', { value: n.path }, `${'\u00a0\u00a0'.repeat(n.depth)}${n.name}${span}`);
      }),
    ]);
    if (cfg[key] && !nodes.some((n) => n.path === cfg[key])) sel.append(h('option', { value: cfg[key] }, `${cfg[key]} (saved)`));
    sel.value = cfg[key] || '';
    sel.addEventListener('change', async () => {
      await save({ [key]: sel.value });
      if (key === 'iterationPath') loadStories();
    });
    return h('label', { class: 'field', for: `az-${key}` }, h('span', {}, label), sel);
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
    await save({ project: projectSel.value, parentId: null, parentTitle: '', iterationPath: '', areaPath: '' });
    types = await listWorkItemTypes(cfg, cfg.project).catch(() => []);
    stories = [];
    await loadNodes();
    render();
    loadStories();
  });
  const typeSel = h('select', { class: 'input', id: 'az-type', disabled: !types.length }, (types.length ? types : [cfg.type]).map((t) => h('option', { value: t }, t)));
  typeSel.value = cfg.type;
  typeSel.addEventListener('change', () => save({ type: typeSel.value }));
  const attachBox = h('input', { type: 'checkbox', id: 'az-attach', checked: cfg.attach });
  attachBox.addEventListener('change', () => save({ attach: attachBox.checked }));

  const els = ensureStoryEls();
  renderStoryOptions();

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
                  iterations = [];
                  areas = [];
                  stories = [];
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
      h('div', { class: 'grid-2' }, pathPicker('areaPath', 'Area path (optional)', areas, 'Project\\Team'), pathPicker('iterationPath', 'Sprint / iteration (optional)', iterations, 'Project\\Sprint 12')),
      field('tags', 'Tags (semicolon separated)', { placeholder: 'baton; qa' }),
      h('label', { class: 'check', for: 'az-attach' }, attachBox, 'Attach the .baton.json bundle to each bug'),
      h('p', { class: 'muted small' }, 'The PAT is stored in this browser profile’s extension storage (not encrypted) and only sent to dev.azure.com. Use “Forget PAT” on shared machines.'),
    ),
    h(
      'section',
      { class: 'card stack narrow' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Link bugs to a story')),
      h('p', { class: 'muted small' }, 'Pick the sprint above, then the story this round of testing is for. Every bug Baton creates is added as a child of it, so it turns up on the story in the board.'),
      isAzureReady(cfg) ? null : h('p', { class: 'notice small' }, 'Connect to Azure Boards above to load sprints and stories.'),
      h(
        'div',
        { class: 'row-form' },
        els.search,
        h('label', { class: 'check', for: 'az-only-sprint' }, els.onlySprint, 'Only this sprint'),
        h('button', { type: 'button', class: 'btn', onclick: loadStories, disabled: !isAzureReady(cfg) }, '🔎 Find stories'),
      ),
      h('label', { class: 'field', for: 'az-parent' }, h('span', {}, `Story${storyTypes().length ? ` (${storyTypes().join(', ')})` : ''}`), els.sel),
      els.status,
      h(
        'div',
        { class: 'row-form' },
        els.idIn,
        h('button', { type: 'button', class: 'btn', onclick: useTypedId, disabled: !isAzureReady(cfg) }, 'Use this id'),
        cfg.parentId ? h('button', { type: 'button', class: 'btn ghost', onclick: () => save({ parentId: null, parentTitle: '' }).then(render) }, 'Clear parent') : null,
      ),
      cfg.parentId
        ? h('p', { class: 'status-line ok' }, `New ${cfg.type || 'Bug'}s will be created under #${cfg.parentId}${cfg.parentTitle ? ` — ${cfg.parentTitle}` : ''}`)
        : h('p', { class: 'muted small' }, 'No parent set: bugs are created on their own.'),
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
