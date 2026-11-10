// Dark / light / auto theme shared by every Baton page.
export const THEMES = ['auto', 'dark', 'light'];
export const THEME_ICON = { auto: '🖥️', dark: '🌙', light: '☀️' };

export function effectiveTheme(pref) {
  if (pref === 'dark' || pref === 'light') return pref;
  const devtools = globalThis.chrome && chrome.devtools && chrome.devtools.panels && chrome.devtools.panels.themeName;
  if (devtools) return devtools === 'dark' ? 'dark' : 'light';
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(pref) {
  document.documentElement.dataset.theme = effectiveTheme(pref);
}

// For pages without the settings module (popup, recorder).
export async function applyStoredTheme() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    applyTheme((settings && settings.theme) || 'auto');
  } catch {
    applyTheme('auto');
  }
}
