const POLL = 2000;          // how often a window with a `source` reads its file again, while in view

function draw(text, { el, md }, dir = '') {
  const root = el('div', 'md', md(text, { html: true }));
  // Document assets are relative to the project (or to the `source` file's folder),
  // not to the desktop route.
  for (const node of root.querySelectorAll('[href], img[src]')) {
    const attr = node.tagName === 'IMG' ? 'src' : 'href';
    const value = node.getAttribute(attr);
    if (value && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value)) node.setAttribute(attr, '/files/' + dir + value);
  }
  return root;
}

export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<i class="mk-l mk-h"></i><i class="mk-l" style="width:92%"></i><i class="mk-l" style="width:80%"></i><span class="mk-row"><i class="mk-dot" style="width:4px;height:4px"></i><i class="mk-l" style="width:70%"></i></span><span class="mk-row"><i class="mk-dot" style="width:4px;height:4px"></i><i class="mk-l" style="width:56%"></i></span><span class="mk-row"><i class="mk-dot" style="width:4px;height:4px"></i><i class="mk-l" style="width:64%"></i></span>',
  render: (p, ctx) => {
    if (!p.source) return draw(p.body, ctx);
    // A `source` file is read again every few seconds, so the window follows its edits.
    const box = ctx.el('div');
    let last = null, busy = false;
    async function update() {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const res = await fetch('/files/' + encodeURIComponent(p.source), { cache: 'no-store' });
        const text = res.ok ? await res.text() : `*Can't read \`${p.source}\` (${res.status}).*`;
        if (text === last) return;
        last = text;
        box.replaceChildren(draw(text, ctx, p.source.replace(/[^/]*$/, '')));
      } catch { /* the server is restarting; try again next time */ } finally { busy = false; }
    }
    update();
    const timer = setInterval(() => { if (box.isConnected) update(); }, POLL);
    ctx.onDispose(() => clearInterval(timer));
    return box;
  },
};
