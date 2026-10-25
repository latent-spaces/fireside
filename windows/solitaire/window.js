// A game for the wait. It keeps its own state in the browser (game.js), and
// loads only when the window opens.
export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<span class="mk-row" style="gap:3px"><i class="mk-b" style="flex:1;height:20px;background:var(--surface);border:1px solid var(--line)"></i><i class="mk-b" style="flex:1;height:20px;background:var(--surface);border:1px solid var(--line)"></i><i class="mk-b" style="flex:1;height:20px;background:var(--surface);border:1px solid var(--line)"></i><i class="mk-b" style="flex:1;height:20px;background:var(--surface);border:1px solid var(--line)"></i></span><span class="mk-row" style="gap:3px;align-items:flex-start;flex:1"><i class="mk-b" style="flex:1;height:30px;--c:var(--accent)"></i><i class="mk-b" style="flex:1;height:22px;--c:var(--lilac)"></i><i class="mk-b" style="flex:1;height:34px;--c:var(--accent)"></i><i class="mk-b" style="flex:1;height:18px;--c:var(--lilac)"></i></span>',
  render(p, { el }) {
    const n = el('div', 'sol');
    import('./game.js').then(({ mount }) => { if (n.isConnected) mount(n); }).catch(() => { n.textContent = 'Could not load solitaire.'; });
    return n;
  },
};
