// Video Alice — a tiny browser-only video doodle + trim editor.
// Everything runs locally. The preview composites the video frame + the active
// doodle layer onto a canvas; the export re-runs that exact compositing over
// decoded frames via mediabunny, so what you see is what you download.
//
// Two ideas hold the rest together:
//   - Time is a grid of TIME_STEPs. The playhead only stops on it and doodles
//     belong to it, so "same moment?" is a comparison of whole numbers.
//   - A doodle is its strokes. Layer canvases are caches, rebuilt by replaying
//     them — which is how undo, the saved drawings and the full-resolution
//     export all work without a pixel buffer per keyframe.

import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny';

// ---------- Element refs ----------
const $ = (id) => document.getElementById(id);

const editorScreen = $('editorScreen');
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const pickBtn = $('pickBtn');
const newBtn = $('newBtn');

const video = $('video');
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const stage = $('stage');

const timeline = $('timeline');
const trimRegion = $('trimRegion');
const keyframesEl = $('keyframes');
const playhead = $('playhead');
const stepSlot = $('stepSlot');
const handleStart = $('handleStart');
const handleEnd = $('handleEnd');
const timeLabel = $('timeLabel');

const playBtn = $('playBtn');
const stopBtn = $('stopBtn');
const backSecBtn = $('backSecBtn');
const fwdSecBtn = $('fwdSecBtn');
const backStepBtn = $('backStepBtn');
const fwdStepBtn = $('fwdStepBtn');
const prevDrawBtn = $('prevDrawBtn');
const nextDrawBtn = $('nextDrawBtn');
const swatchesEl = $('swatches');
const sizesEl = $('sizes');
const eraserBtn = $('eraserBtn');
const undoBtn = $('undoBtn');
const clearBtn = $('clearBtn');
const downloadBtn = $('downloadBtn');

const exportOverlay = $('exportOverlay');
const exportLabel = $('exportLabel');
const progressBar = $('progressBar');

// ---------- Constants ----------
const COLORS = [
  '#e23b3b', '#f5a623', '#f7d038', '#3ba55d', '#2f6df6', '#8b5cf6',
  '#8b5e34', '#9aa1ab', '#111111', '#ffffff',
];
// The playhead only ever stops on a tenth of a second. Buttons move by whole
// steps, a click on the timeline goes to the nearest one, and a doodle belongs
// to a step rather than to a video frame — so "am I on the same moment as that
// drawing?" is an integer comparison and can't come out a millisecond wrong.
// Playback and the exported file are untouched: those stay as smooth as the
// source. Change this one number to make the grid coarser.
const TIME_STEP = 0.1;
const STEP_JUMP = Math.round(1 / TIME_STEP); // the double-chevron: one second

const MIN_TRIM = 0.2;      // keep at least this much between trim handles

// The preview canvas is never drawn wider than the 820px page — call it 1600
// device pixels on a retina screen — so a 4K frame is four fifths wasted. Every
// doodle layer is allocated at this size too, and those are what add up: one
// full-size layer per keyframe is 33 MB at 4K, 3 MB here. The export doesn't
// suffer for it, because it re-renders the strokes at the source's resolution.
const PREVIEW_MAX = 1600;

// Codec preference order, best-looking first. Filtered per output format.
const VIDEO_CODECS = ['avc', 'vp9', 'av1', 'vp8'];
const AUDIO_CODECS = ['aac', 'opus'];

// ---------- State ----------
const state = {
  file: null,   // the original File — mediabunny decodes from this, not the <video>
  source: { width: 0, height: 0 }, // the video's own size; the export goes out at this
  step: 0,      // where the playhead is, in TIME_STEPs — see seek()
  lastStep: 0,  // the last step that still lands inside the video
  duration: 0,
  trimStart: 0,
  trimEnd: 0,
  layers: [],   // { step, canvas, ctx, strokes:[{color,size,eraser,points:[{x,y}]}] }
  tool: { color: COLORS[0], size: 14, eraser: false },
  drawing: null, // { layer, stroke }
  panning: false, // two or more fingers on the canvas: scrolling, not drawing
  exporting: false,
  audioTap: null, // WebAudio tap on the <video>, built once for recorder exports
};

