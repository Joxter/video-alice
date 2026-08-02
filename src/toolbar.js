// What the canvas is holding: pen or text, in a colour and a size.

export const COLORS = [
  '#e23b3b', '#f5a623', '#f7d038', '#3ba55d', '#2f6df6', '#8b5cf6',
  '#8b5e34', '#9aa1ab', '#111111', '#ffffff',
];

export function createToolbar({ tools, swatches, sizes, eraser, onToolChange = () => {} }) {
  const tool = { kind: 'pen', color: COLORS[0], size: 14, eraser: false };

  function setTool(kind) {
    tool.kind = kind;
    // The eraser rubs out pixels, which is something only the brush does.
    if (kind !== 'pen') {
      tool.eraser = false;
      eraser.classList.remove('active');
    }
    tools.querySelectorAll('[data-tool]')
      .forEach((b) => b.classList.toggle('active', b.dataset.tool === kind));
    onToolChange(kind);
  }

  tools.querySelectorAll('[data-tool]').forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });

  COLORS.forEach((color, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (i === 0 ? ' active' : '');
    b.style.background = color;
    b.dataset.color = color;
    b.addEventListener('click', () => {
      tool.color = color;
      tool.eraser = false;
      eraser.classList.remove('active');
      swatches.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s === b));
    });
    swatches.appendChild(b);
  });

  sizes.querySelectorAll('.size-btn').forEach((b) => {
    b.addEventListener('click', () => {
      tool.size = Number(b.dataset.size);
      sizes.querySelectorAll('.size-btn').forEach((s) => s.classList.toggle('active', s === b));
    });
  });

  eraser.addEventListener('click', () => {
    const on = !tool.eraser;
    setTool('pen');
    tool.eraser = on;
    eraser.classList.toggle('active', on);
  });

  return { tool };
}
