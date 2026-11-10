import { h, clear, copyText, download, toast, accordion } from '../lib/dom.js';
import { settings, shared, on, onSettingChange, emit } from '../lib/settings.js';
import { readEnvironment, readStorage } from '../lib/page.js';
import { buildReport, isFailed, maskStorageEntries, toCurl, prettyBody } from '../lib/format.js';
import { createWorkItem, markdownToHtml, SEVERITIES } from '../lib/azure.js';
import { emojiButton, enableShortcodes } from '../lib/emoji.js';
import { fmtBytes } from '../lib/media.js';
import { loadAzureConfig, isAzureReady } from './settings.js';
import { mediaSection, includedMedia, initMedia } from './media.js';
import { timelineItems, reproSteps } from './timeline.js';
import { timelineText } from '../lib/timeline.js';

let root, previewEl, summaryEl, azureBtn, azureStatus, mediaAcc;
let azureCfg = null;
const form = { title: '', severity: '', steps: '', expected: '', actual: '' };
const include = { requests: true, console: true, storage: true, env: true, timeline: true };
let lastMarkdown = '';
let renderTimer;

const SEVERITY_LABEL = { '1 - Critical': '🔥 Critical', '2 - High': '😬 High', '3 - Medium': '🤔 Medium', '4 - Low': '🧊 Low' };

function reportRequests() {
  return shared.requests.filter((r) => shared.pinned.has(r.id) || isFailed(r.entry));
}

function consoleErrors() {
  return shared.consoleEntries.filter((e) => e.level === 'error');
}

async function collect() {
  const env = include.env ? await readEnvironment().catch(() => null) : null;
  if (env) env.capturedAt = new Date().toISOString();
  const storage = include.storage ? await readStorage().catch(() => null) : null;
  const requests = include.requests ? await Promise.all(reportRequests().map(async (r) => ({ entry: r.entry, body: await r.body() }))) : [];
  const tl = include.timeline ? timelineItems({ sinceMs: 2 * 60 * 1000 }) : [];
  return { env, storage, requests, consoleEntries: include.console ? consoleErrors() : [], timeline: tl.length ? timelineText(tl.slice(-60)) : '' };
}

function reportArgs(data, { withAttachments = true } = {}) {
  return {
    ...form,
    severity: form.severity ? SEVERITY_LABEL[form.severity] : '',
    ...data,
    attachments: withAttachments ? includedMedia() : [],
    mask: settings.mask,
  };
}

async function renderPreview() {
  const data = await collect();
  lastMarkdown = buildReport(reportArgs(data));
  previewEl.textContent = lastMarkdown;
  return data;
}

function schedulePreview() {
  if (!root || root.offsetParent === null) return; // hidden: refreshed in showReport()
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderPreview, 250);
}

function renderSummary() {
  const reqs = reportRequests();
  const pinned = reqs.filter((r) => shared.pinned.has(r.id)).length;
  const media = includedMedia();
  const items = [
    ['requests', `Requests (${reqs.length}${pinned ? `, ${pinned} pinned` : ''}, failed + pinned)`],
    ['console', `Console errors (${consoleErrors().length})`],
    ['storage', 'Storage snapshot'],
    ['env', 'Environment (URL, browser, viewport)'],
    ['timeline', `Timeline, last 2 min (${timelineItems({ sinceMs: 2 * 60 * 1000 }).length} events)`],
  ];
  clear(
    summaryEl,
    items.map(([key, label]) => {
      const box = h('input', { type: 'checkbox', id: `inc-${key}`, checked: include[key] });
      box.addEventListener('change', () => {
        include[key] = box.checked;
        schedulePreview();
      });
      return h('label', { class: 'check', for: `inc-${key}` }, box, label);
    }),
    h('div', { class: 'muted small' }, media.length ? `📎 ${media.length} media item${media.length === 1 ? '' : 's'} (${fmtBytes(media.reduce((n, m) => n + (m.size || 0), 0))}) included` : '📎 No media included'),
  );
}