// ---------- Helpers ----------
// Tenths, because that's the grid — showing hundredths would suggest a precision
// the playhead doesn't have.
function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  // Round before splitting, or 59.99s formats as 0:60.0.
  const tenths = Math.round(t * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------- Where the playhead is ----------
// state.step is the app's own answer to that, and everything reads it: which
// doodle is on screen, which one a new stroke joins, the marker, the readout.
//
// The <video> can't be that answer. Ask it mid-seek and it reports the position
// you asked for; once the seek lands it reports the frame it actually decoded,
// which can be a few tens of milliseconds earlier. Two doodles a few
// milliseconds apart, one of them invisible, followed from that. Steps are whole
// numbers, so there is no "a few milliseconds apart" to get wrong.
const timeOf = (step) => step * TIME_STEP;
// Going to a moment: the nearest step, so a click lands where it looks like it did.
const stepAt = (t) => clamp(Math.round(t / TIME_STEP), 0, state.lastStep);
// Watching time pass: the step it has reached, so a doodle comes up when playback
// arrives at it rather than half a step early.
const stepReached = (t) => clamp(Math.floor(t / TIME_STEP), 0, state.lastStep);

function seek(step) {
  state.step = clamp(Math.round(step), 0, state.lastStep);
  video.currentTime = timeOf(state.step);
}

// The icon follows the element rather than every caller remembering to set it,
// so it can't disagree with what the video is doing — including when the clip
// runs out on its own.
video.addEventListener('play', () => setPlayIcon(true));
video.addEventListener('pause', () => {
  setPlayIcon(false);
  // Playback stops wherever it happens to be, which is usually between two
  // steps. Snap onto the grid so the picture, the marker and the doodle agree.
  if (!state.exporting) seek(state.step);
});

// ---------- Upload ----------
pickBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});

['dragenter', 'dragover'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); })
);
['dragleave', 'drop'].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); })
);
dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('video/')) loadFile(file);
});

function loadFile(file) {
  state.file = file;
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  video.load();
}

video.addEventListener('loadedmetadata', setupVideo);

function setupVideo() {
  state.trimStart = 0;
  state.layers = [];
  // A file whose header has no duration reads as Infinity. Leave the timeline
  // empty rather than compute percentages of infinity, and go find the real
  // length in the background.
  setDuration(isFinite(video.duration) ? video.duration : 0);
  if (!isFinite(video.duration)) repairDuration(state.file);

  state.source = { width: video.videoWidth, height: video.videoHeight };
  const shrink = Math.min(1, PREVIEW_MAX / Math.max(1, video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * shrink));
  canvas.height = Math.max(1, Math.round(video.videoHeight * shrink));
  frame.width = canvas.width;   // also clears the previous video's last frame
  frame.height = canvas.height;
  stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;

  editorScreen.classList.remove('empty');
  newBtn.classList.remove('hidden');
  setUIDisabled(false);

  // The canvas has its size now and the grid its length, so the saved strokes
  // have somewhere to land. When the duration needed repairing there's no grid
  // yet, and repairDuration does this instead.
  if (state.duration) restoreDrawings();

  seek(0);
  shownStep = -1;
  renderKeyframes();
}

function setDuration(seconds) {
  state.duration = seconds;
  state.trimEnd = seconds;
  // Floor, so the last step is a moment the video actually has.
  state.lastStep = Math.max(0, Math.floor(seconds / TIME_STEP));
  shownTime = -1; // the grid just changed scale, so redraw the marker and the slot
  renderTimeline();
  renderStepSlot();
}

// Anything MediaRecorder produced — including this app's own fallback export —
// leaves the duration out of the header, so the DOM reports Infinity forever.
// mediabunny gets it by reading the file we already have in hand.
async function repairDuration(file) {
  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const seconds = await input.computeDuration();
    if (state.file !== file) return; // a different video arrived while we read
    if (!isFinite(seconds) || seconds <= 0) throw new Error('no duration in the file');
    setDuration(seconds);
    restoreDrawings(); // setupVideo had no grid to place them on yet
    renderKeyframes();
  } catch (err) {
    if (state.file !== file) return;
    console.error('Could not work out how long the video is:', err);
    alert('Sorry, this video can’t be edited — its length is missing from the file.');
    resetApp();
  }
}

newBtn.addEventListener('click', resetApp);
function resetApp() {
  video.pause();
  if (video.src) URL.revokeObjectURL(video.src);
  video.removeAttribute('src');
  video.load();
  state.layers = [];
  state.file = null;
  state.source = { width: 0, height: 0 };
  state.step = 0;
  state.trimStart = 0;
  setDuration(0);
  fileInput.value = '';
  // The inline ratio outranks the empty-state rule, so the drop zone would
  // otherwise keep the shape of the video that just left.
  stage.style.aspectRatio = '';
  renderKeyframes();
  editorScreen.classList.add('empty');
  newBtn.classList.add('hidden');
  setUIDisabled(true);
}

// ---------- Layers (doodle keyframes) ----------
// A doodle belongs to a step, not to a video frame. Nothing here needs to know
// what the video's frame rate is, or which frame the decoder happened to land
// on — two doodles are either on the same step or they aren't.
//
// A layer replaces the one before it rather than adding to it: what you see at a
// step is exactly one layer, the newest one at or before it. So a fresh keyframe
// starts blank, and drawing anything clears whatever an earlier keyframe was
// still showing there. That's the intended feel — a doodle lasts until the next
// one, and starting a new one is how you make the old one go. Reworking an
// existing doodle means going back to its own dot (the jump buttons are there
// for that) rather than drawing a step later.
function blankLayer(step) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  return { step, canvas: c, ctx: c.getContext('2d'), strokes: [] };
}

function createLayer(step) {
  const layer = blankLayer(step);
  state.layers.push(layer);
  state.layers.sort((a, b) => a.step - b.step);
  renderKeyframes();
  return layer;
}

