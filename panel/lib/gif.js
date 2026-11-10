// GIF picker: search GIPHY (needs a free API key), paste a GIF link, or upload a file.
import { h, clear, toast } from './dom.js';
import { getStored } from './settings.js';
import { normalizeUrl } from './bookmarks.js';

export function mapGiphy(json) {
  return (json.data || [])
    .map((g) => ({
      id: g.id,
      title: g.title || 'GIF',
      preview: g.images?.fixed_width_small?.url || g.images?.fixed_width?.url || g.images?.preview_gif?.url,
      url: g.images?.downsized?.url || g.images?.original?.url,
      page: g.url,
    }))
    .filter((g) => g.preview && g.url);
}

async function giphy(key, q) {
  const endpoint = q.trim() ? 'search' : 'trending';
  const params = new URLSearchParams({ api_key: key, limit: '24', rating: 'pg-13', bundle: 'messaging_non_clips' });
  if (q.trim()) params.set('q', q.trim());
  const res = await fetch(`https://api.giphy.com/v1/gifs/${endpoint}?${params}`);
  if (res.status === 401 || res.status === 403) throw new Error('GIPHY rejected the API key. Check it in Settings.');
  if (res.status === 429) throw new Error('GIPHY rate limit reached (beta keys are limited). Try again later.');
  if (!res.ok) throw new Error(`GIPHY returned ${res.status}`);
  return mapGiphy(await res.json());
}

async function fetchGif(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download the GIF (${res.status})`);
  const blob = await res.blob();
  if (!/^image\//.test(blob.type)) throw new Error('That link is not an image');
  return blob;
}

// Resolves with { blob, name, sourceUrl } or null.
export function openGifPicker({ goToSettings } = {}) {
  return new Promise(async (resolve) => {
    const key = await getStored('giphyKey', '');
    let timer;
    const results = h('div', { class: 'gif-grid', 'aria-live': 'polite' });
    const status = h('div', { class: 'muted small' });

    const done = (val) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => e.key === 'Escape' && done(null);

    const choose = async (g) => {
      status.textContent = 'Adding GIF…';
      try {
        const blob = await fetchGif(g.url);
        done({ blob, name: `${(g.title || 'gif').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'gif'}.gif`, sourceUrl: g.url });
      } catch (err) {
        status.textContent = err.message;
      }
    };

    const runSearch = async (q) => {
      if (!key) return;
      status.textContent = 'Searching…';
      try {
        const list = await giphy(key, q);
        status.textContent = list.length ? '' : 'No GIFs found.';
        clear(
          results,
          list.map((g) =>
            h('button', { type: 'button', class: 'gif', title: g.title, 'aria-label': `Use GIF: ${g.title}`, onclick: () => choose(g) }, h('img', { src: g.preview, alt: g.title, loading: 'lazy' })),
          ),
        );
      } catch (err) {
        status.textContent = err.message;
      }
    };

    const search = h('input', {
      type: 'search',
      class: 'input grow',
      placeholder: key ? 'Search GIFs: facepalm, it works, shipit…' : 'Add a GIPHY key in Settings to search',
      'aria-label': 'Search GIFs',
      disabled: !key,
      oninput: (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => runSearch(e.target.value), 350);
      },
    });
    const urlInput = h('input', { class: 'input grow', placeholder: 'https://…/something.gif', 'aria-label': 'GIF link' });
    const fileInput = h('input', { type: 'file', accept: 'image/gif,image/*', hidden: true });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (f) done({ blob: f, name: f.name, sourceUrl: null });
    });

    const overlay = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add a GIF', onmousedown: (e) => e.target === overlay && done(null) },
      h(
        'div',
        { class: 'modal-box gif-box' },
        h('div', { class: 'section-head' }, h('h2', {}, 'Add a GIF 🎞️'), h('span', { class: 'grow' }), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: () => done(null) }, '×')),
        h('div', { class: 'row-form' }, search),
        key
          ? null
          : h(
              'p',
              { class: 'notice small' },
              'GIF search uses GIPHY and needs a free API key from developers.giphy.com (choose “API”). ',
              goToSettings ? h('button', { type: 'button', class: 'linkish', onclick: () => (done(null), goToSettings()) }, 'Add it in Settings') : null,
            ),
        status,
        results,
        key ? h('div', { class: 'giphy-attr' }, 'Powered by GIPHY') : null,
        h(
          'form',
          {
            class: 'row-form',
            onsubmit: async (e) => {
              e.preventDefault();
              const u = normalizeUrl(urlInput.value);
              if (!u) return toast('Enter a valid http(s) link');
              await choose({ url: u, title: decodeURIComponent(new URL(u).pathname.split('/').pop() || 'gif').replace(/\.gif$/i, '') });
            },
          },
          urlInput,
          h('button', { type: 'submit', class: 'btn' }, 'Add link'),
          h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, 'Upload GIF'),
          fileInput,
        ),
      ),
    );
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    if (key) {
      search.focus();
      runSearch('');
    } else urlInput.focus();
  });
}
