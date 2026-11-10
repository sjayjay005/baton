// Small JWT viewer used across Network, Storage and Tools.
import { h, clear, copyText } from './dom.js';
import { decodeJwt, humanDuration } from './jwt.js';

const CLAIM_LABEL = { iss: 'Issuer', sub: 'Subject', aud: 'Audience', exp: 'Expires', nbf: 'Not before', iat: 'Issued', jti: 'Token ID', scope: 'Scope', scp: 'Scope', roles: 'Roles', email: 'Email', name: 'Name' };

export function jwtSummary(token, now = Date.now()) {
  try {
    const d = decodeJwt(token, now);
    if (d.expiresAt === null) return { ok: true, text: 'JWT · no expiry', cls: 'jwt-ok' };
    return d.expired ? { ok: true, text: `JWT · expired ${humanDuration(d.expiresInMs)} ago`, cls: 'jwt-bad' } : { ok: true, text: `JWT · expires in ${humanDuration(d.expiresInMs)}`, cls: d.expiresInMs < 5 * 60000 ? 'jwt-warn' : 'jwt-ok' };
  } catch {
    return { ok: false, text: 'Not a valid JWT', cls: 'jwt-bad' };
  }
}

export function jwtDetails(token) {
  const box = h('div', { class: 'jwt-view stack' });
  try {
    const d = decodeJwt(token);
    const s = jwtSummary(token);
    const when = (ms) => (ms ? `${new Date(ms).toLocaleString()}` : '—');
    const claims = Object.entries(d.payload).map(([k, v]) => {
      let shown = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (['exp', 'iat', 'nbf', 'auth_time'].includes(k) && typeof v === 'number') shown = `${v} · ${new Date(v * 1000).toLocaleString()}`;
      return h('tr', {}, h('th', {}, CLAIM_LABEL[k] ? `${k} (${CLAIM_LABEL[k]})` : k), h('td', {}, shown));
    });
    clear(
      box,
      h('div', { class: `jwt-badge ${s.cls}` }, s.text),
      h('div', { class: 'muted small' }, `alg ${d.header.alg || '?'} · issued ${when(d.issuedAt)} · expires ${when(d.expiresAt)} · signature not verified`),
      h('table', { class: 'kv' }, h('tbody', {}, claims)),
      h('details', {}, h('summary', {}, 'Header'), h('pre', { class: 'code small' }, JSON.stringify(d.header, null, 2))),
      h('details', {}, h('summary', {}, 'Payload JSON'), h('pre', { class: 'code small' }, JSON.stringify(d.payload, null, 2))),
      h('div', { class: 'row-form' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => copyText(JSON.stringify(d.payload, null, 2)) }, 'Copy payload'), h('button', { type: 'button', class: 'btn ghost', onclick: () => copyText(token) }, 'Copy token')),
    );
  } catch (e) {
    clear(box, h('div', { class: 'error' }, `Couldn’t decode: ${e.message}`));
  }
  return box;
}

export function openJwtModal(token, title = 'JWT') {
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const overlay = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onmousedown: (e) => e.target === overlay && close() },
    h('div', { class: 'modal-box jwt-box' }, h('div', { class: 'section-head' }, h('h2', {}, `🔑 ${title}`), h('span', { class: 'grow' }), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '×')), jwtDetails(token)),
  );
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
}

export function jwtChip(value, title) {
  const s = jwtSummary(value);
  return h('button', { type: 'button', class: `jwt-chip ${s.cls}`, title: 'Decode JWT', onclick: (e) => (e.stopPropagation(), openJwtModal(value, title)) }, `🔑 ${s.text.replace('JWT · ', '')}`);
}