function removeLayer(layer) {
  const i = state.layers.indexOf(layer);
  if (i >= 0) state.layers.splice(i, 1);
  renderKeyframes();
}

// Layer shown at a step = the newest keyframe at or before it.
function activeLayerAt(step) {
  let best = null;
  for (const l of state.layers) {
    if (l.step <= step && (!best || l.step > best.step)) best = l;
  }
  return best;
}

// The layer a new stroke joins: the one on this exact step, or a new one.
function layerForDrawing() {
  return state.layers.find((l) => l.step === state.step) || createLayer(state.step);
}

// ---------- Stroke drawing ----------
function applyStrokeStyle(context, stroke) {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = stroke.size;
  if (stroke.eraser) {
    context.globalCompositeOperation = 'destination-out';
    context.strokeStyle = 'rgba(0,0,0,1)';
    context.fillStyle = 'rgba(0,0,0,1)';
  } else {
    context.globalCompositeOperation = 'source-over';
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
  }
}

function drawDot(context, stroke, pt) {
  applyStrokeStyle(context, stroke);
  context.beginPath();
  context.arc(pt.x, pt.y, stroke.size / 2, 0, Math.PI * 2);
  context.fill();
  context.globalCompositeOperation = 'source-over';
}

function drawSegment(context, stroke, a, b) {
  applyStrokeStyle(context, stroke);
  context.beginPath();
  context.moveTo(a.x, a.y);
  context.lineTo(b.x, b.y);
  context.stroke();
  context.globalCompositeOperation = 'source-over';
}

function replayStroke(context, stroke) {
  if (stroke.points.length === 1) {
    drawDot(context, stroke, stroke.points[0]);
    return;
  }
  for (let i = 1; i < stroke.points.length; i++) {
    drawSegment(context, stroke, stroke.points[i - 1], stroke.points[i]);
  }
}

function redrawLayer(layer) {
  layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  for (const s of layer.strokes) replayStroke(layer.ctx, s);
}

// ---------- Keeping the drawings between visits ----------
// Only the strokes are stored: they *are* the drawing, and they're small. The
// layer canvases get rebuilt from them, the same way undo already does it.
//
// Steps are absolute, so they survive a change of video on their own, but
// coordinates belong to the preview canvas — its size goes along with them and
// the strokes are rescaled if the next video is a different shape. There's no
// check that it's even the same video: reopen the app, load something else and
// last night's doodles come back, which is the point of keeping them at all.
const STORE_PREFIX = 'videoAlice:';
const STORE_DRAWINGS = `${STORE_PREFIX}drawings`;

function saveDrawings() {
  const tenth = (n) => Math.round(n * 10) / 10; // full float precision doubles the JSON
  try {
    localStorage.setItem(STORE_DRAWINGS, JSON.stringify({
      width: canvas.width,
      height: canvas.height,
      layers: state.layers.map((l) => ({
        step: l.step,
        strokes: l.strokes.map((s) => ({
          color: s.color,
          size: s.size,
          eraser: s.eraser,
          points: s.points.map((p) => [tenth(p.x), tenth(p.y)]),
        })),
      })),
    }));
  } catch (err) {
    // Out of quota, or a browser that won't store anything in private mode. The
    // drawings on screen are unaffected, so this is worth no more than a note.
    console.warn('Could not save the drawings:', err);
  }
}

// Coalesced: a stroke ends, undo, clear — none of them need to hit the disk the
// instant they happen, and a burst of them shouldn't serialise everything twice.
let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDrawings, 400);
}
window.addEventListener('pagehide', () => {
  clearTimeout(saveTimer);
  saveDrawings(); // leaving within the coalescing window shouldn't lose the last stroke
});

// Called once the duration is known: a doodle past the end of this video has
// nowhere to sit on the timeline.
function restoreDrawings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_DRAWINGS) || 'null');
  } catch (err) {
    console.warn('Could not read the saved drawings:', err);
  }
  if (!saved?.layers?.length || !saved.width || !saved.height) return;

  const sx = canvas.width / saved.width;
  const sy = canvas.height / saved.height;
  for (const l of saved.layers) {
    if (l.step > state.lastStep) continue; // past the end of *this* video
    const layer = blankLayer(l.step);
    layer.strokes = l.strokes.map((s) => ({
      color: s.color,
      eraser: s.eraser,
      size: s.size * sx, // the brush was that thick relative to the picture
      points: s.points.map(([x, y]) => ({ x: x * sx, y: y * sy })),
    }));
    redrawLayer(layer);
    state.layers.push(layer);
  }
  state.layers.sort((a, b) => a.step - b.step);
  // The caller renders the timeline once we're done, rather than once per layer.
}

