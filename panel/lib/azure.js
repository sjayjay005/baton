// Azure DevOps (Boards) helpers: PAT discovery from .npmrc, REST calls, Markdown → HTML.
// Pure functions are exported for tests; network calls use fetch with Basic auth.

const API = 'api-version=7.1';

// Accepts "contoso", "https://dev.azure.com/contoso/Project", "contoso.visualstudio.com".
export function normalizeOrg(input) {
  const s = String(input || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  let m = /dev\.azure\.com\/([^/?#\s]+)/i.exec(s);
  if (m) return decodeURIComponent(m[1]);
  m = /^(?:https?:\/\/)?([^./\s]+)\.(?:pkgs\.)?visualstudio\.com/i.exec(s);
  if (m) return m[1];
  return s.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
}

function b64decode(s) {
  if (typeof atob === 'function') {
    const bin = atob(s);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }
  return Buffer.from(s, 'base64').toString('utf8');
}

function b64encode(s) {
  if (typeof btoa === 'function') {
    return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  }
  return Buffer.from(s, 'utf8').toString('base64');
}

// Finds Azure DevOps credentials in .npmrc contents.
// Azure Artifacts writes:  //pkgs.dev.azure.com/ORG/_packaging/FEED/npm/registry/:_password=BASE64(PAT)
// Returns [{ org, pat, registry }] (deduped by PAT), best match first.
export function parseNpmrc(text) {
  const found = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^\/\/([^\s=]+):(_password|_authToken)\s*=\s*"?([^"\s]+)"?\s*$/.exec(line);
    if (!m) continue;
    const [, registry, kind, value] = m;
    if (value.includes('${')) continue; // env-var placeholder, not a real token
    if (!/(dev\.azure\.com|visualstudio\.com)/i.test(registry)) continue;
    let pat = value;
    if (kind === '_password') {
      try {
        pat = b64decode(value).trim();
      } catch {
        continue;
      }
    }
    if (!pat) continue;
    const orgMatch = /pkgs\.dev\.azure\.com\/([^/]+)/i.exec(registry) || /^([^./]+)\.pkgs\.visualstudio\.com/i.exec(registry);
    found.push({ org: orgMatch ? decodeURIComponent(orgMatch[1]) : '', pat, registry });
  }
  const seen = new Set();
  return found.filter((f) => !seen.has(f.pat) && seen.add(f.pat));
}

export function authHeader(pat) {
  return `Basic ${b64encode(`:${pat}`)}`;
}

export class AzureError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function call(cfg, path, { method = 'GET', body, contentType } = {}) {
  if (!cfg.org || !cfg.pat) throw new AzureError('Add your organization and PAT in Settings first.');
  const url = `https://dev.azure.com/${encodeURIComponent(cfg.org)}/${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: authHeader(cfg.pat), Accept: 'application/json', ...(contentType ? { 'Content-Type': contentType } : {}) },
      body,
    });
  } catch (err) {
    throw new AzureError(`Couldn't reach dev.azure.com (${err.message}).`);
  }
  const type = res.headers.get('content-type') || '';
  // A bad PAT often comes back as 203 + an HTML sign-in page rather than 401.
  if (res.status === 401 || res.status === 403 || (res.ok && !type.includes('json'))) {
    throw new AzureError(
      'Azure DevOps rejected the PAT. Check the organization name, that the token hasn’t expired, and that it has the “Work Items (Read & write)” scope. Tokens made for npm feeds usually only have “Packaging”.',
      res.status,
    );
  }
  const json = type.includes('json') ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    throw new AzureError((json && (json.message || json.value?.Message)) || `Azure DevOps returned ${res.status}.`, res.status);
  }
  return json;
}

export async function listProjects(cfg) {
  const json = await call(cfg, `_apis/projects?$top=500&${API}`);
  return (json.value || []).map((p) => p.name).sort((a, b) => a.localeCompare(b));
}

export async function listWorkItemTypes(cfg, project) {
  const json = await call(cfg, `${encodeURIComponent(project)}/_apis/wit/workitemtypes?${API}`);
  return (json.value || []).filter((t) => !t.isDisabled).map((t) => t.name);
}

export async function uploadAttachment(cfg, project, fileName, content) {
  const json = await call(cfg, `${encodeURIComponent(project)}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}&${API}`, {
    method: 'POST',
    body: content,
    contentType: 'application/octet-stream',
  });
  return json.url;
}

