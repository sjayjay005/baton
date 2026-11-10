// Screenshot annotation editor: arrow, box, pen, text, redact and emoji stamps,
// plus a Select tool to move, resize, recolour, edit, duplicate and delete any shape.
// openAnnotator(blob) resolves with the edited PNG blob, or null if cancelled.
import { h, clear } from './dom.js';
import { showEmojiPicker } from './emoji.js';

const COLORS = ['#FF7A45', '#8B7CFF', '#FF3B4E', '#2BD47D', '#FFD23F', '#FFFFFF', '#0D0F1C'];
const TOOLS = [
  ['select', '⬚', 'Select & move (V)'],
  ['arrow', '↗', 'Arrow (A)'],
  ['box', '▭', 'Box (B)'],
  ['pen', '✎', 'Pen (P)'],
  ['text', 'T', 'Text (T)'],
  ['redact', '▇', 'Redact, hides sensitive info (R)'],
  ['emoji', '😀', 'Emoji stamp (E)'],
];
const TOOL_KEYS = { v: 'select', a: 'arrow', b: 'box', p: 'pen', t: 'text', r: 'redact', e: 'emoji' };

// ---- Geometry (pure, exported for tests) ---------------------------------------------
export function shapeBounds(s) {
  if (s.tool === 'pen') {
    const xs = s.points.map((p) => p[0]);
    const ys = s.points.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  if (s.tool === 'text' || s.tool === 'emoji') return { x: s.x1, y: s.y1, w: s.tw || s.size, h: s.size * 1.15 };
  return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function hitShape(s, x, y, tol) {
  const b = shapeBounds(s);
  const inside = x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
  if (s.tool === 'text' || s.tool === 'emoji' || s.tool === 'redact') return inside;
  if (s.tool === 'box') {
    // Border only, so a box around other shapes doesn't swallow their clicks.
    const nearX = x >= b.x - tol && x <= b.x + b.w + tol;
    const nearY = y >= b.y - tol && y <= b.y + b.h + tol;
    return (nearX && (Math.abs(y - b.y) <= tol || Math.abs(y - (b.y + b.h)) <= tol)) || (nearY && (Math.abs(x - b.x) <= tol || Math.abs(x - (b.x + b.w)) <= tol));
  }
  if (s.tool === 'arrow') return distToSegment(x, y, s.x1, s.y1, s.x2, s.y2) <= tol + s.w;
  if (s.tool === 'pen') {
    if (!inside) return false;
    for (let i = 1; i < s.points.length; i++) {
      const [ax, ay] = s.points[i - 1];
      const [bx, by] = s.points[i];
      if (distToSegment(x, y, ax, ay, bx, by) <= tol + s.w) return true;
    }
    return s.points.length === 1 && Math.hypot(x - s.points[0][0], y - s.points[0][1]) <= tol + s.w;
  }
  return false;
}

// Topmost shape under the point, or -1.
export function hitIndex(shapes, x, y, tol) {
  for (let i = shapes.length - 1; i >= 0; i--) if (hitShape(shapes[i], x, y, tol)) return i;
  return -1;
}

export function handlesOf(s) {
  if (s.tool === 'arrow') return [{ id: 'start', x: s.x1, y: s.y1 }, { id: 'end', x: s.x2, y: s.y2 }];
  if (s.tool === 'box' || s.tool === 'redact') {
    return [
      { id: 'nw', x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2) },
      { id: 'ne', x: Math.max(s.x1, s.x2), y: Math.min(s.y1, s.y2) },
      { id: 'sw', x: Math.min(s.x1, s.x2), y: Math.max(s.y1, s.y2) },
      { id: 'se', x: Math.max(s.x1, s.x2), y: Math.max(s.y1, s.y2) },
    ];
  }
  if (s.tool === 'text' || s.tool === 'emoji') {
    const b = shapeBounds(s);
    return [{ id: 'scale', x: b.x + b.w, y: b.y + b.h }];
  }
  return [];
}

export function moveShape(s, dx, dy) {
  const n = { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: (s.x2 ?? s.x1) + dx, y2: (s.y2 ?? s.y1) + dy };
  if (s.points) n.points = s.points.map(([x, y]) => [x + dx, y + dy]);
  return n;
}

// Drag handle `id` of the ORIGINAL shape `s` to (x, y).
export function resizeShape(s, id, x, y) {
  if (s.tool === 'arrow') return id === 'start' ? { ...s, x1: x, y1: y } : { ...s, x2: x, y2: y };
  if (s.tool === 'box' || s.tool === 'redact') {
    let l = Math.min(s.x1, s.x2);
    let t = Math.min(s.y1, s.y2);
    let r = Math.max(s.x1, s.x2);
    let b = Math.max(s.y1, s.y2);
    if (id.includes('w')) l = x;
    if (id.includes('e')) r = x;
    if (id.includes('n')) t = y;
    if (id.includes('s')) b = y;
    return { ...s, x1: l, y1: t, x2: r, y2: b };
  }
  if (s.tool === 'text' || s.tool === 'emoji') {
    const b = shapeBounds(s);
    const scale = Math.max(0.2, Math.max((x - b.x) / (b.w || 1), (y - b.y) / (b.h || 1)));
    const size = Math.max(10, Math.round(s.size * scale));
    return { ...s, size, tw: (s.tw || s.size) * (size / s.size) };
  }
  return s;
}

// ---- Drawing --------------------------------------------------------------------------
function drawArrow(ctx, s) {
  const { x1, y1, x2, y2 } = s;
  const head = Math.max(14, s.w * 4);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2 - Math.cos(ang) * head * 0.6, y2 - Math.sin(ang) * head * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 7), y2 - head * Math.sin(ang - Math.PI / 7));
  ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 7), y2 - head * Math.sin(ang + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

const fontFor = (s) => `${s.tool === 'text' ? '600 ' : ''}${s.size}px Inter, system-ui, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif`;

function drawShape(ctx, s) {
  ctx.save();
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.tool === 'arrow') drawArrow(ctx, s);
  else if (s.tool === 'box') ctx.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
  else if (s.tool === 'redact') {
    ctx.fillStyle = '#000';
    ctx.fillRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
  } else if (s.tool === 'pen') {
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  } else if (s.tool === 'text' || s.tool === 'emoji') {
    ctx.font = fontFor(s);
    ctx.textBaseline = 'top';
    s.tw = ctx.measureText(s.text).width; // keep bounds accurate for selection
    if (s.tool === 'text') {
      ctx.lineWidth = Math.max(3, s.size / 8);
      ctx.strokeStyle = s.color === '#0D0F1C' ? '#FFFFFF' : '#0D0F1C';
      ctx.strokeText(s.text, s.x1, s.y1);
    }
    ctx.fillText(s.text, s.x1, s.y1);
  }
  ctx.restore();
}