// Layers are rasterised at preview size, but the export goes out at the video's
// own resolution. Strokes are geometry, so replaying them into a bigger canvas
// costs nothing in quality — upscaling layer.canvas would have cost edges.
//
// Returns a function that hands back that canvas for a given layer. Frames are
// encoded in timestamp order, so only one layer is ever live: keep a single
// buffer and re-render it when the doodle changes, instead of holding a
// full-size copy of every keyframe at once.
function layerRasterizer(width, height) {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const context = out.getContext('2d');
  let current = null;

  return (layer) => {
    if (!layer) return null;
    if (layer !== current) {
      current = layer;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      // Scaling the pen along with the points keeps every line the same
      // thickness relative to the picture as it was on screen.
      context.setTransform(width / layer.canvas.width, 0, 0, height / layer.canvas.height, 0, 0);
      for (const s of layer.strokes) replayStroke(context, s);
    }
    return out;
  };
}

// ---------- Pointer drawing on the canvas ----------
function toCanvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width),
    y: (e.clientY - r.top) * (canvas.height / r.height),
  };
}

// One finger draws; two or more scroll the page. The browser can't split a
// gesture by finger count — touch-action is all-or-nothing per element — so the
// canvas keeps touch-action: none and we move the page ourselves.
const pointers = new Map(); // pointerId -> last client position

function centroid() {
  let x = 0;
  let y = 0;
  for (const p of pointers.values()) { x += p.x; y += p.y; }
  return { x: x / pointers.size, y: y / pointers.size };
}

// The page is moved to a remembered anchor rather than nudged along by each
// event. Nudging looked right and wasn't: two fingers means the browser sends
// one pointermove *per finger*, so every frame applied two deltas computed from
// a centroid where only one finger had moved, and any event it coalesced or
// dropped left the page permanently offset from the hands holding it. Anchored,
// the page is wherever the fingers say it is, however the events arrive.
let panFrom = null;   // centroid when the pan was anchored
let panScroll = null; // where the page was at that moment
let panQueued = false;

function anchorPan() {
  panFrom = centroid();
  panScroll = { x: window.scrollX, y: window.scrollY };
}

// Once per frame, not once per event — two fingers otherwise scroll the page
// twice as often as it can paint.
function panSoon() {
  if (panQueued) return;
  panQueued = true;
  requestAnimationFrame(panToFingers);
}

function panToFingers() {
  panQueued = false;
  if (!panFrom || pointers.size < 2) return;

  const now = centroid();
  const wantX = panScroll.x + (panFrom.x - now.x);
  const wantY = panScroll.y + (panFrom.y - now.y);
  const maxX = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
  const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo(clamp(wantX, 0, maxX), clamp(wantY, 0, maxY));

  // Past an edge there's nowhere to go, so drop a fresh anchor: otherwise all
  // that travel is remembered and pulling back the other way does nothing until
  // you've retraced it.
  if (wantX < 0 || wantX > maxX || wantY < 0 || wantY > maxY) anchorPan();
}

// Take back the stroke the first finger already started, so a two-finger
// scroll never leaves a stray mark behind.
function abortStroke() {
  if (!state.drawing) return;
  const { layer, stroke } = state.drawing;
  const i = layer.strokes.indexOf(stroke);
  if (i >= 0) layer.strokes.splice(i, 1);
  redrawLayer(layer);
  if (!layer.strokes.length) removeLayer(layer);
  state.drawing = null;
  saveSoon();
}

canvas.addEventListener('pointerdown', (e) => {
  if (state.exporting) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size > 1) {
    abortStroke();
    state.panning = true;
    anchorPan();
    return;
  }
  // A finger left over from a scroll must not start drawing.
  if (state.panning) return;

  video.pause();
  canvas.setPointerCapture(e.pointerId);

  const layer = layerForDrawing();
  const pt = toCanvasPoint(e);
  const stroke = {
    color: state.tool.color,
    size: state.tool.size,
    eraser: state.tool.eraser,
    points: [pt],
  };
  layer.strokes.push(stroke);
  state.drawing = { layer, stroke };
  drawDot(layer.ctx, stroke, pt);
});

canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  if (state.panning) {
    panSoon();
    return;
  }

  if (!state.drawing) return;
  const { layer, stroke } = state.drawing;
  const pt = toCanvasPoint(e);
  const prev = stroke.points[stroke.points.length - 1];
  stroke.points.push(pt);
  drawSegment(layer.ctx, stroke, prev, pt);
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    // Only stop panning once every finger is off, so lifting one of two doesn't
    // hand the gesture back to the brush mid-scroll.
    state.panning = false;
    panFrom = null;
  } else if (state.panning) {
    anchorPan(); // the centroid just moved with the finger count, not with the hand
  }
  if (state.drawing) saveSoon(); // a stroke just finished
  state.drawing = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// ---------- Undo / Clear ----------
undoBtn.addEventListener('click', () => {
  const layer = activeLayerAt(state.step);
  if (!layer || !layer.strokes.length) return;
  layer.strokes.pop();
  redrawLayer(layer);
  if (!layer.strokes.length) removeLayer(layer);
  saveSoon();
});

clearBtn.addEventListener('click', () => {
  const layer = activeLayerAt(state.step);
  if (!layer) return;
  removeLayer(layer);
  saveSoon();
});

