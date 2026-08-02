// Items to pixels. Nothing here knows about the app: hand it a 2d context and
// it draws, which is why the preview, the layer caches and the full-resolution
// export can all be the same code.

export const FONT_STACK =
  'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const LINE_HEIGHT = 1.25;

const measure = document.createElement('canvas').getContext('2d');

export function textBox(item) {
  const lines = item.text.split('\n');
  measure.font = `${item.size}px ${FONT_STACK}`;
  let width = 0;
  for (const line of lines) width = Math.max(width, measure.measureText(line).width);
  return { lines, width, height: lines.length * item.size * LINE_HEIGHT };
}

function style(ctx, stroke) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = stroke.size;
  ctx.globalCompositeOperation = stroke.eraser ? 'destination-out' : 'source-over';
  ctx.strokeStyle = stroke.eraser ? 'rgba(0,0,0,1)' : stroke.color;
  ctx.fillStyle = ctx.strokeStyle;
}

export function drawDot(ctx, stroke, pt) {
  style(ctx, stroke);
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, stroke.size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

export function drawSegment(ctx, stroke, a, b) {
  style(ctx, stroke);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
}

function drawText(ctx, item) {
  if (!item.text) return;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = item.color;
  ctx.font = `${item.size}px ${FONT_STACK}`;
  ctx.textBaseline = 'top';
  textBox(item).lines.forEach((line, i) => {
    ctx.fillText(line, item.x, item.y + i * item.size * LINE_HEIGHT);
  });
}

export function drawItem(ctx, item) {
  if (item.type === 'text') {
    drawText(ctx, item);
  } else if (item.points.length === 1) {
    drawDot(ctx, item, item.points[0]);
  } else {
    for (let i = 1; i < item.points.length; i++) {
      drawSegment(ctx, item, item.points[i - 1], item.points[i]);
    }
  }
}

// In order, so a text over a stroke stays over it and the eraser rubs out what
// came before it.
export function replay(ctx, items, skip) {
  for (const item of items) if (item !== skip) drawItem(ctx, item);
}
