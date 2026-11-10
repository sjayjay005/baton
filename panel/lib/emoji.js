// Emoji picker + :shortcode: expansion. Curated for dev/QA moods rather than the full Unicode set.
import { h, clear } from './dom.js';

// [emoji, shortcode, extra search words]
export const EMOJI = [
  ['Reactions', [
    ['😀', 'grinning', 'happy smile'], ['😂', 'joy', 'lol laugh'], ['🤣', 'rofl', 'laugh'], ['😅', 'sweat_smile', 'phew nervous'], ['😊', 'blush', 'happy'],
    ['😍', 'heart_eyes', 'love'], ['🤩', 'star_struck', 'wow'], ['😎', 'sunglasses', 'cool'], ['🤔', 'thinking', 'hmm'], ['🧐', 'monocle', 'inspect review'],
    ['😐', 'neutral', 'meh'], ['🙄', 'eye_roll', 'again'], ['😬', 'grimacing', 'awkward yikes'], ['😱', 'scream', 'shock'], ['😭', 'sob', 'cry sad'],
    ['😤', 'triumph', 'angry'], ['🤯', 'mind_blown', 'exploding'], ['🥲', 'smiling_tear', 'bittersweet'], ['😴', 'sleeping', 'slow'], ['🫠', 'melting', 'hot'],
    ['🤷', 'shrug', 'idk'], ['🤦', 'facepalm', 'doh'], ['🙏', 'pray', 'please thanks'], ['👏', 'clap', 'applause'], ['🙌', 'raised_hands', 'hooray'],
    ['👍', 'thumbsup', '+1 yes ok'], ['👎', 'thumbsdown', '-1 no'], ['👀', 'eyes', 'look watching'], ['💪', 'muscle', 'strong'], ['🫡', 'salute', 'yes sir'],
  ]],
  ['Bugs & status', [
    ['🐛', 'bug', 'defect issue'], ['🐞', 'beetle', 'bug ladybug'], ['🪲', 'beetle2', 'bug'], ['🔥', 'fire', 'critical hot outage'], ['🚨', 'rotating_light', 'alert incident'],
    ['💥', 'boom', 'crash'], ['💀', 'skull', 'dead'], ['☠️', 'skull_crossbones', 'fatal'], ['⚠️', 'warning', 'caution'], ['❌', 'x', 'fail wrong'],
    ['✅', 'white_check_mark', 'done pass ok'], ['✔️', 'heavy_check_mark', 'check'], ['🟢', 'green_circle', 'ok up'], ['🟡', 'yellow_circle', 'warn'], ['🔴', 'red_circle', 'down error'],
    ['🚧', 'construction', 'wip'], ['🛑', 'stop_sign', 'blocker'], ['⏳', 'hourglass', 'waiting slow'], ['🐢', 'turtle', 'slow perf'], ['🧊', 'ice', 'low cold'],
    ['🩹', 'adhesive_bandage', 'fix patch'], ['🧯', 'fire_extinguisher', 'hotfix'], ['🔁', 'repeat', 'retry flaky'], ['🎲', 'game_die', 'flaky random'], ['🙈', 'see_no_evil', 'hidden oops'],
  ]],
  ['Dev', [
    ['🚀', 'rocket', 'ship deploy release'], ['🛠️', 'hammer_and_wrench', 'tools fix'], ['🔧', 'wrench', 'config'], ['⚙️', 'gear', 'settings'], ['🧪', 'test_tube', 'test qa'],
    ['🔍', 'mag', 'search debug'], ['🧩', 'puzzle', 'integration'], ['📦', 'package', 'npm build'], ['🔒', 'lock', 'security auth'], ['🔑', 'key', 'token secret'],
    ['🌐', 'globe', 'network web'], ['📡', 'satellite', 'api request'], ['🗄️', 'cabinet', 'database storage'], ['💾', 'floppy', 'save'], ['🧹', 'broom', 'cleanup refactor'],
    ['📱', 'iphone', 'mobile'], ['💻', 'computer', 'desktop'], ['🖱️', 'mouse', 'click'], ['⌨️', 'keyboard', 'input'], ['🤖', 'robot', 'bot automation ai'],
    ['☕', 'coffee', 'break'], ['🍕', 'pizza', 'release party'], ['🎉', 'tada', 'party celebrate'], ['🏆', 'trophy', 'win'], ['💯', '100', 'perfect'],
  ]],
  ['Things', [
    ['📸', 'camera_flash', 'screenshot'], ['🎬', 'clapper', 'recording video'], ['📝', 'memo', 'notes steps'], ['📌', 'pushpin', 'pin'], ['📎', 'paperclip', 'attachment'],
    ['🗓️', 'calendar', 'date sprint'], ['⏱️', 'stopwatch', 'timing'], ['📈', 'chart_up', 'metrics'], ['📉', 'chart_down', 'regression'], ['💡', 'bulb', 'idea'],
    ['❤️', 'heart', 'love'], ['💔', 'broken_heart', 'broken'], ['⭐', 'star', 'favorite'], ['✨', 'sparkles', 'new shiny'], ['🌈', 'rainbow', 'fun'],
    ['🦄', 'unicorn', 'magic'], ['🐙', 'octopus', 'github'], ['🦆', 'duck', 'rubber duck debugging'], ['🐐', 'goat', 'legend'], ['🍀', 'four_leaf_clover', 'luck'],
  ]],
];

