import { h, clear, copyText, toast, download } from '../lib/dom.js';
import { loadBookmarks, saveBookmarks, groupBookmarks, normalizeUrl, parseImport, mergeBookmarks, exportJson } from '../lib/bookmarks.js';

let root, listEl, formEl, searchInput;
let list = [];
let query = '';
let editingId = null;

async function persist() {
  await saveBookmarks(list);
  render();
}

function renderForm() {
  const editing = list.find((b) => b.id === editingId);
  const name = h('input', { class: 'input', placeholder: 'Name, e.g. Staging admin', 'aria-label': 'Bookmark name' });
  const url = h('input', { class: 'input', placeholder: 'https://…', 'aria-label': 'Bookmark URL', required: true });
  const group = h('input', { class: 'input', placeholder: 'Group, e.g. Environments', 'aria-label': 'Bookmark group', list: 'bm-groups' });
  if (editing) {
    name.value = editing.name;
    url.value = editing.url;
    group.value = editing.group || '';
  }
  const groups = [...new Set(list.map((b) => b.group).filter(Boolean))];
  clear(
    formEl,
    h('datalist', { id: 'bm-groups' }, groups.map((g) => h('option', { value: g }))),
    h(
      'form',
      {
        class: 'row-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const u = normalizeUrl(url.value);
          if (!u) return toast('Enter a valid http(s) link');
          const item = { id: editingId || crypto.randomUUID(), name: name.value.trim() || new URL(u).hostname, url: u, group: group.value.trim() };
          list = editingId ? list.map((b) => (b.id === editingId ? item : b)) : [...list, item];
          editingId = null;
          await persist();
          toast('Bookmark saved');
        },
      },
      name,
      url,
      group,
      h('button', { type: 'submit', class: 'btn primary' }, editing ? 'Save' : 'Add link'),
      editing ? h('button', { type: 'button', class: 'btn ghost', onclick: () => ((editingId = null), render()) }, 'Cancel') : null,
    ),
  );
}

function renderList() {
  const groups = groupBookmarks(list, query);
  clear(
    listEl,
    groups.length
      ? groups.map(([g, items]) =>
          h(
            'section',
            { class: 'card' },
            h('div', { class: 'section-head' }, h('h2', {}, g), h('span', { class: 'muted small' }, items.length)),
            h(
              'div',
              { class: 'bm-list' },
              items.map((b) =>
                h(
                  'div',
                  { class: 'bm-item' },
                  h('a', { href: b.url, target: '_blank', rel: 'noopener noreferrer', class: 'bm-link' }, h('strong', {}, b.name), h('span', { class: 'muted small mono' }, b.url)),
                  h('button', { type: 'button', class: 'icon-btn', title: 'Copy link', 'aria-label': `Copy ${b.name}`, onclick: () => copyText(b.url) }, '⧉'),
                  h('button', { type: 'button', class: 'icon-btn', title: 'Edit', 'aria-label': `Edit ${b.name}`, onclick: () => ((editingId = b.id), render()) }, '✎'),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'icon-btn',
                      title: 'Delete',
                      'aria-label': `Delete ${b.name}`,
                      onclick: async () => {
                        list = list.filter((x) => x.id !== b.id);
                        await persist();
                      },
                    },
                    '×',
                  ),
                ),
              ),
            ),
          ),
        )
      : h('div', { class: 'empty' }, list.length ? 'No links match.' : 'Add your team’s important links: environments, dashboards, boards, docs. They also show when you click the Baton icon in the toolbar.'),
  );
}

function render() {
  renderForm();
  renderList();
}

export function mountLinks(container) {
  root = container;
  formEl = h('div', {});
  listEl = h('div', { class: 'stack' });
  searchInput = h('input', {
    type: 'search',
    class: 'input',
    placeholder: 'Search links',
    'aria-label': 'Search links',
    oninput: (e) => {
      query = e.target.value;
      renderList();
    },
  });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const incoming = parseImport(await file.text());
      const before = list.length;
      list = mergeBookmarks(list, incoming);
      await persist();
      toast(`Imported ${list.length - before} new links`);
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
      searchInput,
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => fileInput.click() }, 'Import JSON'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => download('baton-links.json', exportJson(list), 'application/json') }, 'Export for team'),
      fileInput,
    ),
    h('section', { class: 'card' }, h('div', { class: 'section-head' }, h('h2', {}, 'Add a link')), formEl),
    listEl,
  );

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.bookmarks) {
      list = changes.bookmarks.newValue || [];
      if (!formEl.contains(document.activeElement)) render();
      else renderList();
    }
  });
  loadBookmarks().then((b) => {
    list = b;
    render();
  });
}
