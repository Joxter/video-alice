// The track: the playhead, the trim handles, and a dot for every moment that
// carries a doodle.

import { TIME_STEP } from './clip.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Tenths, because that's the grid — hundredths would suggest a precision the
// playhead doesn't have.
function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const tenths = Math.round(t * 10);   // or 59.99s formats as 0:60.0
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

export function createTimeline({ els, clip, doodles }) {
  const { track, trimRegion, stepSlot, keyframes, playhead, handleStart, handleEnd, timeLabel, prevDraw, nextDraw } = els;
  let dots = [];
  let shownTime = -1;
  let shownStep = -1;
  let dragging = null;
  let disabled = false;

  function renderTrim() {
    const d = clip.duration || 1;
    const start = (clip.trimStart / d) * 100;
    const end = (clip.trimEnd / d) * 100;
    trimRegion.style.left = `${start}%`;
    trimRegion.style.width = `${end - start}%`;
    handleStart.style.left = `${start}%`;
    handleEnd.style.left = `${end}%`;
  }

  // The band the playhead stands in — one step wide, so it's clear which moment
  // a stroke would belong to.
  function renderSlot() {
    const d = clip.duration || 1;
    stepSlot.style.left = `${((clip.time - TIME_STEP / 2) / d) * 100}%`;
    stepSlot.style.width = `${(TIME_STEP / d) * 100}%`;
    for (const dot of dots) dot.el.classList.toggle('current', dot.step === clip.step);
  }

  function renderNav() {
    prevDraw.disabled = !doodles.neighbour(clip.step, -1);
    nextDraw.disabled = !doodles.neighbour(clip.step, 1);
  }

  function timeFromEvent(e) {
    const r = track.getBoundingClientRect();
    return (clamp(e.clientX - r.left, 0, r.width) / r.width) * clip.duration;
  }

  function drag(e) {
    if (!dragging) return;
    const t = timeFromEvent(e);
    if (dragging === 'seek') {
      clip.pause();
      clip.seek(clip.stepAt(t));    // the nearest point on the grid
    } else {
      // Moving a handle leaves the playhead where it is: sitting outside the
      // trim is allowed, so you can look at what you cut.
      clip.setTrim(dragging, t);
      renderTrim();
    }
  }

  const startDrag = (edge) => (e) => {
    if (disabled) return;
    e.preventDefault();
    dragging = edge;
    track.setPointerCapture(e.pointerId);
    drag(e);
  };
  handleStart.addEventListener('pointerdown', startDrag('start'));
  handleEnd.addEventListener('pointerdown', startDrag('end'));
  track.addEventListener('pointerdown', (e) => {
    if (disabled || dragging || e.target === handleStart || e.target === handleEnd) return;
    dragging = 'seek';
    track.setPointerCapture(e.pointerId);
    drag(e);
  });
  track.addEventListener('pointermove', drag);
  track.addEventListener('pointerup', () => { dragging = null; });
  track.addEventListener('pointercancel', () => { dragging = null; });

  const jump = (direction) => () => {
    const target = doodles.neighbour(clip.step, direction);
    if (target) clip.jumpToDoodle(target);
  };
  prevDraw.addEventListener('click', jump(-1));
  nextDraw.addEventListener('click', jump(1));

  return {
    // The dots and the jump buttons describe the same set of moments.
    refresh() {
      const d = clip.duration || 1;
      keyframes.innerHTML = '';
      dots = doodles.steps().map((step) => {
        const el = document.createElement('div');
        el.className = 'keyframe-dot';
        el.style.left = `${((step * TIME_STEP) / d) * 100}%`;
        keyframes.appendChild(el);
        return { step, el };
      });
      renderTrim();
      renderSlot();
      renderNav();
    },

    // Called every frame, so it skips the DOM writes while nothing moves —
    // which is most of the time in an editor like this.
    update() {
      if (!clip.duration) return;
      const t = clip.paused ? clip.time : clip.videoElement.currentTime;
      if (t === shownTime && clip.step === shownStep) return;
      shownTime = t;
      playhead.style.left = `${(t / clip.duration) * 100}%`;
      timeLabel.textContent = fmtTime(t);
      if (clip.step !== shownStep) {
        shownStep = clip.step;
        renderSlot();
        renderNav();
      }
    },

    invalidate() { shownTime = -1; shownStep = -1; },
    setDisabled(on) {
      disabled = on;
      if (on) prevDraw.disabled = nextDraw.disabled = true;
      else renderNav();
    },
  };
}