// ---------- Toolbar ----------
COLORS.forEach((color, i) => {
  const b = document.createElement('button');
  b.className = 'swatch' + (i === 0 ? ' active' : '');
  b.style.background = color;
  b.dataset.color = color;
  b.addEventListener('click', () => {
    state.tool.color = color;
    state.tool.eraser = false;
    eraserBtn.classList.remove('active');
    swatchesEl.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s === b));
  });
  swatchesEl.appendChild(b);
});

sizesEl.querySelectorAll('.size-btn').forEach((b) => {
  b.addEventListener('click', () => {
    state.tool.size = Number(b.dataset.size);
    sizesEl.querySelectorAll('.size-btn').forEach((s) => s.classList.toggle('active', s === b));
  });
});

eraserBtn.addEventListener('click', () => {
  state.tool.eraser = !state.tool.eraser;
  eraserBtn.classList.toggle('active', state.tool.eraser);
});

// ---------- Playback ----------
playBtn.addEventListener('click', togglePlay);
function togglePlay() {
  if (state.exporting) return;
  if (video.paused) {
    const now = timeOf(state.step);
    if (now < state.trimStart || now >= state.trimEnd - TIME_STEP / 2) {
      seek(stepAt(state.trimStart));
    }
    video.play();
  } else {
    video.pause();
  }
}
// Stop = back to the start of the trimmed clip, ready to play again.
stopBtn.addEventListener('click', () => {
  if (state.exporting) return;
  video.pause();
  seek(stepAt(state.trimStart));
});

backSecBtn.addEventListener('click', () => skip(-STEP_JUMP));
fwdSecBtn.addEventListener('click', () => skip(STEP_JUMP));
backStepBtn.addEventListener('click', () => skip(-1));
fwdStepBtn.addEventListener('click', () => skip(1));

// Hop between the moments that carry a doodle — the orange dots on the timeline.
prevDrawBtn.addEventListener('click', () => jumpToDrawing(-1));
nextDrawBtn.addEventListener('click', () => jumpToDrawing(1));

// state.layers is kept in step order, so the next doodle either way is just the
// neighbour — no epsilons needed to avoid landing back on the one we left.
function jumpToDrawing(direction) {
  if (state.exporting) return;
  const target = direction < 0
    ? state.layers.filter((l) => l.step < state.step).pop()
    : state.layers.find((l) => l.step > state.step);
  if (!target) return;
  video.pause();
  seek(target.step);
}

// Nothing to jump to until there are doodles either side of the playhead.
function updateDrawNav() {
  if (state.exporting) return;
  prevDrawBtn.disabled = !state.layers.some((l) => l.step < state.step);
  nextDrawBtn.disabled = !state.layers.some((l) => l.step > state.step);
}

// Stepping is for lining up a doodle, so it pauses first — otherwise playback
// runs straight past the moment you were aiming for. It ranges over the whole
// clip: you may want to draw just outside the trim, or check what you cut.
function skip(steps) {
  if (state.exporting) return;
  video.pause();
  seek(state.step + steps);
}

