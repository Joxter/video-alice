// A textarea standing over the canvas in place of the text being typed: same
// font, same size, same colour, same spot. It brings a caret, a phone keyboard
// and an IME with it, and wrap="off" is the whole "lines break where you press
// Enter" rule.

import { FONT_STACK, LINE_HEIGHT, textBox } from './render.js';

export function createTextEntry({ element, canvas, onCommit }) {
  let item = null;
  let context = null;

  // How many canvas pixels one CSS pixel is worth.
  const cssScale = () => canvas.width / (canvas.getBoundingClientRect().width || 1);

  function sync() {
    if (!item) return;
    const scale = 1 / cssScale();
    const size = item.size * scale;
    // Canvas puts the first line's top at item.y; a line box centres its glyph,
    // so it starts half a line's leading higher.
    const lead = ((LINE_HEIGHT - 1) / 2) * size;
    const box = textBox({ ...item, text: element.value });
    element.style.left = `${item.x * scale}px`;
    element.style.top = `${item.y * scale - lead}px`;
    element.style.font = `${size}px ${FONT_STACK}`;
    element.style.lineHeight = `${LINE_HEIGHT}`;
    element.style.color = item.color;
    element.style.width = `${box.width * scale + size * 0.6}px`; // room for the caret
    element.style.height = `${box.height * scale}px`;
  }

  function commit() {
    if (!item) return;
    const finished = item;
    const where = context;
    item.text = element.value;
    item = null;
    context = null;
    element.classList.add('hidden');
    element.blur();
    onCommit(finished, where);
  }

  element.addEventListener('input', sync);
  element.addEventListener('blur', commit);
  element.addEventListener('keydown', (e) => {
    // Escape is "done", like clicking away; an empty text simply never becomes
    // anything, so there is nothing to cancel.
    if (e.key === 'Escape') { e.preventDefault(); commit(); }
  });
  window.addEventListener('resize', sync);

  return {
    get item() { return item; },
    get open() { return !!item; },
    // `where` is handed back on commit, so the caller needn't track it.
    start(next, where) {
      item = next;
      context = where;
      element.value = next.text;
      element.classList.remove('hidden');
      sync();
      element.focus();
      element.setSelectionRange(next.text.length, next.text.length);
    },
    commit,
  };
}
