const GLYPH = { tool: '▸', prompt: '›', notice: '!', session: '◆' };

function items({ el, esc, store }) {
  return store.activity.slice(-80).map((a) => {
    const li = el('li');
    li.dataset.type = a.type;
    if (a.state) li.dataset.state = a.state;
    const glyph = a.type === 'tool' && a.state === 'done' ? '·' : (GLYPH[a.type] || '·');
    const time = new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.append(el('span', 't', time), el('span', 'x', glyph), el('span', 'l', esc((a.state === 'failed' ? 'Failed · ' : '') + a.label)));
    return li;
  });
}

export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<span class="mk-row"><i class="mk-dot" style="--c:var(--mint)"></i><i class="mk-l" style="width:80%"></i></span><span class="mk-row"><i class="mk-dot" style="--c:var(--lilac)"></i><i class="mk-l" style="width:62%"></i></span><span class="mk-row"><i class="mk-dot" style="--c:var(--mint)"></i><i class="mk-l" style="width:90%"></i></span><span class="mk-row"><i class="mk-dot" style="--c:var(--sun)"></i><i class="mk-l" style="width:54%"></i></span><span class="mk-row"><i class="mk-dot" style="--c:var(--ink-3)"></i><i class="mk-l" style="width:70%"></i></span>',
  render(p, ctx) {
    const ul = ctx.el('ul', 'feed');
    ul.append(...items(ctx));
    return ul;
  },
  // The same list element stays, so its scroll position survives new events.
  update: (ul, row, p, ctx) => ul.replaceChildren(...items(ctx)),
};
