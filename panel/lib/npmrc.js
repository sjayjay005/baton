// .npmrc helpers: find credentials, rotate Azure DevOps PATs, generate Azure Artifacts blocks.
import { utf8ToB64, b64ToUtf8 } from './b64.js';

const AUTH_LINE = /^(\s*)(\/\/[^\s=]+?):(_password|_authToken|_auth|username|email)(\s*=\s*)("?)(.*?)\5\s*$/;
const isAzure = (prefix) => /dev\.azure\.com|visualstudio\.com/i.test(prefix);

export function credentials(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = AUTH_LINE.exec(line);
    if (!m) continue;
    const [, , prefix, key, , , value] = m;
    if (!map.has(prefix)) map.set(prefix, { prefix, azure: isAzure(prefix) });
    const c = map.get(prefix);
    c[key] = value;
  }
  return [...map.values()].map((c) => {
    let token = null;
    let kind = null;
    if (c._password && !c._password.includes('${')) {
      try {
        token = b64ToUtf8(c._password).trim();
        kind = '_password (base64)';
      } catch {
        token = null;
      }
    } else if (c._authToken && !c._authToken.includes('${')) {
      token = c._authToken;
      kind = '_authToken';
    } else if (c._password || c._authToken) kind = 'environment variable';
    const org = (/pkgs\.dev\.azure\.com\/([^/]+)/i.exec(c.prefix) || /^\/\/([^./]+)\.pkgs\.visualstudio\.com/i.exec(c.prefix) || [])[1] || '';
    const feed = (/_packaging\/([^/]+)/i.exec(c.prefix) || [])[1] || '';
    return { ...c, token, kind, org: decodeURIComponent(org), feed };
  });
}

// Replaces tokens on matching auth lines. `which` = 'azure' | a specific prefix.
export function setToken(text, pat, which = 'azure') {
  let changed = 0;
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const out = String(text)
    .split(/\r?\n/)
    .map((line) => {
      const m = AUTH_LINE.exec(line);
      if (!m) return line;
      const [, lead, prefix, key, eq, quote] = m;
      const target = which === 'azure' ? isAzure(prefix) : prefix === which;
      if (!target) return line;
      if (key === '_password') {
        changed++;
        return `${lead}${prefix}:_password${eq}${quote}${utf8ToB64(pat)}${quote}`;
      }
      if (key === '_authToken') {
        changed++;
        return `${lead}${prefix}:_authToken${eq}${quote}${pat}${quote}`;
      }
      return line;
    })
    .join(eol);
  return { text: out, changed };
}

export function maskNpmrc(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const m = AUTH_LINE.exec(line);
      if (!m || !['_password', '_authToken', '_auth'].includes(m[3])) return line;
      return `${m[1]}${m[2]}:${m[3]}${m[4]}••••••••`;
    })
    .join('\n');
}

// The block Azure Artifacts' "Connect to feed" instructions ask for.
export function azureBlock({ org, project = '', feed, pat, includeRegistry = false }) {
  const base = `//pkgs.dev.azure.com/${org}/${project ? `${project}/` : ''}_packaging/${feed}/npm`;
  const b64 = utf8ToB64(pat);
  const email = "npm requires email to be set but doesn't use the value";
  const lines = [];
  if (includeRegistry) lines.push(`registry=https:${base}/registry/`, 'always-auth=true', '');
  lines.push(
    '; begin auth token',
    `${base}/registry/:username=${org}`,
    `${base}/registry/:_password=${b64}`,
    `${base}/registry/:email=${email}`,
    `${base}/:username=${org}`,
    `${base}/:_password=${b64}`,
    `${base}/:email=${email}`,
    '; end auth token',
  );
  return lines.join('\n');
}