function setPlayIcon(playing) {
  playBtn.textContent = playing ? '❚❚' : '▶';
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

// ---------- Render loop ----------
// The last decoded video frame, kept apart from the doodle so the two can be
// recomposited at any moment. Preview-sized, like the layers.
const frame = document.createElement('canvas');
const frameCtx = frame.getContext('2d');

function renderLoop() {
  requestAnimationFrame(renderLoop); // first, so a throw can't kill the preview

  // Nothing to paint before a video arrives, and during an export the overlay
  // covers the stage while both export paths composite onto a canvas of their own.
  if (state.exporting || !state.source.width) return;

  // While playing, the element is the one moving, so follow it. Every other way
  // of getting somewhere goes through seek().
  if (!video.paused) state.step = stepReached(video.currentTime);

  // The <video> refuses to draw while a seek is still fetching its frame. Keep
  // the last frame that did arrive in a buffer of its own and composite from
  // that, so a stroke drawn mid-seek still shows up instead of the stage sitting
  // on a stale picture until playback repaints it.
  if (video.readyState >= 2) {
    frameCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height); // the buffer is empty until the first frame
  ctx.drawImage(frame, 0, 0);
  const layer = activeLayerAt(state.step);
  if (layer) ctx.drawImage(layer.canvas, 0, 0);

  // Stop preview playback at the trim end. Straight off the element: the trim
  // handles aren't on the grid, so this is a question about real time.
  if (!video.paused && video.currentTime >= state.trimEnd - 1e-3) {
    video.pause(); // the pause handler puts us back on the grid
  }

  updatePlayhead();
}
requestAnimationFrame(renderLoop);

// Called every frame, so skip the DOM writes while nothing moves — which is most
// of the time in an editor like this. The marker follows the video itself during
// playback, so that stays as smooth as the picture; the moment it stops, it's
// back on the grid.
let shownStep = -1;
let shownTime = -1;
function updatePlayhead() {
  if (!state.duration) return;
  const t = video.paused ? timeOf(state.step) : video.currentTime;
  if (t === shownTime && state.step === shownStep) return;
  shownTime = t;
  playhead.style.left = `${(t / state.duration) * 100}%`;
  timeLabel.textContent = fmtTime(t);

  if (state.step !== shownStep) {
    shownStep = state.step;
    renderStepSlot();
    updateDrawNav();
  }
}

// The band the playhead is standing in — one step wide, so it's clear which
// moment a stroke would belong to. The dot of a doodle already on this step
// lights up with it.
function renderStepSlot() {
  const d = state.duration || 1;
  stepSlot.style.left = `${((timeOf(state.step) - TIME_STEP / 2) / d) * 100}%`;
  stepSlot.style.width = `${(TIME_STEP / d) * 100}%`;
  for (const dot of keyframeDots) {
    dot.el.classList.toggle('current', dot.step === state.step);
  }
}

// ---------- Timeline ----------
function renderTimeline() {
  const d = state.duration || 1;
  const startPct = (state.trimStart / d) * 100;
  const endPct = (state.trimEnd / d) * 100;
  trimRegion.style.left = `${startPct}%`;
  trimRegion.style.width = `${endPct - startPct}%`;
  handleStart.style.left = `${startPct}%`;
  handleEnd.style.left = `${endPct}%`;
}

let keyframeDots = [];
function renderKeyframes() {
  const d = state.duration || 1;
  keyframesEl.innerHTML = '';
  keyframeDots = state.layers.map((l) => {
    const el = document.createElement('div');
    el.className = 'keyframe-dot';
    el.style.left = `${(timeOf(l.step) / d) * 100}%`;
    keyframesEl.appendChild(el);
    return { step: l.step, el };
  });
  renderStepSlot();
  updateDrawNav(); // the dots and the jump buttons describe the same set
}

function timeFromEvent(e) {
  const r = timeline.getBoundingClientRect();
  const x = clamp(e.clientX - r.left, 0, r.width);
  return (x / r.width) * state.duration;
}

// Drag trim handles and scrub by clicking the track.
let dragTarget = null;
function startDrag(target) {
  return (e) => {
    if (state.exporting) return;
    e.preventDefault();
    dragTarget = target;
    timeline.setPointerCapture(e.pointerId);
    handleDrag(e);
  };
}
handleStart.addEventListener('pointerdown', startDrag('start'));
handleEnd.addEventListener('pointerdown', startDrag('end'));
timeline.addEventListener('pointerdown', (e) => {
  if (state.exporting || dragTarget) return;
  if (e.target === handleStart || e.target === handleEnd) return;
  dragTarget = 'seek';
  timeline.setPointerCapture(e.pointerId);
  handleDrag(e);
});

function handleDrag(e) {
  if (!dragTarget) return;
  const t = timeFromEvent(e);
  // Moving a handle leaves the playhead where it is — sitting outside the trim
  // is allowed, so you can look at what you cut.
  if (dragTarget === 'start') {
    state.trimStart = clamp(t, 0, state.trimEnd - MIN_TRIM);
    renderTimeline();
  } else if (dragTarget === 'end') {
    state.trimEnd = clamp(t, state.trimStart + MIN_TRIM, state.duration);
    renderTimeline();
  } else if (dragTarget === 'seek') {
    video.pause();
    seek(stepAt(t)); // the nearest point on the grid, not wherever the finger was
  }
}
timeline.addEventListener('pointermove', handleDrag);
timeline.addEventListener('pointerup', () => { dragTarget = null; });
timeline.addEventListener('pointercancel', () => { dragTarget = null; });


// ---------- Keyboard niceties ----------
window.addEventListener('keydown', (e) => {
  if (editorScreen.classList.contains('empty') || state.exporting) return;
  // Space on a focused button is that button's own shortcut — leave it alone,
  // or clicking Play once and then pressing Space toggles playback twice.
  if (e.code === 'Space' && !e.target.closest?.('button')) { e.preventDefault(); togglePlay(); }
  // Shift narrows the jump to a single step, matching the single chevrons.
  if (e.code === 'ArrowLeft') { e.preventDefault(); skip(e.shiftKey ? -1 : -STEP_JUMP); }
  if (e.code === 'ArrowRight') { e.preventDefault(); skip(e.shiftKey ? 1 : STEP_JUMP); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoBtn.click(); }
});

// ---------- Export ----------
// Preferred path: mediabunny decodes the original file with WebCodecs, so the
// export is frame-accurate and runs faster than real time. We redraw each
// decoded frame plus its doodle layer onto an offscreen canvas and encode that.
//
// Safari — especially on iPad — either lacks WebCodecs encoding or refuses every
// codec we can mux. There we fall back to recording the preview canvas in real
// time with MediaRecorder, which Safari has supported for years. Same picture,
// just slower and re-encoded from the preview rather than the source.

const HAS_WEBCODECS =
  typeof window.VideoEncoder === 'function' && typeof window.VideoDecoder === 'function';

// Pick the best format/codec combo this browser can actually encode.
async function pickEncoding(width, height, audioTrack) {
  const audioInfo = audioTrack
    ? { numberOfChannels: audioTrack.numberOfChannels, sampleRate: audioTrack.sampleRate }
    : null;

  for (const format of [new Mp4OutputFormat({ fastStart: 'in-memory' }), new WebMOutputFormat()]) {
    const supported = format.getSupportedCodecs();
    const videoCodec = await getFirstEncodableVideoCodec(
      VIDEO_CODECS.filter((c) => supported.includes(c)),
      { width, height, quality: QUALITY_HIGH },
    );
    if (!videoCodec) continue;

    let audioCodec = null;
    if (audioInfo) {
      audioCodec = await getFirstEncodableAudioCodec(
        AUDIO_CODECS.filter((c) => supported.includes(c)),
        { ...audioInfo, quality: QUALITY_HIGH },
      );
    }
    return { format, videoCodec, audioCodec };
  }
  return null;
}

downloadBtn.addEventListener('click', exportVideo);

async function exportVideo() {
  if (state.exporting || !state.file) return;

  state.exporting = true;
  setUIDisabled(true);
  exportOverlay.classList.remove('hidden');
  progressBar.style.width = '0%';
  video.pause();

  let firstError = null;
  try {
    if (HAS_WEBCODECS) {
      try {
        exportLabel.textContent = 'Making your video…';
        await exportWithWebCodecs();
        return;
      } catch (err) {
        // Any failure here — an unsupported codec, or a browser quirk deep in
        // the encoder — is worth retrying with the recorder before giving up.
        firstError = err;
        console.warn('WebCodecs export failed, recording instead:', err);
      }
    }
    // The suffix is deliberate: it tells us which path ran when something looks
    // wrong in the downloaded file.
    exportLabel.textContent = 'Making your video… (recording)';
    progressBar.style.width = '0%';
    await exportWithRecorder();
  } catch (err) {
    console.error('Export failed:', err, '(earlier:', firstError, ')');
    alert('Sorry, making the video didn’t work.\n\n' + describeError(err)
      + (firstError ? `\n\nFirst tried: ${describeError(firstError)}` : ''));
  } finally {
    state.exporting = false;
    setUIDisabled(false);
    exportOverlay.classList.add('hidden');
  }
}

// Errors from deep in an encoder are often bare DOMExceptions; the name carries
// as much information as the message, so show both.
function describeError(err) {
  if (!err) return 'Unknown error.';
  if (err.name && err.message) return `${err.name}: ${err.message}`;
  return String(err.message || err.name || err);
}

async function exportWithWebCodecs() {
  const trimStart = state.trimStart;
  const trimEnd = state.trimEnd;
  const span = Math.max(0.001, trimEnd - trimStart);

  const input = new Input({ source: new BlobSource(state.file), formats: ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error('That file doesn’t have a video track.');
  const audioTrack = await input.getPrimaryAudioTrack();

  // Out at the video's own resolution, not the preview's. H.264 needs even
  // dimensions.
  const width = Math.max(2, Math.floor(state.source.width / 2) * 2);
  const height = Math.max(2, Math.floor(state.source.height / 2) * 2);

  const encoding = await pickEncoding(width, height, audioTrack);
  if (!encoding) throw new Error('no encodable video codec');
  const { format, videoCodec, audioCodec } = encoding;

  // Offscreen stage: same compositing as the preview, at export resolution.
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const outCtx = out.getContext('2d');

  const target = new BufferTarget();
  const output = new Output({ format, target });

  const canvasSource = new CanvasSource(out, { codec: videoCodec, quality: QUALITY_HIGH });
  output.addVideoTrack(canvasSource);

  const audioSource = audioCodec
    ? new AudioSampleSource({ codec: audioCodec, quality: QUALITY_HIGH })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);

  await output.start();

  const rasterize = layerRasterizer(width, height);

  const pumpVideo = async () => {
    const sink = new VideoSampleSink(videoTrack);
    for await (const sample of sink.samples(trimStart, trimEnd)) {
      outCtx.clearRect(0, 0, width, height);
      sample.draw(outCtx, 0, 0, width, height);

      // Frames are continuous, doodles are on the grid: a decoded frame carries
      // whichever doodle its moment has reached. Same rule the preview uses.
      const doodle = rasterize(activeLayerAt(stepReached(sample.timestamp)));
      if (doodle) outCtx.drawImage(doodle, 0, 0);

      // Shift onto the trimmed timeline, and never let the last frame spill
      // past the trim end.
      const timestamp = Math.max(0, sample.timestamp - trimStart);
      const duration = Math.max(1 / 1000, Math.min(sample.duration, trimEnd - sample.timestamp));
      sample.close();

      await canvasSource.add(timestamp, duration);
      progressBar.style.width = `${clamp(timestamp / span, 0, 1) * 100}%`;
    }
  };

  const pumpAudio = async () => {
    if (!audioSource) return;
    const sink = new AudioSampleSink(audioTrack);
    for await (const sample of sink.samples(trimStart, trimEnd)) {
      sample.setTimestamp(Math.max(0, sample.timestamp - trimStart));
      await audioSource.add(sample);
      sample.close();
    }
  };

  await Promise.all([pumpVideo(), pumpAudio()]);
  await output.finalize();

  progressBar.style.width = '100%';
  const blob = new Blob([target.buffer], { type: format.mimeType });
  downloadBlob(blob, exportFileName(format.fileExtension.replace(/^\./, '')));
}

// ---------- Fallback export (Safari / iPad) ----------
function pickRecorderMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

// Safari has no HTMLMediaElement.captureStream, so route the audio through
// WebAudio instead. createMediaElementSource can only be called once per
// element, hence the caching.
function recorderAudioTracks() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return [];
  try {
    if (!state.audioTap) {
      const ctx = new AudioCtx();
      const source = ctx.createMediaElementSource(video);
      const dest = ctx.createMediaStreamDestination();
      source.connect(dest);
      source.connect(ctx.destination); // keep it audible while recording
      state.audioTap = { ctx, dest };
    }
    state.audioTap.ctx.resume();
    return state.audioTap.dest.stream.getAudioTracks();
  } catch (err) {
    console.warn('No audio in export:', err);
    return [];
  }
}

async function exportWithRecorder() {
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) {
    throw new Error('This browser can’t make video files. Try Chrome, Edge, or a newer Safari.');
  }

  const trimStart = state.trimStart;
  const trimEnd = state.trimEnd;
  const span = Math.max(0.001, trimEnd - trimStart);

  await seekAndWait(trimStart);

  // Composite onto our own canvas rather than capturing the preview one. The
  // preview sits above a visible <video>, so a failed drawImage there looks
  // fine on screen but records as a black frame with only the doodles on it.
  const out = document.createElement('canvas');
  out.width = state.source.width;
  out.height = state.source.height;
  const outCtx = out.getContext('2d');
  const rasterize = layerRasterizer(out.width, out.height);

  let painting = 0;
  const paint = () => {
    // The preview loop is parked for the duration of the export, so this one
    // keeps state.step following playback in its place.
    state.step = stepReached(video.currentTime);
    outCtx.fillStyle = '#000';
    outCtx.fillRect(0, 0, out.width, out.height);
    if (video.readyState >= 2) {
      try {
        outCtx.drawImage(video, 0, 0, out.width, out.height);
      } catch (err) {
        console.warn('Could not draw the video frame:', err);
      }
    }
    const doodle = rasterize(activeLayerAt(state.step));
    if (doodle) outCtx.drawImage(doodle, 0, 0);
    painting = requestAnimationFrame(paint);
  };
  paint();

  const stream = out.captureStream(30);
  for (const track of recorderAudioTracks()) stream.addTrack(track);

  const mime = pickRecorderMimeType();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  const blob = await new Promise((resolve, reject) => {
    let settled = false;

    // Recording ends at whichever comes first: reaching the trim end, the clip
    // ending, or a safety timeout. All three are needed — watching `paused`
    // alone hangs forever when `ended` beats it.
    const finish = () => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(painting);
      clearInterval(ticker);
      clearTimeout(safety);
      video.removeEventListener('ended', finish);
      video.pause();
      if (rec.state !== 'inactive') rec.stop();
    };

    // Straight off the element on purpose: a backgrounded tab stops rAF, and
    // this has to keep measuring the recording that's still running.
    const tick = () => {
      const p = clamp((video.currentTime - trimStart) / span, 0, 1);
      progressBar.style.width = `${p * 100}%`;
      if (video.currentTime >= trimEnd - 0.02) finish();
    };

    const ticker = setInterval(tick, 100);
    const safety = setTimeout(finish, span * 1000 + 5000);
    video.addEventListener('ended', finish);

    rec.onstop = () => resolve(new Blob(chunks, { type: mime || 'video/webm' }));
    rec.onerror = (e) => { finish(); reject(e.error || new Error('Recording failed.')); };

    rec.start();
    video.play().catch((err) => { finish(); reject(err); });
  });

  progressBar.style.width = '100%';
  const ext = (mime || '').includes('mp4') ? 'mp4' : 'webm';
  downloadBlob(blob, exportFileName(ext));
  seek(stepAt(trimStart));
}

// Real seconds rather than a step, because the recording has to start exactly
// where the trim does — the handles aren't on the grid. state.step follows along
// so the doodles still come up on the right moments.
function seekAndWait(t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-3) return resolve();
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
    state.step = stepReached(t);
    video.currentTime = t;
  });
}

// e.g. alice-video_2026-08-01_7s.mp4 — the duration is the trimmed length, so
// the name describes the file you actually got.
function exportFileName(ext) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const seconds = Math.max(1, Math.round(state.trimEnd - state.trimStart));
  return `alice-video_${date}_${seconds}s.${ext}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setUIDisabled(disabled) {
  [playBtn, stopBtn, backSecBtn, fwdSecBtn, backStepBtn, fwdStepBtn,
    prevDrawBtn, nextDrawBtn, undoBtn, clearBtn, eraserBtn, downloadBtn, newBtn]
    .forEach((b) => (b.disabled = disabled));
  canvas.style.pointerEvents = disabled ? 'none' : '';
  if (!disabled) updateDrawNav(); // these two depend on where the doodles are
}

// Start with the tools visible but inert, waiting for a video.
setUIDisabled(true);
