// Request rules: shared by the Mocks tab (editing) and the service worker (applying).
// mock/delay run in the page hook (fetch/XHR); redirect/host/headers/block run as
// declarativeNetRequest rules; css/js are injected into matching pages.

export const RULE_TYPES = {
  mock: { label: 'Mock response', icon: '🎭', scope: 'fetch/XHR' },
  delay: { label: 'Delay', icon: '🐢', scope: 'fetch/XHR' },
  redirect: { label: 'Redirect', icon: '↪️', scope: 'all requests' },
  host: { label: 'Swap host', icon: '🔀', scope: 'all requests' },
  headers: { label: 'Modify headers', icon: '🏷️', scope: 'all requests' },
  block: { label: 'Block', icon: '⛔', scope: 'all requests' },
  css: { label: 'Inject CSS', icon: '🎨', scope: 'pages' },
  js: { label: 'Inject JS', icon: '🧩', scope: 'pages' },
};

export const MATCH_KINDS = { contains: 'URL contains', equals: 'URL equals', wildcard: 'Wildcard (*)', regex: 'Regex' };
export const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

export function newRule(type = 'mock', patch = {}) {
  const base = {
    id: (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
    name: '',
    type,
    enabled: true,
    match: { kind: 'contains', value: '', method: 'ANY', graphql: '' },
  };
  const byType = {
    mock: { status: 200, statusText: '', contentType: 'application/json', body: '{\n  "ok": true\n}', delay: 0 },
    delay: { delay: 2000 },
    redirect: { target: '' },
    host: { target: '' },
    headers: { headers: [{ target: 'request', op: 'set', name: '', value: '' }] },
    block: {},
    css: { code: '' },
    js: { code: '', runAt: 'document_idle' },
  };
  return { ...base, ...byType[type], ...patch, match: { ...base.match, ...(patch.match || {}) } };
}

export function describeRule(r) {
  const m = r.match || {};
  const where = `${m.method && m.method !== 'ANY' ? `${m.method} ` : ''}${m.value || '(no URL set)'}${m.graphql ? ` · op ${m.graphql}` : ''}`;
  const what = {
    mock: `→ ${r.status}${r.delay ? ` after ${r.delay}ms` : ''}`,
    delay: `+${r.delay}ms`,
    redirect: `→ ${r.target}`,
    host: `→ ${r.target}`,
    headers: (r.headers || []).map((h) => `${h.op} ${h.target} ${h.name}`).join(', '),
    block: 'blocked',
    css: 'style',
    js: 'script',
  }[r.type];
  return `${where} ${what || ''}`.trim();
}

export function validateRule(r) {
  const errs = [];
  if (!r.match || !r.match.value) errs.push('Set the URL to match.');
  if (r.match && r.match.kind === 'regex') {
    try {
      new RegExp(r.match.value);
    } catch (e) {
      errs.push(`Regex: ${e.message}`);
    }
  }
  if (r.type === 'mock') {
    const s = Number(r.status);
    if (!(s >= 200 && s <= 599)) errs.push('Status must be between 200 and 599.');
    if (/json/.test(r.contentType || '') && r.body && ![101, 204, 205, 304].includes(s)) {
      try {
        JSON.parse(r.body);
      } catch {
        errs.push('Body isn’t valid JSON (or change the content type).');
      }
    }
  }
  if ((r.type === 'redirect' || r.type === 'host') && !r.target) errs.push('Set where to send requests.');
  if (r.type === 'redirect' && r.target && !/^(https?:)?\/\//i.test(r.target)) errs.push('Redirect target must be a full http(s) URL.');
  if (r.type === 'headers' && !(r.headers || []).some((h) => h.name)) errs.push('Add at least one header.');
  if ((r.type === 'css' || r.type === 'js') && !r.code) errs.push('Add the code to inject.');
  return errs;
}

// Same matcher the page hook uses (kept in sync by tests).
export function urlMatches(m, url) {
  if (!m || !m.value) return false;
  try {
    if (m.kind === 'equals') return url === m.value;
    if (m.kind === 'regex') return new RegExp(m.value).test(url);
    if (m.kind === 'wildcard') {
      const re = new RegExp(`^${m.value.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
      return re.test(url);
    }
    return url.includes(m.value);
  } catch {
    return false;
  }
}

export const ALL_RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];

export function parseHostTarget(target) {
  const t = String(target || '').trim();
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
    const transform = { host: u.hostname };
    if (/^[a-z]+:\/\//i.test(t)) transform.scheme = u.protocol.replace(':', '');
    if (u.port) transform.port = u.port;
    return transform;
  } catch {
    return null;
  }
}

// Converts enabled network-level rules into declarativeNetRequest dynamic rules.
// Returns { dnr: [...], idMap: { dnrId: ruleId }, errors: [{ ruleId, message }] }.
export function toDnrRules(rules) {
  const net = rules.filter((r) => r.enabled && ['redirect', 'host', 'headers', 'block'].includes(r.type) && r.match && r.match.value);
  const dnr = [];
  const idMap = {};
  const errors = [];
  net.forEach((r, i) => {
    const id = i + 1;
    const m = r.match;
    const condition = { resourceTypes: ALL_RESOURCE_TYPES };
    if (m.kind === 'regex') condition.regexFilter = m.value;
    else if (m.kind === 'equals') condition.urlFilter = `|${m.value}|`;
    else condition.urlFilter = m.value;
    if (m.method && m.method !== 'ANY') condition.requestMethods = [m.method.toLowerCase()];
    let action;
    if (r.type === 'block') action = { type: 'block' };
    else if (r.type === 'redirect') {
      action = m.kind === 'regex' && /\\\d/.test(r.target) ? { type: 'redirect', redirect: { regexSubstitution: r.target } } : { type: 'redirect', redirect: { url: r.target } };
    } else if (r.type === 'host') {
      const transform = parseHostTarget(r.target);
      if (!transform) return errors.push({ ruleId: r.id, message: 'Invalid host' });
      action = { type: 'redirect', redirect: { transform } };
    } else if (r.type === 'headers') {
      const toOp = (h) => (h.op === 'remove' ? { header: h.name, operation: 'remove' } : { header: h.name, operation: 'set', value: h.value || '' });
      const req = (r.headers || []).filter((h) => h.name && h.target === 'request').map(toOp);
      const res = (r.headers || []).filter((h) => h.name && h.target === 'response').map(toOp);
      if (!req.length && !res.length) return errors.push({ ruleId: r.id, message: 'No headers' });
      action = { type: 'modifyHeaders' };
      if (req.length) action.requestHeaders = req;
      if (res.length) action.responseHeaders = res;
    }
    idMap[id] = r.id;
    dnr.push({ id, priority: net.length - i, action, condition });
  });
  return { dnr, idMap, errors };
}

// Wraps user JS so it only runs on matching pages.
export function wrapUserJs(rule) {
  const m = JSON.stringify(rule.match || {});
  return `(() => {
  const m = ${m};
  const url = location.href;
  const ok = (() => { try {
    if (m.kind === 'equals') return url === m.value;
    if (m.kind === 'regex') return new RegExp(m.value).test(url);
    if (m.kind === 'wildcard') return new RegExp('^' + m.value.split('*').map(s => s.replace(/[.+?^\${}()|[\\]\\\\]/g, '\\\\$&')).join('.*') + '$', 'i').test(url);
    return url.includes(m.value);
  } catch { return false; } })();
  if (!ok) return;
${rule.code}
})();`;
}

export function exportRules(rules) {
  return JSON.stringify({ baton: 'rules', version: 1, rules }, null, 2);
}

export function importRules(text) {
  const json = JSON.parse(text);
  const list = Array.isArray(json) ? json : json.rules;
  if (!Array.isArray(list)) throw new Error('Expected a Baton rules file');
  return list.filter((r) => r && RULE_TYPES[r.type]).map((r) => newRule(r.type, { ...r, id: newRule().id }));
}
