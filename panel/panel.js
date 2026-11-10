import { h, clear } from './lib/dom.js';
import { loadSettings, settings, setSetting, onSettingChange, on } from './lib/settings.js';
import { mountNetwork } from './modules/network.js';
import { mountStorage, showStorage } from './modules/storage.js';
import { mountConsole } from './modules/console.js';
import { mountReport, showReport } from './modules/report.js';
import { mountLinks } from './modules/links.js';
import { mountSettings } from './modules/settings.js';
import { takeScreenshot, startRecording, stopRecording, onRecordingState } from './modules/media.js';
import { fmtDuration } from './lib/media.js';
import { mountMocks } from './modules/mocks.js';
import { mountTimeline, showTimeline, attachTimelineToRecording } from './modules/timeline.js';
import { mountTools } from './modules/tools.js';
import { mountReplay, showReplay } from './modules/replay.js';
import { applyTheme, THEMES, THEME_ICON } from './lib/theme.js';

const TABS = {
  network: { label: 'Network', onShow: null },
  mocks: { label: 'Mocks', onShow: null },
  storage: { label: 'Storage', onShow: showStorage },
  console: { label: 'Console', onShow: null },
  timeline: { label: 'Timeline', onShow: showTimeline },
  replay: { label: 'Replay', onShow: showReplay },
  report: { label: 'Bug report', onShow: showReport },
  tools: { label: 'Tools', onShow: null },
  links: { label: 'Links', onShow: null },
  settings: { label: 'Settings', onShow: null },
};
// QA puts reporting first; Dev puts inspection first.
const ORDER = {
  dev: ['network', 'mocks', 'storage', 'console', 'timeline', 'replay', 'report', 'tools', 'links', 'settings'],
  qa: ['report', 'replay', 'timeline', 'network', 'console', 'storage', 'mocks', 'tools', 'links', 'settings'],
};

let active = 'network';

function renderTabs() {
  const tabsEl = document.getElementById('tabs');
  clear(
    tabsEl,
    ORDER[settings.mode].map((id) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          id: `tab-${id}`,
          'aria-selected': String(active === id),
          'aria-controls': `view-${id}`,
          class: active === id ? 'active' : '',
          onclick: () => show(id),
        },
        TABS[id].label,
      ),
    ),
  );
}

function show(id) {
  active = id;
  for (const key of Object.keys(TABS)) document.getElementById(`view-${key}`).hidden = key !== id;
  renderTabs();
  if (TABS[id].onShow) TABS[id].onShow();
}

function applyMode() {
  document.body.dataset.mode = settings.mode;
  for (const m of ['dev', 'qa']) {
    const b = document.getElementById(`mode-${m}`);
    b.setAttribute('aria-checked', String(settings.mode === m));
    b.classList.toggle('active', settings.mode === m);
  }
}

async function init() {
  await loadSettings();
  applyMode();
  applyTheme(settings.theme);
  const themeBtn = document.getElementById('theme-btn');
  const renderThemeBtn = () => {
    themeBtn.textContent = THEME_ICON[settings.theme] || '🖥️';
    themeBtn.title = `Theme: ${settings.theme} (click to change)`;
    themeBtn.setAttribute('aria-label', themeBtn.title);
  };
  renderThemeBtn();
  themeBtn.addEventListener('click', () => setSetting('theme', THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length]));
  if (chrome.devtools.panels.setThemeChangeHandler) chrome.devtools.panels.setThemeChangeHandler(() => applyTheme(settings.theme));

  const mask = document.getElementById('mask-toggle');
  mask.checked = settings.mask;
  mask.addEventListener('change', () => setSetting('mask', mask.checked));

  for (const m of ['dev', 'qa']) {
    document.getElementById(`mode-${m}`).addEventListener('click', () => setSetting('mode', m));
  }
  onSettingChange((key, value) => {
    if (key === 'mode') {
      applyMode();
      show(ORDER[value][0]);
    }
    if (key === 'theme') {
      applyTheme(value);
      renderThemeBtn();
    }
  });

  mountTimeline(document.getElementById('view-timeline'));
  mountNetwork(document.getElementById('view-network'));
  mountMocks(document.getElementById('view-mocks'));
  mountTools(document.getElementById('view-tools'));
  mountReplay(document.getElementById('view-replay'));
  mountStorage(document.getElementById('view-storage'));
  mountConsole(document.getElementById('view-console'));
  mountReport(document.getElementById('view-report'));
  mountLinks(document.getElementById('view-links'));
  mountSettings(document.getElementById('view-settings'));
  on('goto', (id) => show(id));

  document.getElementById('quick-shot').addEventListener('click', () => takeScreenshot());
  document.getElementById('quick-rec').addEventListener('click', startRecording);
  const stopBtn = document.getElementById('quick-stop');
  stopBtn.addEventListener('click', stopRecording);
  let hideTimer;
  onRecordingState((d) => {
    const live = d.state === 'recording';
    stopBtn.hidden = !live;
    document.getElementById('quick-rec').hidden = live;
    document.getElementById('rec-time').textContent = fmtDuration(d.elapsed || 0);
    stopBtn.title = 'Stop recording and save';
    clearTimeout(hideTimer);
    // If the recorder window vanishes without saying goodbye, reset after a while.
    if (live) hideTimer = setTimeout(() => ((stopBtn.hidden = true), (document.getElementById('quick-rec').hidden = false)), 70000);
    if (d.state === 'saved') {
      attachTimelineToRecording(d);
      show('report');
    }
  });

  show(ORDER[settings.mode][0]);
}

init();
