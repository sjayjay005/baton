// Export captured requests as a Bruno collection (.bru files + bruno.json), zipped.
import { requestBody, isSecretHeader, tryParseJson } from './format.js';
import { zip } from './zip.js';

const SKIP = new Set(['content-length', 'host', 'connection', 'accept-encoding']);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'request';
const varName = (header) => header.toLowerCase().replace(/[^a-z0-9]+(.)/g, (m, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
// Bru dictionary values are single-line.
const oneLine = (v) => String(v ?? '').replace(/\r?\n/g, ' ');
const indent = (text) => text.split('\n').map((l) => `  ${l}`).join('\n');

export function toBru(entry, seq, { mask = true } = {}) {
  const method = entry.request.method.toLowerCase();
  const url = new URL(entry.request.url);
  const vars = new Set();
  const headers = [];
  for (const h of entry.request.headers || []) {
    if (h.name.startsWith(':') || SKIP.has(h.name.toLowerCase())) continue;
    let value = h.value;
    if (mask && isSecretHeader(h.name)) {
      const v = varName(h.name);
      vars.add(v);
      const scheme = /^(Bearer|Basic|Token)\s+/i.exec(value);
      value = scheme ? `${scheme[1]} {{${v}}}` : `{{${v}}}`;
    }
    headers.push([h.name, value]);
  }
  const body = requestBody(entry, { mask });
  let bodyMode = 'none';
  let bodyBlock = '';
  if (body && body.kind === 'raw') {
    const json = tryParseJson(body.text);
    if (json !== undefined) {
      bodyMode = 'json';
      bodyBlock = `body:json {\n${indent(JSON.stringify(json, null, 2))}\n}`;
    } else if (/x-www-form-urlencoded/i.test(body.mimeType)) {
      bodyMode = 'formUrlEncoded';
      const lines = [...new URLSearchParams(body.text)].map(([k, v]) => `  ${k}: ${oneLine(v)}`);
      bodyBlock = `body:form-urlencoded {\n${lines.join('\n')}\n}`;
    } else if (/xml/i.test(body.mimeType)) {
      bodyMode = 'xml';
      bodyBlock = `body:xml {\n${indent(body.text)}\n}`;
    } else {
      bodyMode = 'text';
      bodyBlock = `body:text {\n${indent(body.text)}\n}`;
    }
  } else if (body && body.kind === 'form') {
    const multipart = /multipart/i.test(body.mimeType);
    bodyMode = multipart ? 'multipartForm' : 'formUrlEncoded';
    const lines = body.params.map((p) => `  ${p.name}: ${p.fileName ? `@file(${p.fileName})` : oneLine(p.value)}`);
    bodyBlock = `${multipart ? 'body:multipart-form' : 'body:form-urlencoded'} {\n${lines.join('\n')}\n}`;
  }
  const name = `${entry.request.method} ${url.pathname}`;
  const parts = [`meta {\n  name: ${oneLine(name)}\n  type: http\n  seq: ${seq}\n}`, `${method} {\n  url: ${entry.request.url}\n  body: ${bodyMode}\n  auth: none\n}`];
  const query = [...url.searchParams];
  if (query.length) parts.push(`params:query {\n${query.map(([k, v]) => `  ${k}: ${oneLine(v)}`).join('\n')}\n}`);
  if (headers.length) parts.push(`headers {\n${headers.map(([k, v]) => `  ${k}: ${oneLine(v)}`).join('\n')}\n}`);
  if (bodyBlock) parts.push(bodyBlock);
  const status = entry.response && entry.response.status;
  parts.push(`docs {\n  Captured with Baton${status ? ` · original response ${status}` : ''}${entry.time ? ` in ${Math.round(entry.time)}ms` : ''}.\n}`);
  return { fileName: `${String(seq).padStart(2, '0')}-${slug(`${method}-${url.pathname}`)}.bru`, content: `${parts.join('\n\n')}\n`, vars };
}

export function brunoCollection(entries, { name = 'Baton export', mask = true } = {}) {
  const folder = slug(name);
  const files = [];
  const vars = new Set();
  entries.forEach((e, i) => {
    const bru = toBru(e, i + 1, { mask });
    bru.vars.forEach((v) => vars.add(v));
    files.push({ name: `${folder}/${bru.fileName}`, content: bru.content });
  });
  files.unshift({ name: `${folder}/bruno.json`, content: `${JSON.stringify({ version: '1', name, type: 'collection', ignore: ['node_modules', '.git'] }, null, 2)}\n` });
  if (vars.size) {
    const list = [...vars];
    files.push({ name: `${folder}/environments/Baton.bru`, content: `vars {\n${list.map((v) => `  ${v}: `).join('\n')}\n}\nvars:secret [\n${list.map((v) => `  ${v}`).join(',\n')}\n]\n` });
  }
  return { files, zipBytes: zip(files), folder };
}
