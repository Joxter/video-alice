// The file being edited, and where we are in it — a video or a still picture.
//
// A picture is a clip with one step on the grid, so almost nothing downstream
// has to ask which of the two it has.

import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

// The playhead only ever stops on a tenth of a second, so "is this doodle on
// the same moment as the playhead?" is a comparison of two whole numbers. Ask a
// <video> where it is and the answer drifts by milliseconds. Playback and the
// exported file are untouched; it's only where you can stop that is quantised.
export const TIME_STEP = 0.1;
export const STEPS_PER_SECOND = Math.round(1 / TIME_STEP);

const MIN_TRIM = 0.2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createClip({ video, onReady, onDuration, onStep, onPlaying, onError }) {
  const frame = document.createElement('canvas');
  const frameCtx = frame.getContext('2d');
  let painted = false;

  let mode = 'video';
  let file = null;
  let image = null;
  let width = 0;
  let height = 0;
  let duration = 0;
  let lastStep = 0;
  let step = 0;
  let trimStart = 0;
  let trimEnd = 0;
  let busy = false;

  function setStep(next) {
    const wanted = clamp(Math.round(next), 0, lastStep);
    if (wanted === step) return false;
    step = wanted;
    onStep?.(step);
    return true;
  }

  // `settled` is false for a file whose length still has to be read out of it:
  // the grid isn't real yet, so nothing should place saved drawings on it.
  function setDuration(seconds, settled) {
    duration = seconds;
    trimEnd = seconds;
    lastStep = Math.max(0, Math.floor(seconds / TIME_STEP)); // a moment the file actually has
    if (settled) onDuration?.();
  }

  function release() {
    if (video.src) {
      video.pause();
      URL.revokeObjectURL(video.src);
      video.removeAttribute('src');
      video.load();
    }
    if (image) {
      URL.revokeObjectURL(image.src);
      image = null;
    }
    painted = false;
  }

  function ready(w, h) {
    width = w;
    height = h;
    step = 0;
    trimStart = 0;
    painted = false;
    onReady?.();
  }

  // Anything MediaRecorder produced — including this app's own fallback export —
  // leaves the duration out of the header, so the DOM reports Infinity forever.
  async function repairDuration(forFile) {
    try {
      const input = new Input({ source: new BlobSource(forFile), formats: ALL_FORMATS });
      const seconds = await input.computeDuration();
      if (file !== forFile) return;
      if (!isFinite(seconds) || seconds <= 0) throw new Error('no duration in the file');
      setDuration(seconds, true);
    } catch (err) {
      if (file !== forFile) return;
      console.error('Could not work out how long the video is:', err);
      onError?.('Sorry, this video can’t be edited — its length is missing from the file.');
    }
  }

  video.addEventListener('loadedmetadata', () => {
    if (mode !== 'video') return;
    ready(video.videoWidth, video.videoHeight);
    const known = isFinite(video.duration);
    setDuration(known ? video.duration : 0, known);
    if (!known) repairDuration(file);
    api.seek(0);
  });

  video.addEventListener('play', () => onPlaying?.(true));
  video.addEventListener('pause', () => {
    onPlaying?.(false);
    // Playback stops between two steps; snap back onto the grid so the picture,
    // the marker and the doodle agree.
    if (!busy) api.seek(step);
  });

  function loadImage(forFile) {
    const img = new Image();
    const stale = () => {
      if (file === forFile) return false;
      URL.revokeObjectURL(img.src);
      return true;
    };
    img.onload = () => {
      if (stale()) return;
      // An SVG with no intrinsic size loads fine and has nothing to draw at.
      if (!img.naturalWidth || !img.naturalHeight) return img.onerror();
      image = img;
      ready(img.naturalWidth, img.naturalHeight);
      setDuration(0, true);
    };
    img.onerror = () => {
      if (stale()) return;
      URL.revokeObjectURL(img.src);
      onError?.('Sorry, this picture can’t be opened.');
    };
    img.src = URL.createObjectURL(forFile);
  }

  const api = {
    get mode() { return mode; },
    get file() { return file; },
    get width() { return width; },
    get height() { return height; },
    get duration() { return duration; },
    get lastStep() { return lastStep; },
    get step() { return step; },
    get time() { return step * TIME_STEP; },
    get trimStart() { return trimStart; },
    get trimEnd() { return trimEnd; },
    get paused() { return mode !== 'video' || video.paused; },
    get loaded() { return !!(file && width); },
    get videoElement() { return video; },  // the recorder export plays it directly
    get imageElement() { return image; },

    load(next) {
      release();
      file = next;
      mode = next.type.startsWith('image/') ? 'image' : 'video';
      if (mode === 'image') loadImage(next);
      else { video.src = URL.createObjectURL(next); video.load(); }
    },

    close() {
      release();
      file = null;
      mode = 'video';
      width = height = 0;
      step = 0;
      trimStart = 0;
      setDuration(0, true);
    },

    setBusy(on) { busy = on; },

    // Going somewhere: the nearest step, so a click lands where it looks like it
    // did. Watching time pass: the step it has reached, so a doodle comes up on
    // arrival rather than half a step early.
    stepAt: (t) => clamp(Math.round(t / TIME_STEP), 0, lastStep),
    stepReached: (t) => clamp(Math.floor(t / TIME_STEP), 0, lastStep),

    seek(next) {
      setStep(next);
      if (mode === 'video') video.currentTime = step * TIME_STEP;
    },
    // Stepping is for lining up a doodle, so it pauses first, and it ranges over
    // the whole clip: you may want to draw just outside the trim.
    skip(steps) {
      api.pause();
      api.seek(step + steps);
    },
    jumpToDoodle(layer) {
      api.pause();
      api.seek(layer.step);
    },

    play() {
      if (mode !== 'video') return;
      const now = step * TIME_STEP;
      if (now < trimStart || now >= trimEnd - TIME_STEP / 2) api.seek(api.stepAt(trimStart));
      video.play();
    },
    pause() { if (mode === 'video') video.pause(); },
    toggle() { if (video.paused) api.play(); else api.pause(); },
    stop() {
      api.pause();
      api.seek(api.stepAt(trimStart));
    },

    setTrim(edge, seconds) {
      if (edge === 'start') trimStart = clamp(seconds, 0, trimEnd - MIN_TRIM);
      else trimEnd = clamp(seconds, trimStart + MIN_TRIM, duration);
    },

    // Follows playback and stops it at the trim end. Straight off the element:
    // the trim handles aren't on the grid, so this is about real time.
    tick() {
      if (mode !== 'video' || video.paused) return;
      setStep(api.stepReached(video.currentTime));
      if (video.currentTime >= trimEnd - 1e-3) video.pause();
    },

    // The freshest picture there is. A <video> refuses to draw while a seek is
    // still fetching its frame, so the last one that arrived is kept here and
    // composited from — otherwise a stroke drawn mid-seek shows up over a stale
    // picture.
    paintFrame(dest, w, h) {
      if (frame.width !== w || frame.height !== h) {
        frame.width = w;
        frame.height = h;
        painted = false;
      }
      if (mode === 'image') {
        if (!painted && image) { frameCtx.drawImage(image, 0, 0, w, h); painted = true; }
      } else if (video.readyState >= 2) {
        frameCtx.drawImage(video, 0, 0, w, h);
        painted = true;
      }
      dest.clearRect(0, 0, w, h);
      if (painted) dest.drawImage(frame, 0, 0);
    },

    // Real seconds, not a step: a recording has to start exactly where the trim
    // does. The step follows along so doodles still come up at the right moments.
    seekTime(t) {
      return new Promise((resolve) => {
        if (Math.abs(video.currentTime - t) < 1e-3) return resolve();
        const done = () => { video.removeEventListener('seeked', done); resolve(); };
        video.addEventListener('seeked', done);
        setStep(api.stepReached(t));
        video.currentTime = t;
      });
    },
    // The export loop drives the step itself, since the preview loop is parked.
    followPlayback() { setStep(api.stepReached(video.currentTime)); },
  };

  return api;
}
