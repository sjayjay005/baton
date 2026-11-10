import { loadSettings, settings } from '../panel/lib/settings.js';
import { applyTheme } from '../panel/lib/theme.js';
import { mountTools } from '../panel/modules/tools.js';

await loadSettings();
applyTheme(settings.theme);
mountTools(document.getElementById('tools'), { standalone: true });
