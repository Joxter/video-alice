// Video Alice — a tiny browser-only video doodle + trim editor.
// Everything runs locally. The preview composites the video frame + the active
// doodle layer onto a canvas; the export re-runs that exact compositing over
// decoded frames via mediabunny, so what you see is what you download.

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

const uploadScreen = $('uploadScreen');
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
const handleStart = $('handleStart');
const handleEnd = $('handleEnd');
const timeLabel = $('timeLabel');
const trimLabel = $('trimLabel');

const playBtn = $('playBtn');
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
const COLORS = ['#e23b3b', '#f5a623', '#f7d038', '#3ba55d', '#2f6df6', '#8b5cf6', '#111111', '#ffffff'];
const SNAP_SECONDS = 0.12; // draw within this of an existing keyframe -> edit it
const MIN_TRIM = 0.2;      // keep at least this much between trim handles

// Codec preference order, best-looking first. Filtered per output format.
const VIDEO_CODECS = ['avc', 'vp9', 'av1', 'vp8'];
const AUDIO_CODECS = ['aac', 'opus'];

// ---------- State ----------
const state = {
  file: null,   // the original File — mediabunny decodes from this, not the <video>
  duration: 0,
  trimStart: 0,
  trimEnd: 0,
  layers: [],   // { time, canvas, ctx, strokes:[{color,size,eraser,points:[{x,y}]}] }
  tool: { color: COLORS[0], size: 14, eraser: false },
  drawing: null, // { layer, stroke }
  exporting: false,
  loopStarted: false,
  audioTap: null, // WebAudio tap on the <video>, built once for recorder exports
};

// ---------- Helpers ----------
function fmtTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
  const url = URL.createObjectURL(file);
  video.src = url;
  video.load();
}

video.addEventListener('loadedmetadata', setupVideo);

function setupVideo() {
  state.duration = video.duration;
  state.trimStart = 0;
  state.trimEnd = video.duration;
  state.layers = [];

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;

  uploadScreen.classList.add('hidden');
  editorScreen.classList.remove('hidden');
  newBtn.classList.remove('hidden');

  video.currentTime = 0;
  renderKeyframes();
  renderTimeline();
  setPlayIcon(false);

  if (!state.loopStarted) {
    state.loopStarted = true;
    requestAnimationFrame(renderLoop);
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
  fileInput.value = '';
  editorScreen.classList.add('hidden');
  newBtn.classList.add('hidden');
  uploadScreen.classList.remove('hidden');
}

// ---------- Layers (doodle keyframes) ----------
function createLayer(time) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const layer = { time, canvas: c, ctx: c.getContext('2d'), strokes: [] };
  state.layers.push(layer);
  state.layers.sort((a, b) => a.time - b.time);
  renderKeyframes();
  return layer;
}

function removeLayer(layer) {
  const i = state.layers.indexOf(layer);
  if (i >= 0) state.layers.splice(i, 1);
  renderKeyframes();
}

// Layer shown at time t = most recent keyframe at or before t.
function activeLayerAt(t) {
  let best = null;
  for (const l of state.layers) {
    if (l.time <= t + 1e-3 && (!best || l.time > best.time)) best = l;
  }
  return best;
}

// Layer to draw onto right now: reuse a nearby keyframe, else make a new one.
function layerForDrawing() {
  const t = video.currentTime;
  let layer = state.layers.find((l) => Math.abs(l.time - t) < SNAP_SECONDS);
  if (!layer) layer = createLayer(t);
  return layer;
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

// ---------- Pointer drawing on the canvas ----------
function toCanvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width),
    y: (e.clientY - r.top) * (canvas.height / r.height),
  };
}

canvas.addEventListener('pointerdown', (e) => {
  if (state.exporting) return;
  if (!video.paused) { video.pause(); setPlayIcon(false); }
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
  if (!state.drawing) return;
  const { layer, stroke } = state.drawing;
  const pt = toCanvasPoint(e);
  const prev = stroke.points[stroke.points.length - 1];
  stroke.points.push(pt);
  drawSegment(layer.ctx, stroke, prev, pt);
});

function endStroke() { state.drawing = null; }
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

// ---------- Undo / Clear ----------
undoBtn.addEventListener('click', () => {
  const layer = activeLayerAt(video.currentTime);
  if (!layer || !layer.strokes.length) return;
  layer.strokes.pop();
  redrawLayer(layer);
  if (!layer.strokes.length) removeLayer(layer);
});

clearBtn.addEventListener('click', () => {
  const layer = activeLayerAt(video.currentTime);
  if (layer) removeLayer(layer);
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
    if (video.currentTime < state.trimStart || video.currentTime >= state.trimEnd - 1e-3) {
      video.currentTime = state.trimStart;
    }
    video.play();
    setPlayIcon(true);
  } else {
    video.pause();
    setPlayIcon(false);
  }
}
function setPlayIcon(playing) {
  playBtn.textContent = playing ? '❚❚' : '▶';
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

// ---------- Render loop ----------
function renderLoop() {
  if (video.readyState >= 2 && canvas.width) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const layer = activeLayerAt(video.currentTime);
    if (layer) ctx.drawImage(layer.canvas, 0, 0);
  }

  // Stop preview playback at the trim end.
  if (!video.paused && video.currentTime >= state.trimEnd - 1e-3) {
    video.pause();
    video.currentTime = state.trimEnd;
    setPlayIcon(false);
  }

  updatePlayhead();
  requestAnimationFrame(renderLoop);
}

