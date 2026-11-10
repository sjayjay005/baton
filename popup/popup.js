import { applyStoredTheme } from '../panel/lib/theme.js';
applyStoredTheme();
import { loadBookmarks, groupBookmarks } from '../panel/lib/bookmarks.js';

const shortcut = document.getElementById('shortcut');
shortcut.textContent = /Mac/i.test(navigator.platform) ? '⌘ + ⌥ + I' : 'F12 or Ctrl + Shift + I';

const linksEl = document.getElementById('links');
const q = document.getElementById('q');
let list = [];

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

function render() {
  const groups = groupBookmarks(list, q.value);
  linksEl.replaceChildren();
  if (!list.length) {
    linksEl.append(el('p', { class: 'muted' }, 'No links yet. Add your team’s links in DevTools → Baton → Links.'));
    document.querySelector('.help').open = true;
    return;
  }
  if (!groups.length) {
    linksEl.append(el('p', { class: 'muted' }, 'No links match.'));
    return;
  }
  for (const [g, items] of groups) {
    linksEl.append(el('h2', {}, g));
    for (const b of items) {
      linksEl.append(
        el(
          'a',
          {
            href: b.url,
            class: 'link',
            title: b.url,
            onclick: (e) => {
              e.preventDefault();
              chrome.tabs.create({ url: b.url, active: !(e.ctrlKey || e.metaKey) });
              if (!(e.ctrlKey || e.metaKey)) window.close();
            },
          },
          el('span', { class: 'name' }, b.name),
          el('span', { class: 'host' }, new URL(b.url).hostname),
        ),
      );
    }
  }
}

q.addEventListener('input', render);
loadBookmarks().then((b) => {
  list = b;
  render();
  q.focus();
});
