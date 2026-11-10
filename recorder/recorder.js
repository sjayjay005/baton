import { applyStoredTheme } from '../panel/lib/theme.js';
applyStoredTheme();
import { addMedia, channel, stamp, fmtDuration } from '../panel/lib/media.js';

const MAX_MS = 10 * 60 * 1000;
const $ = (id) => document.getElementById(id);
const show = (id) => ['setup', 'live', 'done'].forEach((s) => ($(s).hidden = s !== id));

let recorder = null;
let streams = [];
let audioCtx = null;
let startedAt = 0;
let tick = null;
let chunks = [];
let label = '';

function pickMime() {
  const options = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return options.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function broadcast(state) {
  channel.postMessage({ type: 'recording', state, elapsed: startedAt ? Date.now() - startedAt : 0 });
}

async function start() {
  $('error').textContent = '';
  try {
    const wantTabAudio = $('tabAudio').checked;
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: { ideal: 30, max: 30 } },
      audio: wantTabAudio,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
    });
    streams.push(display);
    const tracks = [...display.getVideoTracks()];
    const audioSources = display.getAudioTracks().length ? [display] : [];

    if ($('mic').checked) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        streams.push(mic);
        audioSources.push(mic);
      } catch {
        $('error').textContent = 'Microphone blocked, recording without narration.';
      }
    }
    if (audioSources.length === 1) tracks.push(...audioSources[0].getAudioTracks());
    if (audioSources.length > 1) {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      audioSources.forEach((s) => audioCtx.createMediaStreamSource(s).connect(dest));
      tracks.push(...dest.stream.getAudioTracks());
    }

    const settings = display.getVideoTracks()[0].getSettings();
    label = display.getVideoTracks()[0].label || 'tab';
    const mimeType = pickMime();
    recorder = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond: 2_500_000 });
    chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = save;
    display.getVideoTracks()[0].addEventListener('ended', stop); // Chrome's "Stop sharing"
    recorder.start(1000);
    startedAt = Date.now();
    const surface = { browser: 'tab', window: 'window', monitor: 'screen' }[settings.displaySurface] || 'tab';
    $('what').textContent = `Recording the selected ${surface}${settings.width ? ` · ${settings.width}×${settings.height}` : ''}`;
    show('live');
    tick = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      $('timer').textContent = fmtDuration(elapsed);
      document.title = `● ${fmtDuration(elapsed)} Baton`;
      broadcast('recording');
      if (elapsed >= MAX_MS) stop();
    }, 500);
    broadcast('recording');
    // Get out of the way while the QA does their thing.
    chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { state: 'minimized' })).catch(() => {});
  } catch (err) {
    cleanup();
    $('error').textContent = err && err.name === 'NotAllowedError' ? 'Recording was cancelled.' : `Couldn't start recording: ${err.message}`;
    show('setup');
  }
}

function stop() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

function cleanup() {
  clearInterval(tick);
  streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  streams = [];
  if (audioCtx) audioCtx.close();
  audioCtx = null;
}

async function save() {
  const duration = Date.now() - startedAt;
  cleanup();
  const mime = (recorder.mimeType || 'video/webm').split(';')[0];
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type: mime });
  const name = `recording-${stamp()}.${ext}`;
  const rec = await addMedia({ kind: 'recording', name, mime, blob, size: blob.size, duration, startedAt });
  channel.postMessage({ type: 'recording', state: 'saved', id: rec.id, startedAt, endedAt: startedAt + duration });
  $('saved').textContent = `${name} · ${fmtDuration(duration)}`;
  show('done');
  chrome.windows.getCurrent().then((w) => chrome.windows.update(w.id, { state: 'normal', focused: true })).catch(() => {});
  setTimeout(() => window.close(), 2500);
}

$('start').addEventListener('click', start);
$('stop').addEventListener('click', stop);
channel.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'stop-recording') stop();
});
window.addEventListener('beforeunload', () => {
  if (recorder && recorder.state === 'recording') broadcast('cancelled');
});
