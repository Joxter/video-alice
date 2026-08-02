// The drawings, one per moment.
//
// A doodle belongs to a step on the grid and is a list of items — pen strokes
// and texts. The layer canvas is only a cache of replaying them, which is what
// lets undo, the saved drawings and the export share one mechanism.
//
// A doodle replaces the one before it rather than adding to it: what shows at a
// step is exactly one layer, the newest at or before it.

import { replay } from './render.js';

const STORE = 'videoAlice:drawings';
const tenth = (n) => Math.round(n * 10) / 10;

export function createDoodles({ onChange = () => {} } = {}) {
  let layers = [];
  let width = 0;
  let height = 0;
  let saveTimer = 0;

  function blank(step) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return { step, canvas, ctx: canvas.getContext('2d'), items: [] };
  }

  function redraw(layer, skip) {
    layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    replay(layer.ctx, layer.items, skip);
  }

  function remove(layer) {
    const i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    onChange();
  }

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        width,
        height,
        layers: layers.map((l) => ({
          step: l.step,
          items: l.items.map((item) => (item.type === 'text'
            ? { type: 'text', color: item.color, size: item.size, x: tenth(item.x), y: tenth(item.y), text: item.text }
            : {
              color: item.color,
              size: item.size,
              eraser: item.eraser,
              points: item.points.map((p) => [tenth(p.x), tenth(p.y)]),
            })),
        })),
      }));
    } catch (err) {
      console.warn('Could not save the drawings:', err);
    }
  }

  const api = {
    reset(w, h) {
      width = w;
      height = h;
      layers = [];
      onChange();
    },

    // What shows at a step, and what belongs to it. Only the second can be
    // changed: to rework an earlier doodle you go back to its own moment.
    at(step) {
      let best = null;
      for (const l of layers) if (l.step <= step && (!best || l.step > best.step)) best = l;
      return best;
    },
    on(step) {
      return layers.find((l) => l.step === step) || null;
    },
    forDrawing(step) {
      const found = api.on(step);
      if (found) return found;
      const layer = blank(step);
      layers.push(layer);
      layers.sort((a, b) => a.step - b.step);
      onChange();
      return layer;
    },

    redraw,
    remove,

    // Layers are kept in step order, so the next doodle either way is just the
    // neighbour.
    neighbour(step, direction) {
      return direction < 0
        ? layers.filter((l) => l.step < step).pop() || null
        : layers.find((l) => l.step > step) || null;
    },
    steps() {
      return layers.map((l) => l.step);
    },

    undo(step) {
      const layer = api.at(step);
      if (!layer || !layer.items.length) return;
      layer.items.pop();
      if (layer.items.length) redraw(layer);
      else remove(layer);
      api.saveSoon();
    },
    clear(step) {
      const layer = api.at(step);
      if (!layer) return;
      remove(layer);
      api.saveSoon();
    },

    // Strokes and text are geometry, so replaying them into a bigger canvas
    // costs nothing in quality — upscaling the layer would have cost edges, and
    // letters most of all. Frames are encoded in order, so one buffer is enough.
    rasterizer(w, h) {
      const out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      const ctx = out.getContext('2d');
      let current = null;
      return (layer) => {
        if (!layer) return null;
        if (layer !== current) {
          current = layer;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, w, h);
          ctx.setTransform(w / layer.canvas.width, 0, 0, h / layer.canvas.height, 0, 0);
          replay(ctx, layer.items);
        }
        return out;
      };
    },

    // Coordinates belong to the preview canvas, so they're rescaled if the next
    // file is a different shape. There's no check that it's even the same file:
    // come back, open something else, and last night's doodles are still there.
    restore(lastStep) {
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(STORE) || 'null');
      } catch (err) {
        console.warn('Could not read the saved drawings:', err);
      }
      if (!saved?.layers?.length || !saved.width || !saved.height) return;

      const sx = width / saved.width;
      const sy = height / saved.height;
      for (const l of saved.layers) {
        if (l.step > lastStep) continue;
        const layer = blank(l.step);
        // `strokes` is what the version before the text tool wrote.
        layer.items = (l.items || l.strokes || []).map((item) => (item.type === 'text'
          ? { type: 'text', color: item.color, size: item.size * sx, x: item.x * sx, y: item.y * sy, text: item.text }
          : {
            color: item.color,
            eraser: item.eraser,
            size: item.size * sx,
            points: item.points.map(([x, y]) => ({ x: x * sx, y: y * sy })),
          }));
        redraw(layer);
        layers.push(layer);
      }
      layers.sort((a, b) => a.step - b.step);
      onChange();
    },

    saveSoon() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 400);
    },
    flush() {
      clearTimeout(saveTimer);
      save();
    },
  };

  return api;
}
