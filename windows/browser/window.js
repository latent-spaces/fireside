// A small browser: an address bar, back, forward and reload over a framed page.
// The panel's `url` is the start page; the last address you visited is remembered
// in this browser only, so navigating never redraws the window. `remember: false`
// always starts at `url` (a random-article page gives a new one on each reload).
// Sites that refuse to be framed get a notice with a button to open them in a tab.
// Pages may raise their own dialogs (alert, confirm, "leave this page?"); one blocks
// the whole desk until answered, so `dialogs: false` keeps a quiet preview from asking.
const history = new Map();   // panel id -> { list: [url], at: index }
const lastKey = (id) => `fireside:browser:${id}`;

const normalize = (text) => {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^localhost(:\d+)?(\/|$)|^127\.0\.0\.1/.test(t)) return `http://${t}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
};

export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<span class="mk-row"><i class="mk-dot"></i><i class="mk-b" style="flex:1;height:8px;border-radius:99px"></i></span><i class="mk-b" style="height:22px;--c:var(--wall-3)"></i><i class="mk-l" style="width:85%"></i><i class="mk-l" style="width:60%"></i>',
  render(p, { el, esc, request }) {
    const remember = p.remember !== false;
    let saved = null;
    if (remember) try { saved = localStorage.getItem(lastKey(p.id)); } catch {}
    const h = history.get(p.id) || { list: [saved || p.url || 'https://example.com'], at: 0 };
    history.set(p.id, h);
    const dialogs = p.dialogs !== false;

    const wrap = el('div', 'browser');
    const bar = el('form', 'bbar');
    const back = el('button', 'bbtn', '‹'); back.type = 'button'; back.title = 'Back';
    const fwd = el('button', 'bbtn', '›'); fwd.type = 'button'; fwd.title = 'Forward';
    const reload = el('button', 'bbtn', '↻'); reload.type = 'button'; reload.title = 'Reload';
    const addr = el('input', 'baddr'); addr.type = 'text'; addr.spellcheck = false; addr.placeholder = 'Address or search';
    const out = el('button', 'bbtn', '↗'); out.type = 'button'; out.title = 'Open in a browser tab';
    bar.append(back, fwd, reload, addr, out);

    const stage = el('div', 'bstage');
    const notice = el('div', 'bnotice');
    notice.hidden = true;
    wrap.append(bar, stage);

    let frame = null;
    let check = 0;

    const show = (url) => {
      addr.value = url;
      back.disabled = h.at === 0;
      fwd.disabled = h.at >= h.list.length - 1;
      if (remember) try { localStorage.setItem(lastKey(p.id), url); } catch {}

      frame?.remove();
      frame = el('iframe');
      let foreign = false;
      try { foreign = new URL(url).origin !== location.origin; } catch {}
      frame.setAttribute('sandbox', 'allow-scripts allow-forms' + (foreign ? ' allow-same-origin allow-popups allow-presentation' : '')
        + (dialogs ? ' allow-modals' : ''));
      // A frame may write to the clipboard, so a page's own Copy button works. Reading it stays off.
      frame.allow = 'clipboard-write' + (foreign ? '; autoplay; encrypted-media; fullscreen; picture-in-picture' : '');
      if (foreign) frame.allowFullscreen = true;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.title = p.title || 'Browser';
      frame.src = url;
      notice.hidden = true;
      stage.replaceChildren(frame, notice);

      const mine = ++check;
      request('/api/frame-check', { url }).then((r) => {
        if (mine !== check || r.framable !== false) return;
        notice.innerHTML = `<b>${esc(new URL(url).host)} won't open inside a window.</b>
          <span>The site asks browsers not to show it in a frame (${esc(r.reason || 'blocked')}).</span>`;
        const open = el('button', 'bopen', 'Open in a browser tab');
        open.type = 'button';
        open.onclick = () => window.open(url, '_blank', 'noreferrer');
        notice.append(open);
        notice.hidden = false;
      }).catch(() => {});
    };

    const go = (url) => {
      if (!url) return;
      h.list = h.list.slice(0, h.at + 1);
      h.list.push(url);
      h.at = h.list.length - 1;
      show(url);
    };

    bar.addEventListener('submit', (e) => { e.preventDefault(); go(normalize(addr.value)); });
    back.onclick = () => { if (h.at > 0) { h.at--; show(h.list[h.at]); } };
    fwd.onclick = () => { if (h.at < h.list.length - 1) { h.at++; show(h.list[h.at]); } };
    reload.onclick = () => show(h.list[h.at]);
    out.onclick = () => window.open(h.list[h.at], '_blank', 'noreferrer');
    addr.addEventListener('focus', () => addr.select());

    show(h.list[h.at]);
    return wrap;
  },
};
