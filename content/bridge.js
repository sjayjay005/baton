// Isolated-world bridge: hands Baton's rules and storage locks to the page hook (page-hook.js).
(() => {
  const origin = location.origin;
  const keys = ['rules', 'rulesPaused', `locks:${origin}`];

  async function send() {
    const s = await chrome.storage.local.get(keys);
    const cfg = {
      rules: (s.rules || []).filter((r) => r.enabled && (r.type === 'mock' || r.type === 'delay')),
      paused: !!s.rulesPaused,
      locks: s[`locks:${origin}`] || { local: [], session: [] },
    };
    window.dispatchEvent(new CustomEvent('baton:config', { detail: JSON.stringify(cfg) }));
  }

  window.addEventListener('baton:hello', send);
  // Replay: hand the recorded network tape to the page hook.
  window.addEventListener('baton:need-tape', async () => {
    const { replayTape } = await chrome.storage.local.get('replayTape');
    window.dispatchEvent(new CustomEvent('baton:tape', { detail: JSON.stringify(replayTape || null) }));
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && keys.some((k) => k in changes)) send();
  });
  send();
  window.dispatchEvent(new CustomEvent('baton:bridge-ready'));
})();
