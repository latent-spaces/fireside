// Plain actions are a row of small buttons. Give them hints and they become
// choices: full rows that share the window's height, however tall it is.
const ROW = 72, GAP = 8, FRAME = 62;   // a choice, the space between, the title bar and padding

export default {
  heightFor: ({ items = [] }) => (items.some((it) => it.hint) ? FRAME + items.length * ROW + (items.length - 1) * GAP : null),
  render(p, { el, esc, actionRow, openKind, command }) {
    const items = p.items || [];
    if (!items.some((it) => it.hint)) return actionRow(items);
    const box = el('div', 'choices');
    for (const it of items) {
      const b = el('button', 'choice' + (it.tone ? ' ' + it.tone : ''));
      b.type = 'button';
      b.title = it.prompt || '';
      b.disabled = !!it.disabled;
      const words = el('span', 'choice-words');
      words.append(el('b', null, esc(it.label)));
      if (it.disabled || it.hint) words.append(el('small', null, esc(it.disabled || it.hint)));
      b.append(words, el('i', 'choice-go'));
      b.addEventListener('click', () => (it.window ? openKind(it.window) : command('arm', it.prompt, { immediate: it.immediate, label: it.label })));
      box.append(b);
    }
    return box;
  },
};