export const SEVERITIES = ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'];

export function buildWorkItemPatch({ title, html, type, areaPath, iterationPath, tags, severity, attachmentUrls = [] }) {
  const field = type === 'Bug' ? 'Microsoft.VSTS.TCM.ReproSteps' : 'System.Description';
  const ops = [
    { op: 'add', path: '/fields/System.Title', value: title.slice(0, 255) },
    { op: 'add', path: `/fields/${field}`, value: html },
  ];
  if (areaPath) ops.push({ op: 'add', path: '/fields/System.AreaPath', value: areaPath });
  if (iterationPath) ops.push({ op: 'add', path: '/fields/System.IterationPath', value: iterationPath });
  if (tags) ops.push({ op: 'add', path: '/fields/System.Tags', value: tags });
  if (severity && type === 'Bug') ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Severity', value: severity });
  for (const a of attachmentUrls) {
    ops.push({ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: a.url, attributes: { comment: a.comment || 'Added by Baton' } } });
  }
  return ops;
}

// files: [{ name, content (Blob|string), kind }]. Images are shown inline in the work item.
export async function createWorkItem(cfg, { title, html, files = [], severity = '' }) {
  const project = cfg.project;
  if (!project) throw new AzureError('Pick a project in Settings first.');
  const type = cfg.type || 'Bug';
  const uploaded = [];
  for (const f of files) {
    const url = await uploadAttachment(cfg, project, f.name, f.content);
    uploaded.push({ ...f, url });
  }
  const fullHtml = html + mediaHtml(uploaded);
  const attachmentUrls = uploaded.map((u) => ({ url: u.url, comment: u.kind === 'bundle' ? 'Baton bug bundle' : 'Added by Baton' }));
  const send = (sev) =>
    call(cfg, `${encodeURIComponent(project)}/_apis/wit/workitems/$${encodeURIComponent(type)}?${API}`, {
      method: 'POST',
      body: JSON.stringify(buildWorkItemPatch({ title, html: fullHtml, type, areaPath: cfg.areaPath, iterationPath: cfg.iterationPath, tags: cfg.tags, severity: sev, attachmentUrls })),
      contentType: 'application/json-patch+json',
    });
  let json;
  try {
    json = await send(severity);
  } catch (err) {
    // Some process templates don't have Severity; retry without it rather than failing the bug.
    if (severity && /severity/i.test(err.message)) json = await send('');
    else throw err;
  }
  const url = (json._links && json._links.html && json._links.html.href) || `https://dev.azure.com/${encodeURIComponent(cfg.org)}/${encodeURIComponent(project)}/_workitems/edit/${json.id}`;
  return { id: json.id, url };
}

export function mediaHtml(uploaded) {
  const media = uploaded.filter((u) => u.kind !== 'bundle');
  if (!media.length) return '';
  const icon = { screenshot: '📸', recording: '🎬', gif: '🎞️', image: '🖼️' };
  const parts = media.map((m) => {
    const label = `${icon[m.kind] || '📎'} ${esc(m.name)}`;
    if (m.kind === 'screenshot' || m.kind === 'gif' || m.kind === 'image') {
      return `<div><div><b>${label}</b></div><img src="${esc(m.url)}" alt="${esc(m.name)}" style="max-width:100%;border:1px solid #ddd"></div>`;
    }
    return `<div><a href="${esc(m.url)}">${label}</a></div>`;
  });
  return `<h3>Screenshots &amp; recordings</h3>${parts.join('<br>')}`;
}

// ---- Markdown → HTML for the subset Baton's report produces ----------------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<i>$2</i>');
}

export function markdownToHtml(md) {
  const lines = String(md).split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^(`{3,})(\w*)\s*$/.exec(line);
    if (fenceMatch) {
      closeList();
      const ticks = fenceMatch[1];
      const body = [];
      i++;
      while (i < lines.length && lines[i] !== ticks) body.push(lines[i++]);
      out.push(`<pre style="background:#f4f4f4;padding:8px;white-space:pre-wrap"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const hMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hMatch) {
      closeList();
      const n = Math.min(hMatch[1].length + 1, 6);
      out.push(`<h${n}>${inline(hMatch[2])}</h${n}>`);
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<div>${inline(line)}</div>`);
    else out.push('<br>');
  }
  closeList();
  return out.join('');
}
