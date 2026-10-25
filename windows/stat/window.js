export default {
  render(p, { el, esc }) {
    const g = el('div', 'stats');
    for (const it of p.items || []) {
      const d = el('div', 'stat');
      d.append(el('div', 'k', esc(it.label)), el('div', 'v', esc(it.value)));
      if (it.delta) d.append(el('div', 'd', esc(it.delta)));
      g.append(d);
    }
    return g;
  },
};
