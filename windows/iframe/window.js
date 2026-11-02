export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<span class="mk-row" style="justify-content:space-between"><i class="mk-b" style="width:16px;height:6px;--c:var(--accent)"></i><span class="mk-row" style="width:45%"><i class="mk-l" style="flex:1"></i><i class="mk-l" style="flex:1"></i><i class="mk-l" style="flex:1"></i></span></span><i class="mk-b" style="height:24px;--c:var(--wall-2)"></i><span class="mk-row"><i class="mk-l" style="width:48%"></i><i class="mk-l" style="width:48%"></i></span>',
  render(p, { el }) {
    const f = el('iframe');
    // A page from another site keeps its own origin, so players like YouTube can run and go
    // fullscreen; that origin can't reach the desk. A page served by the desk itself stays opaque.
    let foreign = false;
    try { foreign = new URL(p.url, location.href).origin !== location.origin; } catch {}
    f.setAttribute('sandbox', 'allow-scripts allow-forms' + (foreign ? ' allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation' : ''));
    // A frame may write to the clipboard, so a page's own Copy button works. Reading it stays off.
    f.allow = 'clipboard-write' + (foreign ? '; autoplay; encrypted-media; fullscreen; picture-in-picture' : '');
    if (foreign) f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.title = p.title || p.id;
    f.src = p.url;
    return f;
  },
};