async function bundleJson(data) {
  data ||= await collect();
  const mask = settings.mask;
  return JSON.stringify(
    {
      baton: '0.5.0',
      kind: 'bug-bundle',
      ...form,
      environment: data.env,
      console: data.consoleEntries,
      requests: data.requests.map(({ entry, body }) => ({
        method: entry.request.method,
        url: entry.request.url,
        status: entry.response.status,
        timeMs: entry.time ? Math.round(entry.time) : null,
        curl: toCurl(entry, { mask }),
        response: body == null ? null : prettyBody(body).slice(0, 20000),
      })),
      storage: data.storage && {
        origin: data.storage.origin,
        local: Object.fromEntries(maskStorageEntries(data.storage.local, { mask })),
        session: Object.fromEntries(maskStorageEntries(data.storage.session, { mask })),
      },
      timeline: include.timeline ? timelineItems({ sinceMs: 5 * 60 * 1000 }) : [],
      actions: shared.actions.slice(-200),
      attachments: includedMedia().map((m) => ({ kind: m.kind, name: m.name, size: m.size, sourceUrl: m.sourceUrl || null })),
    },
    null,
    2,
  );
}

const slug = () => (form.title || 'bug-report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'bug-report';

function renderAzureButton() {
  if (!azureBtn) return;
  const ready = azureCfg && isAzureReady(azureCfg);
  azureBtn.textContent = ready ? `🚀 Create ${azureCfg.type || 'Bug'} in Azure Boards` : 'Connect Azure Boards…';
  azureBtn.title = ready ? `${azureCfg.org} / ${azureCfg.project}` : 'Set up the connection in Settings';
}

async function sendToAzure() {
  if (!azureCfg || !isAzureReady(azureCfg)) return emit('goto', 'settings');
  if (!form.title.trim()) {
    toast('Add a title first');
    document.getElementById('f-title').focus();
    return;
  }
  const media = includedMedia();
  const tooBig = media.find((m) => (m.size || 0) > 60 * 1024 * 1024);
  if (tooBig) return toast(`${tooBig.name} is over 60 MB, which is too big for Azure. Untick it or trim the recording.`);
  azureBtn.disabled = true;
  azureStatus.className = 'status-line';
  clear(azureStatus, media.length ? `Uploading ${media.length} attachment${media.length === 1 ? '' : 's'}…` : 'Creating work item…');
  try {
    const data = await renderPreview();
    const md = buildReport(reportArgs(data, { withAttachments: false }));
    const html = markdownToHtml(md.replace(/^## .*\n/, '').trim());
    const files = media.map((m) => ({ name: m.name, content: m.blob, kind: m.kind }));
    if (azureCfg.attach) files.push({ name: `${slug()}.baton.json`, content: await bundleJson(data), kind: 'bundle' });
    const { id, url } = await createWorkItem(azureCfg, { title: form.title.trim(), html, files, severity: form.severity });
    azureStatus.className = 'status-line ok';
    clear(azureStatus, `🎉 Created #${id} · `, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in Azure Boards'));
    toast(`Bug #${id} created 🎉`);
  } catch (err) {
    azureStatus.className = 'status-line bad';
    clear(azureStatus, err.message);
  } finally {
    azureBtn.disabled = false;
  }
}

export function mountReport(container) {
  root = container;
  previewEl = h('pre', { class: 'code preview', 'aria-live': 'polite' });
  summaryEl = h('div', { class: 'includes' });
  azureBtn = h('button', { type: 'button', class: 'btn azure', onclick: sendToAzure }, 'Connect Azure Boards…');
  azureStatus = h('div', { class: 'status-line', role: 'status' });

  const fields = {};
  const field = (key, label, multiline, placeholder) => {
    const el = multiline
      ? h('textarea', { class: 'input', rows: key === 'steps' ? 5 : 2, placeholder, id: `f-${key}` })
      : h('input', { class: 'input', placeholder, id: `f-${key}` });
    el.value = form[key];
    el.addEventListener('input', () => {
      form[key] = el.value;
      schedulePreview();
    });
    enableShortcodes(el);
    const extra =
      key === 'steps'
        ? h(
            'button',
            {
              type: 'button',
              class: 'chip',
              title: 'Write the steps from what you did on the page (last 5 minutes)',
              onclick: () => {
                const steps = reproSteps();
                if (!steps.length) return toast('No user actions captured yet. Use the page, then try again.');
                fillSteps(steps);
              },
            },
            '✨ From timeline',
          )
        : null;
    fields[key] = el;
    return h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('label', { for: `f-${key}` }, label), h('span', { class: 'grow' }), extra, emojiButton(el)), el);
  };
  const fillSteps = (steps) => {
    fields.steps.value = steps.join('\n');
    form.steps = fields.steps.value;
    schedulePreview();
    toast(`✨ ${steps.length} steps added. Edit as needed.`);
  };
  on('fill-steps', fillSteps);

  const sevSel = h('select', { class: 'input', id: 'f-severity' }, h('option', { value: '' }, 'No severity'), SEVERITIES.map((s) => h('option', { value: s }, SEVERITY_LABEL[s])));
  sevSel.addEventListener('change', () => {
    form.severity = sevSel.value;
    schedulePreview();
  });

  mediaAcc = accordion('report.media', 'Screenshots, recordings & GIFs', true);
  mediaAcc.body.append(mediaSection());

  clear(
    root,
    h(
      'div',
      { class: 'report-grid' },
      h(
        'div',
        { class: 'stack' },
        h(
          'section',
          { class: 'card stack' },
          h('div', { class: 'section-head' }, h('h2', {}, 'Bug report')),
          h('div', { class: 'title-row' }, field('title', 'Title', false, 'Checkout fails with coupon SPRING 🐛'), h('div', { class: 'field' }, h('label', { for: 'f-severity', class: 'field-label' }, 'Severity'), sevSel)),
          field('steps', 'Steps to reproduce (one per line)', true, 'Add an item to the cart\nGo to /checkout\nApply coupon SPRING'),
          field('expected', 'Expected', true, 'Order summary shows the discounted total ✅'),
          field('actual', 'Actual', true, 'Blank summary and a 500 from /api/v1/checkout 💥'),
        ),
        mediaAcc.el,
        h(
          'section',
          { class: 'card stack' },
          h('div', { class: 'section-head' }, h('h2', {}, 'Include')),
          summaryEl,
          h('p', { class: 'muted small' }, 'Tip: in the Network tab, “Add to report” pins any request, even successful ones. Secrets are masked while “Mask secrets” is on.'),
          h(
            'div',
            { class: 'row-form' },
            h(
              'button',
              {
                type: 'button',
                class: 'btn primary',
                onclick: async () => {
                  await renderPreview();
                  copyText(lastMarkdown);
                },
              },
              'Pass the baton (copy Markdown)',
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn',
                onclick: async () => {
                  await renderPreview();
                  download(`${slug()}.md`, lastMarkdown, 'text/markdown');
                },
              },
              'Download .md',
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn',
                onclick: async () => {
                  download(`${slug()}.baton.json`, await bundleJson(), 'application/json');
                  toast('Bundle downloaded');
                },
              },
              'Download bundle .json',
            ),
          ),
          h('div', { class: 'row-form' }, azureBtn),
          azureStatus,
        ),
      ),
      h('section', { class: 'card stack' }, h('div', { class: 'section-head' }, h('h2', {}, 'Preview')), previewEl),
    ),
  );

  const refresh = () => {
    renderSummary();
    schedulePreview();
  };
  on('requests-changed', refresh);
  on('console-changed', refresh);
  on('media-changed', refresh);
  onSettingChange((key) => key === 'mask' && schedulePreview());
  on('azure-changed', (cfg) => {
    azureCfg = cfg;
    renderAzureButton();
  });
  loadAzureConfig().then((cfg) => {
    azureCfg = cfg;
    renderAzureButton();
  });
  initMedia(root);
  renderSummary();
  schedulePreview();
}

export function showReport() {
  if (root) {
    renderSummary();
    schedulePreview();
  }
}
