import { settings, setSetting } from './settings.js';

// Tiny DOM helpers. h('div', {class: 'x', onclick}, child, ...)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

// Clipboard: execCommand works reliably inside DevTools panels, where the async
// Clipboard API is often blocked because the panel frame isn't "focused".
export async function copyText(text) {
  const ta = h('textarea', { style: 'position:fixed;top:-1000px;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  if (!ok && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    ok = true;
  }
  toast(ok ? 'Copied to clipboard' : 'Copy failed');
  return ok;
}

let toastTimer;
export function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = h('div', { id: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toggleSwitch(checked, onchange, label) {
  const input = h('input', { type: 'checkbox', class: 'switch', checked, 'aria-label': label || 'Toggle' });
  input.addEventListener('change', () => onchange(input.checked));
  return input;
}

export function timeStr(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// Collapsible section whose open/closed state is remembered across sessions.
// Returns { el, body, setCount, setExtra }.
export function accordion(id, title, defaultOpen = true) {
  const count = h('span', { class: 'acc-count' });
  const extra = h('span', { class: 'acc-extra' });
  const body = h('div', { class: 'acc-body' });
  const isOpen = id in settings.open ? settings.open[id] : defaultOpen;
  const el = h('details', { class: 'acc card', open: isOpen }, h('summary', {}, h('span', { class: 'acc-title' }, title), count, extra), body);
  el.addEventListener('toggle', () => {
    if (settings.open[id] !== el.open) setSetting('open', { ...settings.open, [id]: el.open });
  });
  return {
    el,
    body,
    setCount: (n) => (count.textContent = n === '' || n == null ? '' : String(n)),
    setExtra: (...nodes) => clear(extra, ...nodes),
  };
}