function drawSelection(ctx, s, unit) {
  const b = shapeBounds(s);
  const pad = unit * 1.2;
  ctx.save();
  ctx.lineWidth = Math.max(1.5, unit / 4);
  ctx.setLineDash([unit, unit * 0.7]);
  ctx.strokeStyle = '#FFFFFF';
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.lineDashOffset = unit;
  ctx.strokeStyle = '#5B49E6';
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.setLineDash([]);
  for (const hd of handlesOf(s)) {
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#5B49E6';
    ctx.lineWidth = Math.max(2, unit / 4);
    ctx.beginPath();
    if (s.tool === 'arrow') ctx.arc(hd.x, hd.y, unit * 0.8, 0, Math.PI * 2);
    else ctx.rect(hd.x - unit * 0.7, hd.y - unit * 0.7, unit * 1.4, unit * 1.4);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// ---- Editor -------------------------------------------------------------------------
export function openAnnotator(blob) {
  return new Promise(async (resolve) => {
    const img = await createImageBitmap(blob);
    const canvas = h('canvas', { class: 'anno-canvas', width: img.width, height: img.height, 'aria-label': 'Screenshot being annotated', tabindex: 0 });
    const ctx = canvas.getContext('2d');
    let shapes = [];
    const history = [];
    let tool = 'arrow';
    let color = COLORS[0];
    let stampEmoji = '🐛';
    let drawing = null;
    let selected = -1;
    let drag = null; // { mode: 'move'|'resize', handle, start: [x,y], orig: shape }
    const base = Math.max(img.width, img.height);
    const lineW = Math.max(3, Math.round(base / 400));
    const unit = Math.max(6, Math.round(base / 160)); // handle size / hit tolerance in image px

    const snapshot = () => {
      history.push(JSON.stringify(shapes));
      if (history.length > 100) history.shift();
    };
    const undo = () => {
      if (!history.length) return;
      shapes = JSON.parse(history.pop());
      selected = -1;
      redraw();
      renderToolbar();
    };
    const redraw = (withSelection = true) => {
      ctx.drawImage(img, 0, 0);
      [...shapes, drawing].filter(Boolean).forEach((s) => drawShape(ctx, s));
      if (withSelection && selected >= 0 && shapes[selected]) drawSelection(ctx, shapes[selected], unit);
    };
    const pt = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
    };
    const select = (i) => {
      selected = i;
      redraw();
      renderToolbar();
    };
    const handleAt = (x, y) => {
      if (selected < 0) return null;
      return handlesOf(shapes[selected]).find((hd) => Math.hypot(hd.x - x, hd.y - y) <= unit * 1.6) || null;
    };
    const updateSelected = (patch) => {
      if (selected < 0) return;
      snapshot();
      shapes[selected] = { ...shapes[selected], ...patch };
      redraw();
    };
    const removeSelected = () => {
      if (selected < 0) return;
      snapshot();
      shapes.splice(selected, 1);
      select(-1);
    };
    const duplicateSelected = () => {
      if (selected < 0) return;
      snapshot();
      shapes.push(moveShape(structuredClone(shapes[selected]), unit * 3, unit * 3));
      select(shapes.length - 1);
    };
    const bringToFront = () => {
      if (selected < 0 || selected === shapes.length - 1) return;
      snapshot();
      shapes.push(shapes.splice(selected, 1)[0]);
      select(shapes.length - 1);
    };

    const toolbar = h('div', { class: 'anno-tools', role: 'toolbar', 'aria-label': 'Annotation tools' });
    function renderToolbar() {
      const sel = selected >= 0 ? shapes[selected] : null;
      clear(
        toolbar,
        TOOLS.map(([id, icon, label]) =>
          h(
            'button',
            {
              type: 'button',
              class: `tool${tool === id ? ' active' : ''}`,
              title: label,
              'aria-label': label,
              'aria-pressed': String(tool === id),
              onclick: (e) => {
                tool = id;
                if (id !== 'select') select(-1);
                if (id === 'emoji') showEmojiPicker(e.currentTarget, (em) => ((stampEmoji = em), sel && sel.tool === 'emoji' ? updateSelected({ text: em }) : null, renderToolbar()));
                renderToolbar();
                canvas.style.cursor = id === 'select' ? 'default' : 'crosshair';
              },
            },
            id === 'emoji' ? stampEmoji : icon,
          ),
        ),
        h('span', { class: 'sep' }),
        COLORS.map((c) =>
          h('button', {
            type: 'button',
            class: `swatch${(sel ? sel.color : color) === c ? ' active' : ''}`,
            style: `background:${c}`,
            title: sel ? `Recolour selection ${c}` : c,
            'aria-label': `Colour ${c}`,
            'aria-pressed': String(color === c),
            onclick: () => {
              color = c;
              if (sel && sel.tool !== 'redact') updateSelected({ color: c });
              renderToolbar();
            },
          }),
        ),
        h('span', { class: 'sep' }),
        sel
          ? [
              h('span', { class: 'anno-sel-label' }, `Selected: ${sel.tool === 'emoji' ? sel.text : sel.tool}`),
              sel.tool === 'text' ? h('button', { type: 'button', class: 'btn ghost', onclick: () => editText(selected) }, 'Edit text') : null,
              h('button', { type: 'button', class: 'btn ghost', title: 'Duplicate (Ctrl/⌘+D)', onclick: duplicateSelected }, 'Duplicate'),
              h('button', { type: 'button', class: 'btn ghost', title: 'Bring to front', onclick: bringToFront }, 'Front'),
              h('button', { type: 'button', class: 'btn ghost', title: 'Delete (Del)', onclick: removeSelected }, 'Delete'),
            ]
          : h('span', { class: 'muted small' }, tool === 'select' ? 'Click a shape to select it, drag to move, use the handles to resize.' : 'Tip: press V, or click a selected shape, to move it.'),
        h('span', { class: 'sep' }),
        h('button', { type: 'button', class: 'btn ghost', title: 'Undo (Ctrl/⌘+Z)', onclick: undo }, 'Undo'),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => (snapshot(), (shapes = []), select(-1)) }, 'Clear'),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => finish(false) }, 'Cancel'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => finish(true) }, 'Save'),
      );
    }

    const stage = h('div', { class: 'anno-stage' }, canvas);
    const overlay = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Annotate screenshot' }, h('div', { class: 'modal-box anno' }, toolbar, stage));

    // Floating text box, for new text or editing existing text.
    function textBox({ x, y, initial = '', textColor, onDone }) {
      const input = h('input', { class: 'anno-text', placeholder: 'Type, then Enter', 'aria-label': 'Annotation text' });
      input.value = initial;
      const cr = canvas.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      input.style.left = `${(x * cr.width) / canvas.width + cr.left - sr.left + stage.scrollLeft}px`;
      input.style.top = `${(y * cr.height) / canvas.height + cr.top - sr.top + stage.scrollTop}px`;
      input.style.color = textColor;
      stage.append(input);
      input.focus();
      input.select();
      let closed = false;
      const commit = (keep) => {
        if (closed) return;
        closed = true;
        input.remove();
        onDone(keep ? input.value.trim() : null);
        canvas.focus();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit(true);
        if (e.key === 'Escape') commit(false);
      });
      input.addEventListener('blur', () => commit(true));
    }
    function editText(i) {
      const s = shapes[i];
      if (!s || s.tool !== 'text') return;
      const hidden = { ...s };
      shapes[i] = { ...s, text: '' }; // hide while editing
      redraw();
      textBox({
        x: s.x1,
        y: s.y1,
        initial: s.text,
        textColor: s.color,
        onDone: (val) => {
          shapes[i] = hidden;
          if (val !== null && val !== hidden.text) {
            snapshot();
            if (val) shapes[i] = { ...hidden, text: val };
            else shapes.splice(i, 1), (selected = -1);
          }
          redraw();
          renderToolbar();
        },
      });
    }

    canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = pt(e);
      // 1) Handles of the current selection (any tool)
      const hd = handleAt(x, y);
      if (hd) {
        snapshot();
        drag = { mode: 'resize', handle: hd.id, orig: structuredClone(shapes[selected]) };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      // 2) Clicking a shape: in Select mode any shape; otherwise only the selected one
      const hit = hitIndex(shapes, x, y, unit);
      if (hit >= 0 && (tool === 'select' || hit === selected)) {
        if (hit !== selected) select(hit);
        snapshot();
        drag = { mode: 'move', start: [x, y], orig: structuredClone(shapes[selected]), moved: false };
        canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (tool === 'select') return select(-1);
      // 3) Drawing tools
      select(-1);
      if (tool === 'text') {
        e.preventDefault();
        return textBox({
          x,
          y,
          textColor: color,
          onDone: (val) => {
            if (!val) return;
            snapshot();
            shapes.push({ tool: 'text', text: val, x1: x, y1: y, color, size: Math.max(18, Math.round(base / 45)), w: lineW });
            select(shapes.length - 1);
          },
        });
      }
      if (tool === 'emoji') {
        const size = Math.max(32, Math.round(base / 18));
        snapshot();
        shapes.push({ tool: 'emoji', text: stampEmoji, x1: x - size / 2, y1: y - size / 2, size, color, w: lineW });
        return select(shapes.length - 1);
      }
      canvas.setPointerCapture(e.pointerId);
      drawing = { tool, color, w: lineW, x1: x, y1: y, x2: x, y2: y, points: [[x, y]] };
    });

    canvas.addEventListener('pointermove', (e) => {
      const [x, y] = pt(e);
      if (drag) {
        if (drag.mode === 'move') {
          drag.moved = true;
          shapes[selected] = moveShape(drag.orig, x - drag.start[0], y - drag.start[1]);
        } else shapes[selected] = resizeShape(drag.orig, drag.handle, x, y);
        return redraw();
      }
      if (drawing) {
        drawing.x2 = x;
        drawing.y2 = y;
        if (drawing.tool === 'pen') drawing.points.push([x, y]);
        return redraw();
      }
      // Cursor feedback
      const hd = handleAt(x, y);
      const hit = hitIndex(shapes, x, y, unit);
      canvas.style.cursor = hd ? (hd.id === 'scale' || hd.id === 'nw' || hd.id === 'se' ? 'nwse-resize' : hd.id === 'ne' || hd.id === 'sw' ? 'nesw-resize' : 'move') : hit >= 0 && (tool === 'select' || hit === selected) ? 'move' : tool === 'select' ? 'default' : 'crosshair';
    });

    canvas.addEventListener('pointerup', () => {
      if (drag) {
        if (drag.mode === 'move' && !drag.moved) history.pop(); // a click, not a move
        drag = null;
        redraw();
        return;
      }
      if (!drawing) return;
      const moved = Math.hypot(drawing.x2 - drawing.x1, drawing.y2 - drawing.y1) > 3 || drawing.points.length > 2;
      if (moved) {
        snapshot();
        shapes.push(drawing);
        drawing = null;
        select(shapes.length - 1); // ready to move/resize straight away
      } else {
        drawing = null;
        redraw();
      }
    });

    canvas.addEventListener('dblclick', (e) => {
      const [x, y] = pt(e);
      const i = hitIndex(shapes, x, y, unit);
      if (i >= 0 && shapes[i].tool === 'text') {
        select(i);
        editText(i);
      }
    });

    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') return e.preventDefault(), undo();
      if (mod && e.key.toLowerCase() === 'd') return e.preventDefault(), duplicateSelected();
      if (e.key === 'Escape') return selected >= 0 ? select(-1) : finish(false);
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0) return e.preventDefault(), removeSelected();
      if (selected >= 0 && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        snapshot();
        shapes[selected] = moveShape(shapes[selected], dx, dy);
        return redraw();
      }
      if (!mod && !e.altKey && TOOL_KEYS[e.key.toLowerCase()]) {
        tool = TOOL_KEYS[e.key.toLowerCase()];
        if (tool !== 'select') select(-1);
        renderToolbar();
      }
    };
    document.addEventListener('keydown', onKey);

    function finish(save) {
      document.removeEventListener('keydown', onKey);
      if (!save) {
        overlay.remove();
        return resolve(null);
      }
      selected = -1;
      redraw(false); // never bake the selection outline into the image
      canvas.toBlob((b) => {
        overlay.remove();
        resolve(b);
      }, 'image/png');
    }

    renderToolbar();
    document.body.append(overlay);
    redraw();
    canvas.focus();
  });
}