const BY_CODE = new Map(EMOJI.flatMap(([, items]) => items.map(([e, code]) => [code, e])));
BY_CODE.set('+1', '👍');
BY_CODE.set('-1', '👎');
BY_CODE.set('ok', '✅');

export function expandShortcodes(text) {
  return String(text).replace(/:([a-z0-9_+-]{1,32}):/gi, (m, code) => BY_CODE.get(code.toLowerCase()) || m);
}

export function searchEmoji(q) {
  const s = q.trim().toLowerCase().replace(/^:|:$/g, '');
  const all = EMOJI.flatMap(([, items]) => items);
  if (!s) return all;
  return all.filter(([, code, words]) => code.includes(s) || words.includes(s));
}

function insertAtCursor(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + text.length;
  el.setSelectionRange?.(pos, pos);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
}

// Expand :shortcodes: as you type, keeping the caret in place.
export function enableShortcodes(el) {
  el.addEventListener('input', (e) => {
    if (e.isComposing || !e.isTrusted) return;
    const before = el.value;
    const after = expandShortcodes(before);
    if (after === before) return;
    const pos = el.selectionStart - (before.length - after.length);
    el.value = after;
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

let openPicker = null;
function closePicker() {
  if (openPicker) {
    openPicker.remove();
    openPicker = null;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  }
}
function outside(e) {
  if (openPicker && !openPicker.contains(e.target) && !e.target.closest('.emoji-btn')) closePicker();
}
function onKey(e) {
  if (e.key === 'Escape') closePicker();
}

// Opens a picker anchored to `anchor`; `onPick(emoji)` is called with the chosen emoji.
export function showEmojiPicker(anchor, onPick) {
  closePicker();
  const grid = h('div', { class: 'emoji-grid' });
  const renderGrid = (q) => {
    const list = q ? [['Results', searchEmoji(q)]] : EMOJI;
    clear(
      grid,
      list.map(([cat, items]) => [
        h('div', { class: 'emoji-cat' }, cat),
        items.length
          ? items.map(([e, code]) =>
              h('button', { type: 'button', class: 'emoji', title: `:${code}:`, 'aria-label': code.replace(/_/g, ' '), onclick: () => (onPick(e), closePicker()) }, e),
            )
          : h('div', { class: 'muted small' }, 'No match'),
      ]),
    );
  };
  const search = h('input', { type: 'search', class: 'input', placeholder: 'Search emoji (bug, fire, ship…)', 'aria-label': 'Search emoji', oninput: (e) => renderGrid(e.target.value) });
  const pop = h('div', { class: 'emoji-pop', role: 'dialog', 'aria-label': 'Emoji picker' }, search, grid, h('div', { class: 'muted small' }, 'Tip: type :bug: or :fire: in any field.'));
  renderGrid('');
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const top = Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 8);
  const left = Math.min(Math.max(8, r.right - pop.offsetWidth), window.innerWidth - pop.offsetWidth - 8);
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.left = `${left}px`;
  openPicker = pop;
  search.focus();
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
  });
}

// A 😀 button that inserts into `target` (an input/textarea).
export function emojiButton(target) {
  const btn = h('button', { type: 'button', class: 'emoji-btn', title: 'Insert emoji', 'aria-label': 'Insert emoji' }, '😀');
  btn.addEventListener('click', () => showEmojiPicker(btn, (e) => insertAtCursor(target, e)));
  return btn;
}
