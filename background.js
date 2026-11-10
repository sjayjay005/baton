// Baton service worker: tab screenshots, the recorder window, request rules
// (declarativeNetRequest + injected CSS/JS), cookies and keyboard-shortcut cyclers.
import { toDnrRules, urlMatches, wrapUserJs } from './panel/lib/rules.js';

// ---- Messages from the DevTools panel / pages ---------------------------------------
const handlers = {
  'capture-tab': ({ tabId }) => captureTab(tabId).then((dataUrl) => ({ dataUrl })),
  'open-recorder': ({ tabId }) => openRecorder(tabId),
  'open-tools': ({ hash }) => chrome.tabs.create({ url: chrome.runtime.getURL(`tools/tools.html${hash || ''}`) }),
  'rules-status': () => chrome.storage.local.get('rulesStatus').then((s) => s.rulesStatus || {}),
  'sync-rules': () => syncRules(),
  'dnr-matches': async ({ tabId }) => {
    const { dnrIdMap = {} } = await chrome.storage.session.get('dnrIdMap');
    const counts = {};
    try {
      const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId });
      for (const m of rulesMatchedInfo) {
        const id = dnrIdMap[m.rule.ruleId];
        if (id) counts[id] = (counts[id] || 0) + 1;
      }
    } catch {
      /* feedback not available */
    }
    return { counts };
  },
  'cookies-get': ({ url }) => chrome.cookies.getAll({ url }).then((cookies) => ({ cookies })),
  'cookie-set': ({ details }) => chrome.cookies.set(details).then((cookie) => {
    if (!cookie) throw new Error(chrome.runtime.lastError?.message || 'Chrome rejected the cookie (check domain, Secure and SameSite).');
    return { cookie };
  }),
  'cookie-remove': ({ url, name, storeId }) => chrome.cookies.remove({ url, name, storeId }).then(() => ({})),
  // Puts back the cookies a recorded session started with (skips redacted values).
  'cookies-restore': async ({ cookies }) => {
    let set = 0;
    for (const c of cookies || []) {
      if (!c || c.value === '••••••••') continue;
      const details = { url: `http${c.secure ? 's' : ''}://${String(c.domain).replace(/^\./, '')}${c.path || '/'}`, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, storeId: c.storeId };
      if (!c.hostOnly) details.domain = c.domain;
      if (!c.session && c.expirationDate) details.expirationDate = c.expirationDate;
      try {
        if (await chrome.cookies.set(details)) set++;
      } catch {
        /* skip cookies Chrome refuses */
      }
    }
    return { set };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = msg && handlers[msg.type];
  if (!fn) return false;
  Promise.resolve()
    .then(() => fn(msg))
    .then(
      (res) => sendResponse({ ok: true, ...(res || {}) }),
      (err) => sendResponse({ ok: false, error: err.message || String(err) }),
    );
  return true;
});

async function captureTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error('Switch back to the tab you are inspecting, then try again.');
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
}

let recorderWindowId = null;
async function openRecorder(tabId) {
  if (recorderWindowId !== null) {
    try {
      await chrome.windows.update(recorderWindowId, { focused: true, state: 'normal' });
      return;
    } catch {
      recorderWindowId = null;
    }
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`recorder/recorder.html?title=${encodeURIComponent(tab ? tab.title : '')}`),
    type: 'popup',
    width: 420,
    height: 420,
    focused: true,
  });
  recorderWindowId = win.id;
}
chrome.windows.onRemoved.addListener((id) => {
  if (id === recorderWindowId) recorderWindowId = null;
});

// ---- Request rules ------------------------------------------------------------------
function userScriptsAvailable() {
  try {
    chrome.userScripts.getScripts();
    return true;
  } catch {
    return false;
  }
}

let cssRules = [];

