// Turns captured page events into readable steps and a merged timeline. Pure (testable).

const q = (s) => `“${String(s).trim()}”`;

export function describeAction(a) {
  const name = a.name ? q(a.name) : a.selector ? `\`${a.selector}\`` : '';
  const el = a.el || '';
  const what = el && !['page', 'form', 'field', 'dropdown'].includes(el) ? ` ${el}` : '';
  switch (a.action) {
    case 'click':
      return `Click ${name}${what}`.replace(/\s+/g, ' ').trim();
    case 'type':
      return `Type ${a.value ? q(a.value) : 'text'} into ${name || 'a field'}`;
    case 'select':
      return `Select ${q(a.value)} in ${name || 'a dropdown'}`;
    case 'check':
      return `Tick ${name || 'a checkbox'}`;
    case 'uncheck':
      return `Untick ${name || 'a checkbox'}`;
    case 'enter':
      return `Press Enter in ${name || 'a field'}`;
    case 'submit':
      return a.name ? `Submit the ${a.name} form` : 'Submit the form';
    case 'navigate':
      return a.how === 'load' ? `Open ${a.name}` : a.how === 'back/forward' ? `Go back/forward to ${a.name}` : `Navigate to ${a.name}`;
    default:
      return `${a.action} ${name}`.trim();
  }
}

// Repro steps from user actions: drops noise (Enter right after typing in the same field,
// repeated typing in one field, duplicate navigations) and caps the list.
export function stepsFromActions(actions, max = 25) {
  const out = [];
  let prev = null;
  for (const a of actions) {
    if (prev) {
      const same = a.selector && a.selector === prev.selector;
      if (a.action === 'type' && prev.action === 'type' && same) {
        out[out.length - 1] = a;
        prev = a;
        continue;
      }
      if (a.action === 'navigate' && prev.action === 'navigate' && a.name === prev.name) continue;
      if (a.action === 'navigate' && a.how === 'push' && prev.action === 'click' && a.time - prev.time < 1500) {
        // A click that navigated: keep the click, the URL change is implied.
        prev = a;
        continue;
      }
    }
    out.push(a);
    prev = a;
  }
  return out.slice(-max).map(describeAction);
}

const ICON = { action: '👆', console: '🔴', network: '🌐', storage: '🗄️', mock: '🎭' };
export { ICON as TIMELINE_ICONS };

function shortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

// Normalises the different sources into { time, type, icon, text, level }.
export function mergeTimeline({ actions = [], consoleEntries = [], requests = [], storage = [], mocks = [] }) {
  const items = [];
  for (const a of actions) items.push({ time: a.time, type: 'action', text: describeAction(a), level: 'info' });
  for (const c of consoleEntries) items.push({ time: c.time, type: 'console', text: `${c.level === 'warn' ? 'Warning' : 'Error'}: ${c.message.split('\n')[0].slice(0, 160)}`, level: c.level === 'warn' ? 'warn' : 'error' });
  for (const r of requests) {
    const e = r.entry || r;
    const t = Date.parse(e.startedDateTime);
    if (!t) continue;
    const s = e.response ? e.response.status : 0;
    items.push({ time: t, type: 'network', text: `${e.request.method} ${shortPath(e.request.url)} → ${s || 'failed'}${e.time ? ` (${Math.round(e.time)}ms)` : ''}`, level: !s || s >= 500 ? 'error' : s >= 400 ? 'warn' : 'info' });
  }
  for (const s of storage) {
    const text = s.op === 'clear' ? `${s.area}Storage cleared (${s.oldValue})` : s.op === 'remove' ? `${s.area}.${s.key} removed` : `${s.area}.${s.key} = ${String(s.newValue).slice(0, 60)}`;
    items.push({ time: s.time, type: 'storage', text: `${s.blocked ? '🔒 Blocked: ' : ''}${text}${s.by === 'baton' ? ' (by Baton)' : ''}`, level: s.blocked ? 'warn' : 'info' });
  }
  for (const m of mocks) items.push({ time: m.time, type: 'mock', text: `${m.type === 'delay' ? 'Delayed' : 'Mocked'} ${m.method} ${shortPath(m.target)}${m.status ? ` → ${m.status}` : ''} (${m.ruleName})`, level: 'info' });
  return items.sort((a, b) => a.time - b.time).map((i) => ({ ...i, icon: ICON[i.type] }));
}

export function relTime(ms) {
  const neg = ms < 0;
  const s = Math.abs(ms) / 1000;
  const m = Math.floor(s / 60);
  return `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

export function timelineText(items, since = items.length ? items[0].time : 0) {
  return items.map((i) => `${relTime(i.time - since)}  ${i.icon} ${i.text}`).join('\n');
}
