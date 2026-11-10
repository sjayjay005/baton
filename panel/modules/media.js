import { h, clear, toast, download } from '../lib/dom.js';
import { emit } from '../lib/settings.js';
import { addMedia, updateMedia, listMedia, deleteMedia, clearMedia, channel, stamp, KIND_ICON, isImage, fmtBytes, fmtDuration } from '../lib/media.js';
import { openAnnotator } from '../lib/annotate.js';
import { openGifPicker } from '../lib/gif.js';
import { openSyncedPlayer } from './timeline.js';

let galleryEl, items = [];
let urls = [];
const recListeners = new Set();

function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, (res) => resolve(res || { ok: false, error: chrome.runtime.lastError?.message || 'No response' })));
}

export async function refreshMedia() {
  items = await listMedia();
  renderGallery();
  emit('media-changed', items);
  return items;
}

export function includedMedia() {
  return items.filter((m) => m.include);
}

export async function takeScreenshot({ annotate = true } = {}) {
  const res = await sendMessage({ type: 'capture-tab', tabId: chrome.devtools.inspectedWindow.tabId });
  if (!res.ok) return toast(`Screenshot failed: ${res.error}`);
  let blob = await (await fetch(res.dataUrl)).blob();
  if (annotate) {
    const edited = await openAnnotator(blob);
    if (edited) blob = edited;
  }
  await addMedia({ kind: 'screenshot', name: `screenshot-${stamp()}.png`, mime: 'image/png', blob, size: blob.size });
  await refreshMedia();
  toast('📸 Screenshot added to the bug report');
}

export async function startRecording() {
  const res = await sendMessage({ type: 'open-recorder', tabId: chrome.devtools.inspectedWindow.tabId });
  if (!res.ok) toast(`Couldn't open the recorder: ${res.error}`);
}

export function stopRecording() {
  channel.postMessage({ type: 'stop-recording' });
}

export function onRecordingState(fn) {
  recListeners.add(fn);
}

export async function addGif() {
  const picked = await openGifPicker({ goToSettings: () => emit('goto', 'settings') });
  if (!picked) return;
  await addMedia({ kind: 'gif', name: picked.name.endsWith('.gif') ? picked.name : `${picked.name}.gif`, mime: picked.blob.type || 'image/gif', blob: picked.blob, size: picked.blob.size, sourceUrl: picked.sourceUrl });
  await refreshMedia();
  toast('🎞️ GIF added');
}

export async function addFiles(files) {
  for (const f of files) {
    const kind = f.type === 'image/gif' ? 'gif' : f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'recording' : 'file';
    await addMedia({ kind, name: f.name || `pasted-${stamp()}.png`, mime: f.type || 'application/octet-stream', blob: f, size: f.size });
  }
  await refreshMedia();
  toast(`📎 Added ${files.length} file${files.length === 1 ? '' : 's'}`);
}

function renderGallery() {
  if (!galleryEl) return;
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  const url = (blob) => {
    const u = URL.createObjectURL(blob);
    urls.push(u);
    return u;
  };
  clear(
    galleryEl,
    items.length
      ? items.map((m) =>
          h(
            'figure',
            { class: `media-item${m.include ? '' : ' excluded'}` },
            h(
              'div',
              { class: 'thumb' },
              isImage(m)
                ? h('img', { src: url(m.blob), alt: m.name })
                : m.kind === 'recording'
                  ? h('video', { src: url(m.blob), controls: true, preload: 'metadata', 'aria-label': m.name })
                  : h('div', { class: 'file-icon' }, '📎'),
            ),
            h(
              'figcaption',
              {},
              h('div', { class: 'media-name', title: m.name }, `${KIND_ICON[m.kind] || '📎'} ${m.name}`),
              h('div', { class: 'muted small' }, [fmtBytes(m.size || m.blob.size), m.duration ? fmtDuration(m.duration) : null].filter(Boolean).join(' · ')),
              h(
                'div',
                { class: 'media-actions' },
                (() => {
                  const box = h('input', { type: 'checkbox', checked: m.include, id: `inc-media-${m.id}` });
                  box.addEventListener('change', async () => {
                    await updateMedia(m.id, { include: box.checked });
                    refreshMedia();
                  });
                  return h('label', { class: 'check small', for: `inc-media-${m.id}` }, box, 'Include');
                })(),
                h('span', { class: 'grow' }),
                m.kind === 'screenshot' || m.kind === 'image'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'icon-btn',
                        title: 'Annotate',
                        'aria-label': `Annotate ${m.name}`,
                        onclick: async () => {
                          const edited = await openAnnotator(m.blob);
                          if (edited) {
                            await updateMedia(m.id, { blob: edited, size: edited.size, mime: 'image/png' });
                            refreshMedia();
                          }
                        },
                      },
                      '✎',
                    )
                  : null,
                m.kind === 'recording' && m.timeline
                  ? h('button', { type: 'button', class: 'icon-btn', title: 'Play with timeline', 'aria-label': `Play ${m.name} with timeline`, onclick: () => openSyncedPlayer(m) }, '▶')
                  : null,
                h('button', { type: 'button', class: 'icon-btn', title: 'Download', 'aria-label': `Download ${m.name}`, onclick: () => download(m.name, m.blob, m.mime) }, '⤓'),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'icon-btn',
                    title: 'Delete',
                    'aria-label': `Delete ${m.name}`,
                    onclick: async () => {
                      await deleteMedia(m.id);
                      refreshMedia();
                    },
                  },
                  '×',
                ),
              ),
            ),
          ),
        )
      : h('div', { class: 'muted small pad' }, 'No media yet. 📸 Screenshot, ⏺ Record, 🎞️ add a GIF, or paste an image (Ctrl/⌘+V) right here.'),
  );
}

// Builds the media section used inside the Bug report tab.
export function mediaSection() {
  galleryEl = h('div', { class: 'media-grid' });
  const fileInput = h('input', { type: 'file', multiple: true, accept: 'image/*,video/*', hidden: true });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) addFiles([...fileInput.files]);
    fileInput.value = '';
  });
  const section = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'row-form' },
      h('button', { type: 'button', class: 'btn', onclick: () => takeScreenshot() }, '📸 Screenshot'),
      h('button', { type: 'button', class: 'btn', onclick: startRecording }, '⏺ Record'),
      h('button', { type: 'button', class: 'btn', onclick: addGif }, '🎞️ GIF'),
      h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, '📎 Upload'),
      fileInput,
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => includedMedia().forEach((m) => download(m.name, m.blob, m.mime)) }, 'Download all'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn ghost',
          onclick: async () => {
            await clearMedia();
            refreshMedia();
          },
        },
        'Clear',
      ),
    ),
    galleryEl,
  );
  return section;
}

export function initMedia(pasteTarget) {
  channel.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type === 'changed') refreshMedia();
    if (d.type === 'recording') recListeners.forEach((fn) => fn(d));
  });
  // Paste images straight from the clipboard (e.g. an OS screenshot).
  pasteTarget.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  refreshMedia();
}