function updatePlayhead() {
  if (!state.duration) return;
  playhead.style.left = `${(video.currentTime / state.duration) * 100}%`;
  timeLabel.textContent = fmtTime(video.currentTime);
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
  trimLabel.textContent = `Trim: ${fmtTime(state.trimStart)} – ${fmtTime(state.trimEnd)}`;
}

function renderKeyframes() {
  const d = state.duration || 1;
  keyframesEl.innerHTML = '';
  for (const l of state.layers) {
    const dot = document.createElement('div');
    dot.className = 'keyframe-dot';
    dot.style.left = `${(l.time / d) * 100}%`;
    keyframesEl.appendChild(dot);
  }
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
  if (dragTarget === 'start') {
    state.trimStart = clamp(t, 0, state.trimEnd - MIN_TRIM);
    if (video.currentTime < state.trimStart) seek(state.trimStart);
    renderTimeline();
  } else if (dragTarget === 'end') {
    state.trimEnd = clamp(t, state.trimStart + MIN_TRIM, state.duration);
    if (video.currentTime > state.trimEnd) seek(state.trimEnd);
    renderTimeline();
  } else if (dragTarget === 'seek') {
    if (!video.paused) { video.pause(); setPlayIcon(false); }
    seek(clamp(t, state.trimStart, state.trimEnd));
  }
}
timeline.addEventListener('pointermove', handleDrag);
timeline.addEventListener('pointerup', () => { dragTarget = null; });
timeline.addEventListener('pointercancel', () => { dragTarget = null; });

function seek(t) {
  video.currentTime = clamp(t, 0, state.duration);
}

// ---------- Keyboard niceties ----------
window.addEventListener('keydown', (e) => {
  if (editorScreen.classList.contains('hidden') || state.exporting) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
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
  setPlayIcon(false);

  let firstError = null;
  try {
    if (HAS_WEBCODECS) {
      try {
        setExportLabel('Making your video…');
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
    setExportLabel('Making your video… (recording)');
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

// Thrown when this browser can't do the WebCodecs path — the signal to fall back
// rather than show an error.
class UnsupportedHereError extends Error {}

function setExportLabel(text) {
  if (exportLabel) exportLabel.textContent = text;
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

  // H.264 needs even dimensions; keep the preview's aspect ratio.
  const width = Math.max(2, Math.floor(canvas.width / 2) * 2);
  const height = Math.max(2, Math.floor(canvas.height / 2) * 2);

  const encoding = await pickEncoding(width, height, audioTrack);
  if (!encoding) throw new UnsupportedHereError('no encodable video codec');
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

  const pumpVideo = async () => {
    const sink = new VideoSampleSink(videoTrack);
    for await (const sample of sink.samples(trimStart, trimEnd)) {
      outCtx.clearRect(0, 0, width, height);
      sample.draw(outCtx, 0, 0, width, height);

      const layer = activeLayerAt(sample.timestamp);
      if (layer) outCtx.drawImage(layer.canvas, 0, 0, width, height);

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
  downloadBlob(blob, `video-alice.${format.fileExtension.replace(/^\./, '')}`);
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
  out.width = canvas.width;
  out.height = canvas.height;
  const outCtx = out.getContext('2d');

  let painting = 0;
  const paint = () => {
    outCtx.fillStyle = '#000';
    outCtx.fillRect(0, 0, out.width, out.height);
    if (video.readyState >= 2) {
      try {
        outCtx.drawImage(video, 0, 0, out.width, out.height);
      } catch (err) {
        console.warn('Could not draw the video frame:', err);
      }
    }
    const layer = activeLayerAt(video.currentTime);
    if (layer) outCtx.drawImage(layer.canvas, 0, 0, out.width, out.height);
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
    // ending, or a safety timeout. The old version watched only `paused`, which
    // the `ended` event could beat — that's what made it hang forever.
    const finish = () => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(painting);
      clearInterval(ticker);
      clearTimeout(safety);
      video.removeEventListener('ended', finish);
      video.pause();
      setPlayIcon(false);
      if (rec.state !== 'inactive') rec.stop();
    };

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
    video.play().then(() => setPlayIcon(true), (err) => { finish(); reject(err); });
  });

  progressBar.style.width = '100%';
  const ext = (mime || '').includes('mp4') ? 'mp4' : 'webm';
  downloadBlob(blob, `video-alice.${ext}`);
  seek(trimStart);
}

function seekAndWait(t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 1e-3) return resolve();
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
  });
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
  [playBtn, undoBtn, clearBtn, eraserBtn, downloadBtn, newBtn].forEach((b) => (b.disabled = disabled));
  canvas.style.pointerEvents = disabled ? 'none' : '';
}
