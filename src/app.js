// Video Alice — a tiny browser-only editor for short clips and screenshots.
// This file is the wiring: it holds the pieces together and owns the frame loop.

import { STEPS_PER_SECOND, createClip } from './clip.js';
import { createDoodles } from './doodles.js';
import { createExporter } from './exporter.js';
import { createStage } from './stage.js';
import { createTextEntry } from './textentry.js';
import { createTimeline } from './timeline.js';
import { createToolbar } from './toolbar.js';

const $ = (id) => document.getElementById(id);

const editorScreen = $('editorScreen');
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const canvas = $('canvas');
const stageEl = $('stage');
const playBtn = $('playBtn');
const stopBtn = $('stopBtn');
const newBtn = $('newBtn');
const undoBtn = $('undoBtn');
const clearBtn = $('clearBtn');
const eraserBtn = $('eraserBtn');
const downloadBtn = $('downloadBtn');
const exportOverlay = $('exportOverlay');
const exportLabel = $('exportLabel');
const progressBar = $('progressBar');

const stepBtns = {
  backSec: $('backSecBtn'), fwdSec: $('fwdSecBtn'),
  backStep: $('backStepBtn'), fwdStep: $('fwdStepBtn'),
};

// ---------- The pieces ----------
const doodles = createDoodles({ onChange: () => timeline.refresh() });

const clip = createClip({
  video: $('video'),
  onReady: () => {
    view.fit(clip.width, clip.height);
    doodles.reset(view.width, view.height);
    stageEl.style.aspectRatio = `${clip.width} / ${clip.height}`;
    editorScreen.classList.remove('empty');
    editorScreen.classList.toggle('still', clip.mode === 'image');
    newBtn.classList.remove('hidden');
    downloadBtn.textContent = clip.mode === 'image' ? 'Download picture' : 'Download video';
    setDisabled(false);
  },
  // The grid is settled — either from the file's header or, for a recorded
  // file, once its real length has been read out of it — so saved drawings
  // have somewhere to land.
  onDuration: () => {
    if (clip.loaded) doodles.restore(clip.lastStep);
    timeline.invalidate();
    timeline.refresh();
  },
  onStep: () => text.commit(),   // a text belongs to the moment it was typed at
  onPlaying: (playing) => {
    playBtn.textContent = playing ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  },
  onError: (message) => { alert(message); reset(); },
});

const text = createTextEntry({
  element: $('textEditor'),
  canvas,
  onCommit: (item, layer) => view.finishText(item, layer),
});

const toolbar = createToolbar({
  tools: $('tools'),
  swatches: $('swatches'),
  sizes: $('sizes'),
  eraser: eraserBtn,
  onToolChange: (kind) => {
    text.commit();
    editorScreen.classList.toggle('typing', kind === 'text');
  },
});

const view = createStage({ canvas, clip, doodles, toolbar, text });

const timeline = createTimeline({
  els: {
    track: $('timeline'),
    trimRegion: $('trimRegion'),
    stepSlot: $('stepSlot'),
    keyframes: $('keyframes'),
    playhead: $('playhead'),
    handleStart: $('handleStart'),
    handleEnd: $('handleEnd'),
    timeLabel: $('timeLabel'),
    prevDraw: $('prevDrawBtn'),
    nextDraw: $('nextDrawBtn'),
  },
  clip,
  doodles,
});

const exporter = createExporter({
  clip,
  doodles,
  progress: (fraction) => { progressBar.style.width = `${fraction * 100}%`; },
  onStart: (how) => {
    clip.setBusy(true);
    setDisabled(true);
    exportOverlay.classList.remove('hidden');
    exportLabel.textContent = how === 'recording'
      ? 'Making your video… (recording)'
      : 'Making your video…';
    progressBar.style.width = '0%';
  },
  onFinish: () => {
    clip.setBusy(false);
    setDisabled(false);
    exportOverlay.classList.add('hidden');
  },
});

