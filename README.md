# Baton – Dev & QA Toolkit (v0.5.1)

One DevTools panel for devs and QAs: inspect, mock and replay requests; flip storage flags and cookies; decode JWTs; capture screenshots, recordings and a full timeline; and file bugs straight into Azure Boards.

**[Website](https://sjayjay005.github.io/baton/)** · **[Privacy policy](https://sjayjay005.github.io/baton/privacy.html)** · **[Support](https://sjayjay005.github.io/baton/support.html)**

## Install (unpacked)

1. Unzip, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `baton` folder.
2. Open DevTools (F12 / ⌘⌥I) → **Baton** tab (check the **»** menu if it's hidden). Reload the page once so Baton hooks in from the start.
3. Optional: to use **Inject JS** rules, open Baton's **Details** in `chrome://extensions` and turn on **Allow user scripts** (Chrome 138+; older Chrome uses Developer mode).

## Tabs

| Tab | What it does |
| --- | --- |
| **Network** | Live requests with search (incl. request/response **bodies**), method/status/domain filters, slow requests in orange (≥500ms) / red (≥1s). Multi-select → copy cURL, **🤖 Copy for AI**, **🐶 Export to Bruno**, add to report. Per request: cURL, fetch, AI copy, **↻ Replay** (editable, sent from the page), **🎭 Mock this**, JWT decoding of auth headers, Markdown hand-off. |
| **Mocks** | Rules: **mock response** (status, body, delay, GraphQL operation), **delay**, **redirect**, **swap host**, **modify headers**, **block**, **inject CSS**, **inject JS**. Toggle each, reorder (top wins), pause all, hit counts, export/import for the team. |
| **Storage** | **Flags** (true/false, 1/0 as switches), **Cyclers** (rotate a key through values, shortcuts Alt+Shift+1/2/3, optional reload), **Values** (edit, JWT badges), **Cookies** (incl. HttpOnly; edit all attributes), **History** (every change with the code that made it + ↩ roll back), **Snapshots**. 🔒 Lock keys so the page can't change them. Import/export JSON, clear-but-keep-locked, Copy for AI, reload-after-change. |
| **Console** | Errors/warnings with stacks; run code in the page (with `await`) and save snippets. |
| **Timeline** | Clicks, typing (passwords masked), selects, navigation, requests, errors, storage changes and mock hits in one ordered list. **Instant replay**: last 30s/60s/5min. **✨ Use as repro steps** writes the steps for you. |
| **Replay** | **Deterministic record & replay.** ● Record reloads the page and captures the starting storage and cookies, every fetch/XHR response, the clock, `Math.random`, `crypto` randomness and your clicks/typing. ▶ Replay restores all of it, serves the API from the recording and repeats the steps, so the bug happens again exactly, even if the backend changed. 🔬 **Minimize** runs delta debugging (Zeller's ddmin) to find the fewest steps that still cause a chosen error. Export/attach sessions (`.baton-session.json`) so a dev can import and replay a QA's bug. |
| **Bug report** | Title, severity, steps (or ✨ from timeline), expected/actual, screenshots (annotate), recordings (▶ play in sync with the timeline), GIFs, failed/pinned requests, console errors, storage, timeline. Copy Markdown, download `.md` / `.baton.json`, or **🚀 Create Bug in Azure Boards**. |
| **Tools** | **JWT** decode (claims, expiry), edit & re-sign (HS256/384/512, none), verify with secret. **Base64** encode/decode (UTF-8, URL-safe, files). **URL** encode/decode/parse. **.npmrc** editor: see credentials, rotate an Azure DevOps PAT everywhere in the file, add an Azure Artifacts feed, save back to the file. |
| **Links / Settings** | Team bookmarks (also in the toolbar popup). Azure Boards connection (PAT from paste or `.npmrc`), GIPHY key. |

Screenshot editor: arrow, box, pen, text, redact and emoji stamps. Use **⬚ Select** (V) to click any shape, drag it to move it, pull its handles to resize (box corners, arrow ends, text/emoji size), recolour it, double-click text to edit it, duplicate (Ctrl/⌘+D), bring to front or delete (Del). Arrow keys nudge; undo (Ctrl/⌘+Z) covers everything. A shape you just drew is selected so you can adjust it straight away.

Top bar: 📸 Screenshot, ⏺ Record, theme (🖥️ auto follows DevTools, 🌙 dark, ☀️ light), Mask secrets, Dev/QA mode.

## Bruno export

Tick requests in Network → **🐶 Export to Bruno** downloads a zip. Unzip it, then in Bruno choose **Open Collection** and pick the folder. With Mask secrets on, auth headers become `{{authorization}}`-style variables listed in `environments/Baton.bru`; fill them in Bruno.

## .npmrc editor

Tools → .npmrc → **Open .npmrc…** (in DevTools this opens the editor in its own tab so it can write back to the file). Your user file is `~/.npmrc` (Windows `%USERPROFILE%\.npmrc`); on a Mac press ⌘⇧. in the picker to show hidden files. **Rotate Azure DevOps token** replaces every Azure `_password` (base64) / `_authToken` with the new PAT; click **Save**.

## How mocks work

- Mock response, delay and GraphQL rules wrap `fetch`/`XMLHttpRequest` in the page. Mocked calls never reach the network, so they don't show in the Network tab; see **Recent mock hits** in Mocks and the Timeline. Synchronous XHR isn't mocked.
- Redirect, host swap, headers and block use Chrome's `declarativeNetRequest`, so they apply to every request type (scripts, images, iframes…). Regex must be RE2-compatible.
- CSS is injected when matching pages load. JS needs **Allow user scripts**.

## Privacy

Everything stays in your browser. Network calls only go to `dev.azure.com` (when you connect or create a bug) and `api.giphy.com` (GIF search). Settings, rules, links, snapshots, the Azure PAT and the GIPHY key live in `chrome.storage.local` (not encrypted, use **Forget PAT** on shared machines). Screenshots and recordings stay in IndexedDB until you delete them.

Permissions: all-sites access (screenshots via `captureVisibleTab`, the page hook, rules), `declarativeNetRequest` (+Feedback for hit counts), `scripting` (CSS injection, cyclers), `cookies`, `userScripts` (JS rules), `storage`/`unlimitedStorage`.

## Layout

```
manifest.json, background.js     service worker: screenshots, recorder, rules (DNR/CSS/JS), cookies, shortcuts
content/page-hook.js             page world: console, actions, storage log + locks, fetch/XHR mocks
content/bridge.js                passes rules and locks to the page hook
panel/                           DevTools panel (modules/* per tab, lib/* shared logic)
tools/                           standalone tools page (.npmrc editor that can save files)
popup/, recorder/                toolbar popup (links), screen recorder window
```

## Record & replay notes

- A session covers one page load; a full navigation ends the recording (SPA route changes are fine).
- Not covered: WebSockets, Web Workers, server-side state, synchronous XHR, and password/secret fields (not recorded; the restored storage/cookies usually keep you logged in).
- Exports follow **Mask secrets**: tokens in storage and auth cookies are redacted. If an app checks tokens locally, export with Mask secrets off and share only with your team.
- "Offline" replay blocks requests that weren't recorded; otherwise they go to the network.

## Known limits

- Screenshots capture the visible viewport.
- Response bodies exist only for requests made while DevTools is open.
- Azure attachments over 60 MB are blocked.
- Not yet: Jira/GitHub/Linear/Slack, AI summaries, hosted share links (planned).
