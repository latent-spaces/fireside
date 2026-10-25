// HTML written for one moment. It runs in a sandboxed frame that wears the
// desk's theme; data-prompt buttons prepare a prompt in the composer.

const POLL = 2000;          // how often a window with a `file` reads it again, while in view

/** The desk's look, as the frame needs it: every custom property in force, and
 *  whether the skin calls itself light or dark. The frame cannot inherit either
 *  across the sandbox boundary, so it is handed both — once in the document it
 *  opens with, and again by message whenever the skin changes. The frame links
 *  app.css, whose light and dark defaults are written as `:root:not(...)`; the
 *  doubled `:root` these land under is what keeps them from outranking a skin. */
function deskTheme() {
  const computed = getComputedStyle(document.documentElement);
  const vars = [...computed].filter((name) => name.startsWith('--'))
    .map((name) => `${name}:${computed.getPropertyValue(name)};`).join('').replace(/</g, '');
  return { vars, base: document.documentElement.dataset.theme || '' };
}

/** Hand the frame the theme it should be wearing now. */
const dress = (frame) => frame.contentWindow?.postMessage({ type: 'fireside-theme', ...deskTheme() }, '*');

export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<span class="mk-grid" style="grid-template-columns:repeat(4,1fr)"><i class="mk-b" style="border-radius:50%;aspect-ratio:1;align-self:center;--c:var(--accent)"></i><i class="mk-b" style="border-radius:50%;aspect-ratio:1;align-self:center;--c:var(--sun)"></i><i class="mk-b" style="border-radius:50%;aspect-ratio:1;align-self:center;--c:var(--mint)"></i><i class="mk-b" style="border-radius:50%;aspect-ratio:1;align-self:center;--c:var(--lilac)"></i><i class="mk-b" style="border-radius:50%;aspect-ratio:1;align-self:center;--c:var(--lilac)"></i><i class="mk-b" style="border-radius:50%;aspect-ratio:1;align-self:center;--c:var(--accent)"></i><i class="mk-b" style="border-radius:50%;aspect-ratio:1;align-self:center;--c:var(--sun)"></i><i class="mk-b" style="border-radius:50%;aspect-ratio:1;align-self:center;--c:var(--mint)"></i></span>',
  // The skin changed under an open frame: re-dress it, rather than rebuild it.
  update: (frame) => dress(frame),

  render(p, { el, esc, fileURL, onDispose }) {
    const frame = el('iframe', 'panel-html');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.allow = 'clipboard-write';   // so a Copy button in the panel works
    frame.title = p.title || p.id;
    const show = (html) => {
      const { vars, base } = deskTheme();
      frame.srcdoc = `<!doctype html><html data-theme="${base}"><head><base href="${esc(location.origin + '/files/')}">
        <link rel="stylesheet" href="${esc(location.origin + '/app.css')}">
        <style id="deskTheme">:root:root{${vars}}</style>
        <style>html,body{height:auto;overflow:auto}body{padding:12px;background:var(--surface)}</style>
        </head><body>${html}<script>
        addEventListener('message', (event) => {
          if (event.data?.type !== 'fireside-theme') return;
          document.getElementById('deskTheme').textContent = ':root:root{' + event.data.vars + '}';
          if (event.data.base) document.documentElement.dataset.theme = event.data.base;
          else delete document.documentElement.dataset.theme;
        });
        document.addEventListener('click', (event) => {
          const button = event.target.closest('[data-prompt]');
          if (!button) return;
          event.preventDefault();
          parent.postMessage({type:'fireside-prompt',prompt:button.dataset.prompt,label:button.dataset.label}, '*');
        });
        const wheelScale = (event) => event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? innerHeight : 1;
        const canScroll = (target, dx, dy) => {
          for (let node = target instanceof Element ? target : null;
            node && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node);
            const y = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight
              && ((dy < 0 && node.scrollTop > 0) || (dy > 0 && node.scrollTop + node.clientHeight < node.scrollHeight));
            const x = /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth
              && ((dx < 0 && node.scrollLeft > 0) || (dx > 0 && node.scrollLeft + node.clientWidth < node.scrollWidth));
            if (x || y) return true;
          }
          return false;
        };
        document.addEventListener('wheel', (event) => {
          if (event.ctrlKey || canScroll(event.target, event.deltaX, event.deltaY)) return;
          const scale = wheelScale(event);
          const dx = event.deltaX * scale;
          const dy = event.deltaY * scale;
          const root = document.scrollingElement;
          const canMove = root && ((dy < 0 && root.scrollTop > 0)
            || (dy > 0 && root.scrollTop + innerHeight < root.scrollHeight)
            || (dx < 0 && root.scrollLeft > 0)
            || (dx > 0 && root.scrollLeft + innerWidth < root.scrollWidth));
          if (!canMove) return;
          event.preventDefault();
          scrollBy({left:dx,top:dy,behavior:'auto'});
        }, {passive:false});
        <\/script></body></html>`;
    };
    // A frame that was still loading when the skin changed missed the message;
    // dressing it on load costs nothing and closes that window.
    frame.addEventListener('load', () => dress(frame));
    show(p.html || '');
    if (!p.file) return frame;
    // The file is read again every few seconds, so the window follows its edits;
    // the frame is redrawn only when the text changed, so a live preview keeps its state.
    let last = null, busy = false;
    async function update(first) {
      if (busy || (!first && document.visibilityState !== 'visible')) return;
      busy = true;
      try {
        const response = await fetch(fileURL('.fireside/panels/' + p.file), { cache: 'no-store' });
        const text = response.ok ? await response.text() : null;
        if (text === null && (p.html || last !== null)) return;   // keep what is showing
        const html = text ?? esc('Panel file not found');
        if (html === last) return;
        last = html;
        show(html);
      } catch { /* the server is restarting; try again next time */ } finally { busy = false; }
    }
    update(true);   // the first read happens even out of view, so the window never opens empty
    const timer = setInterval(() => { if (frame.isConnected) update(); }, POLL);
    onDispose(() => clearInterval(timer));
    return frame;
  },
};
