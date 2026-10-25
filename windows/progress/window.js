export default {
  render(p, { el, esc }) {
    const wrap = el('div');
    const steps = p.steps || [];
    const total = p.max ?? steps.length;
    const value = p.value ?? steps.filter((s) => s.state === 'done').length;
    if (total) {
      const bar = el('div', 'bar-p');
      const fill = el('i');
      fill.style.transform = `scaleX(${Math.max(0, Math.min(1, value / total)).toFixed(4)})`;
      bar.append(fill);
      wrap.append(bar);
    }
    if (steps.length) {
      const ul = el('ul', 'steps');
      for (const s of steps) {
        const li = el('li');
        li.dataset.state = s.state || 'todo';
        const mark = s.state === 'done' ? '✓' : s.state === 'active' ? '▸' : '·';
        li.append(el('span', 'm', mark), el('span', 'lbl', esc(s.label)), el('span', 'n', esc(s.note || '')));
        ul.append(li);
      }
      wrap.append(ul);
    }
    return wrap;
  },
};