// ---------- Opening a file ----------
function open(file) {
  text.commit();
  clip.load(file);
}

$('pickBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) open(fileInput.files[0]);
});

const openable = (file) => !!file && (file.type.startsWith('video/') || file.type.startsWith('image/'));

['dragenter', 'dragover'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
dropZone.addEventListener('drop', (e) => {
  if (openable(e.dataTransfer.files[0])) open(e.dataTransfer.files[0]);
});

// Paste works throughout, not only from the empty state: a screenshot is
// something you take and paste rather than find on disk and drag.
window.addEventListener('paste', (e) => {
  if (exporter.running || e.target.closest?.('input, textarea')) return;
  const data = e.clipboardData;
  if (!data) return;
  // Browsers disagree about which of the two lists a pasted file shows up in.
  const files = [...(data.files || [])];
  for (const entry of data.items || []) {
    if (entry.kind !== 'file') continue;
    const file = entry.getAsFile();
    if (file) files.push(file);
  }
  const file = files.find(openable);
  if (!file) return;
  e.preventDefault();
  open(file);
});

newBtn.addEventListener('click', reset);
function reset() {
  text.commit();
  clip.close();
  doodles.reset(view.width, view.height);
  fileInput.value = '';
  // The inline ratio outranks the empty-state rule, so the drop zone would keep
  // the shape of the file that just left.
  stageEl.style.aspectRatio = '';
  editorScreen.classList.add('empty');
  editorScreen.classList.remove('still');
  newBtn.classList.add('hidden');
  downloadBtn.textContent = 'Download video';
  setDisabled(true);
}

// ---------- Buttons and keys ----------
playBtn.addEventListener('click', () => clip.toggle());
stopBtn.addEventListener('click', () => clip.stop());
stepBtns.backSec.addEventListener('click', () => clip.skip(-STEPS_PER_SECOND));
stepBtns.fwdSec.addEventListener('click', () => clip.skip(STEPS_PER_SECOND));
stepBtns.backStep.addEventListener('click', () => clip.skip(-1));
stepBtns.fwdStep.addEventListener('click', () => clip.skip(1));

undoBtn.addEventListener('click', () => { text.commit(); doodles.undo(clip.step); });
clearBtn.addEventListener('click', () => { text.commit(); doodles.clear(clip.step); });
downloadBtn.addEventListener('click', () => { text.commit(); exporter.run(); });

window.addEventListener('keydown', (e) => {
  if (editorScreen.classList.contains('empty') || exporter.running) return;
  // While typing, every key is a key: space is a space, the arrows move the
  // caret, and undo is the field's own.
  if (e.target.closest?.('input, textarea')) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoBtn.click(); }
  if (clip.mode !== 'video') return;
  // Space on a focused button is that button's own shortcut, or clicking Play
  // and then pressing Space toggles playback twice.
  if (e.code === 'Space' && !e.target.closest?.('button')) { e.preventDefault(); clip.toggle(); }
  if (e.code === 'ArrowLeft') { e.preventDefault(); clip.skip(e.shiftKey ? -1 : -STEPS_PER_SECOND); }
  if (e.code === 'ArrowRight') { e.preventDefault(); clip.skip(e.shiftKey ? 1 : STEPS_PER_SECOND); }
});

window.addEventListener('pagehide', () => doodles.flush());

function setDisabled(disabled) {
  [playBtn, stopBtn, ...Object.values(stepBtns), undoBtn, clearBtn, eraserBtn, downloadBtn, newBtn]
    .forEach((b) => { b.disabled = disabled; });
  timeline.setDisabled(disabled);
  view.setEnabled(!disabled);
}

// ---------- The frame loop ----------
function frame() {
  requestAnimationFrame(frame);   // first, so a throw can't kill the preview
  if (exporter.running || !clip.loaded) return;
  clip.tick();
  view.render();
  timeline.update();
}
requestAnimationFrame(frame);

// The tools start visible but inert, waiting for a file.
setDisabled(true);
