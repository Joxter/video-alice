// The picture with the doodle on top, and everything you do to it with a
// pointer: drawing, placing text, dragging a text by its handle.

import { drawDot, drawSegment, textBox } from './render.js';

// The preview is never drawn wider than the 820px page — call it 1600 device
// pixels — so a 4K frame is four fifths wasted. Layers are allocated at this
// size too, and those add up: one per doodle is 33 MB at 4K, 3 MB here. The
// export doesn't suffer, since it re-renders items at the source resolution.
const PREVIEW_MAX = 1600;

// The size buttons are stroke widths; used raw as font sizes they'd be a whisper.
const TEXT_SCALE = 3;
// The handle is interface, not picture, so it's sized in CSS pixels and stays
// the same handle whatever resolution the canvas underneath happens to be.
const ANCHOR_CSS = 11;
const ANCHOR_GRAB_CSS = 22;

export function createStage({ canvas, clip, doodles, toolbar, text }) {
  const ctx = canvas.getContext('2d');
  let drawing = null;
  let dragging = null;

  const cssScale = () => canvas.width / (canvas.getBoundingClientRect().width || 1);

  function pointAt(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height),
    };
  }

  const anchorOf = (item) => ({ x: item.x + textBox(item).width, y: item.y });

  // Handles show only while the text tool is out, and only for the doodle whose
  // own moment we're standing on — an inherited one is on screen but not in hand.
  function handles() {
    if (toolbar.tool.kind !== 'text') return [];
    const layer = doodles.on(clip.step);
    if (!layer) return [];
    return layer.items
      .filter((item) => item.type === 'text' && item !== text.item)
      .map((item) => ({ layer, item }));
  }

  function handleAt(pt) {
    const grab = ANCHOR_GRAB_CSS * cssScale();
    for (const hit of handles().reverse()) {   // topmost first
      const a = anchorOf(hit.item);
      if (Math.hypot(pt.x - a.x, pt.y - a.y) <= grab) return hit;
    }
    return null;
  }

  function startTyping(layer, item) {
    text.start(item, layer);
    doodles.redraw(layer, item);   // it lives in the textarea until it's done
  }

  canvas.addEventListener('pointerdown', (e) => {
    // One at a time: a second finger mustn't start a rival stroke or take over.
    if (drawing || dragging) return;
    // A pointer down anywhere ends typing, so what happens next sees the text as
    // finished — including this same click landing on the handle it just made.
    text.commit();
    clip.pause();
    const pt = pointAt(e);

    if (toolbar.tool.kind === 'text') {
      // Focus has to be taken inside the gesture or a phone won't raise its
      // keyboard, and the browser's own click handling takes it straight back
      // unless the gesture has no default — which committed every text while it
      // was still empty and made the tool look broken.
      e.preventDefault();
      const hit = handleAt(pt);
      if (hit) {
        canvas.setPointerCapture(e.pointerId);
        dragging = {
          pointerId: e.pointerId,
          ...hit,
          dx: hit.item.x - pt.x,
          dy: hit.item.y - pt.y,
          moved: false,
        };
      } else {
        const layer = doodles.forDrawing(clip.step);
        const item = {
          type: 'text',
          color: toolbar.tool.color,
          size: toolbar.tool.size * TEXT_SCALE,
          x: pt.x,
          y: pt.y,
          text: '',
        };
        layer.items.push(item);
        startTyping(layer, item);
      }
      return;
    }

    canvas.setPointerCapture(e.pointerId);
    const layer = doodles.forDrawing(clip.step);
    const stroke = {
      color: toolbar.tool.color,
      size: toolbar.tool.size,
      eraser: toolbar.tool.eraser,
      points: [pt],
    };
    layer.items.push(stroke);
    drawing = { pointerId: e.pointerId, layer, stroke };
    drawDot(layer.ctx, stroke, pt);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (dragging?.pointerId === e.pointerId) {
      const pt = pointAt(e);
      dragging.item.x = pt.x + dragging.dx;
      dragging.item.y = pt.y + dragging.dy;
      dragging.moved = true;
      doodles.redraw(dragging.layer);
      return;
    }
    if (drawing?.pointerId !== e.pointerId) return;
    const pt = pointAt(e);
    const { points } = drawing.stroke;
    drawSegment(drawing.layer.ctx, drawing.stroke, points[points.length - 1], pt);
    points.push(pt);
  });

  function endPointer(e) {
    if (dragging?.pointerId === e.pointerId) {
      const { layer, item, moved } = dragging;
      dragging = null;
      if (moved) doodles.saveSoon();
      else startTyping(layer, item);   // a tap on the handle, not a drag
      return;
    }
    if (drawing?.pointerId !== e.pointerId) return;
    drawing = null;
    doodles.saveSoon();
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  return {
    get width() { return canvas.width; },
    get height() { return canvas.height; },

    fit(w, h) {
      const shrink = Math.min(1, PREVIEW_MAX / Math.max(1, w, h));
      canvas.width = Math.max(1, Math.round(w * shrink));
      canvas.height = Math.max(1, Math.round(h * shrink));
    },

    render() {
      clip.paintFrame(ctx, canvas.width, canvas.height);
      const layer = doodles.at(clip.step);
      if (layer) ctx.drawImage(layer.canvas, 0, 0);

      // Handles are drawn here rather than into a layer, so they are never part
      // of a doodle and never reach the export.
      const marks = handles();
      if (!marks.length) return;
      const r = ANCHOR_CSS * cssScale();
      for (const { item } of marks) {
        const a = anchorOf(item);
        ctx.beginPath();
        ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fill();
        ctx.lineWidth = Math.max(1, r * 0.22);
        ctx.strokeStyle = '#2f6df6';
        ctx.stroke();
      }
    },

    // What happens when typing ends, wherever it ended from.
    finishText(item, layer) {
      if (!item.text.trim()) {
        const i = layer.items.indexOf(item);
        if (i >= 0) layer.items.splice(i, 1);
      }
      if (!layer.items.length) doodles.remove(layer);
      else doodles.redraw(layer);
      doodles.saveSoon();
    },

    setEnabled(on) {
      canvas.style.pointerEvents = on ? '' : 'none';
    },
  };
}