async function syncRules() {
  const { rules = [], rulesPaused = false } = await chrome.storage.local.get(['rules', 'rulesPaused']);
  const active = rulesPaused ? [] : rules.filter((r) => r.enabled);
  const errors = [];

  // Network-level rules
  const { dnr, idMap, errors: convErrors } = toDnrRules(active);
  errors.push(...convErrors);
  const valid = [];
  for (const rule of dnr) {
    if (rule.condition.regexFilter) {
      const res = await chrome.declarativeNetRequest.isRegexSupported({ regex: rule.condition.regexFilter });
      if (!res.isSupported) {
        errors.push({ ruleId: idMap[rule.id], message: `Chrome can’t use this regex (${res.reason}). Use wildcard or contains.` });
        continue;
      }
    }
    valid.push(rule);
  }
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: valid });
  } catch (err) {
    // Find the offending rule by adding them one at a time.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id) });
    for (const r of valid) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [r] });
      } catch (e) {
        errors.push({ ruleId: idMap[r.id], message: e.message });
      }
    }
  }
  await chrome.storage.session.set({ dnrIdMap: idMap });

  // Injected CSS (applied on navigation)
  cssRules = active.filter((r) => r.type === 'css' && r.code);

  // Injected JS (needs the user-scripts toggle)
  const jsRules = active.filter((r) => r.type === 'js' && r.code);
  const us = userScriptsAvailable();
  if (us) {
    try {
      const mine = (await chrome.userScripts.getScripts()).filter((s) => s.id.startsWith('baton-')).map((s) => s.id);
      if (mine.length) await chrome.userScripts.unregister({ ids: mine });
      if (jsRules.length) {
        await chrome.userScripts.register(
          jsRules.map((r) => ({ id: `baton-${r.id}`, matches: ['http://*/*', 'https://*/*'], js: [{ code: wrapUserJs(r) }], world: 'MAIN', runAt: r.runAt || 'document_idle' })),
        );
      }
    } catch (e) {
      errors.push({ ruleId: jsRules[0]?.id, message: `Injecting JS failed: ${e.message}` });
    }
  } else if (jsRules.length) {
    jsRules.forEach((r) => errors.push({ ruleId: r.id, message: 'Turn on “Allow user scripts” for Baton to inject JS.' }));
  }

  const status = { errors, userScripts: us, updatedAt: Date.now(), active: active.length };
  await chrome.storage.local.set({ rulesStatus: status });
  return status;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ('rules' in changes || 'rulesPaused' in changes)) syncRules();
});
chrome.runtime.onInstalled.addListener(() => syncRules());
chrome.runtime.onStartup.addListener(() => syncRules());

const cssDone = new Map(); // tabId -> url already styled
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.status || !tab.url || !/^https?:/.test(tab.url)) return;
  if (info.status === 'loading') cssDone.delete(tabId);
  if (!cssRules.length) {
    const { rules = [], rulesPaused } = await chrome.storage.local.get(['rules', 'rulesPaused']);
    if (!rulesPaused) cssRules = rules.filter((r) => r.enabled && r.type === 'css' && r.code);
  }
  if (cssDone.get(tabId) === tab.url) return;
  const css = cssRules.filter((r) => urlMatches(r.match, tab.url)).map((r) => r.code).join('\n');
  if (!css) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, css });
    cssDone.set(tabId, tab.url);
  } catch {
    /* page not ready yet; 'complete' will retry */
  }
});
chrome.tabs.onRemoved.addListener((id) => cssDone.delete(id));

// ---- Keyboard-shortcut cyclers ------------------------------------------------------
chrome.commands.onCommand.addListener(async (command, tab) => {
  const slot = Number((/^cycle-(\d)$/.exec(command) || [])[1]);
  if (!slot) return;
  tab ||= (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab || !/^https?:/.test(tab.url || '')) return;
  const origin = new URL(tab.url).origin;
  const key = `cyclers:${origin}`;
  const cyclers = (await chrome.storage.local.get(key))[key] || [];
  const c = cyclers.find((x) => Number(x.slot) === slot);
  if (!c || !c.values?.length) return flash(tab.id, '?', '#a4a9c6');
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [c.area, c.key, c.values],
    func: (area, key, values) => {
      const s = area === 'session' ? sessionStorage : localStorage;
      const cur = s.getItem(key);
      const next = values[(values.indexOf(cur) + 1) % values.length];
      window.__batonBypass = true;
      try {
        s.setItem(key, next);
      } finally {
        window.__batonBypass = false;
      }
      return next;
    },
  });
  flash(tab.id, String(result).slice(0, 4), '#8b7cff');
  if (c.reload) chrome.tabs.reload(tab.id);
});

function flash(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ color, tabId });
  chrome.action.setBadgeText({ text, tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }), 2500);
}
