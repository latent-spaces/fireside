// Pictures and clips, laid out by how many there are: one fills the window, two sit
// side by side for a before and after, more wrap into rows that keep each picture's
// own shape. A click opens the viewer, which steps through them with the arrow keys.
// A picture that will not load says why, in its own place.
const VIDEO = /\.(mp4|webm|mov|m4v)([?#]|$)/i;

// Why a file did not load, asked of the server once the picture has failed.
async function reason(src) {
  if (!src.startsWith('/files/')) return 'Could not load this link';
  const status = await fetch(src, { method: 'HEAD' }).then((r) => r.status, () => 0);
  return { 403: 'In a private folder', 404: 'File not found' }[status] || 'Could not load';
}

const nameOf = (src) => decodeURIComponent(String(src).split(/[?#]/)[0].split('/').pop() || src);

function viewer(el, esc, items, start) {
  let at = start;
  const box = el('div', 'gview');
  box.tabIndex = -1;
  const stage = el('div', 'gstage');
  const cap = el('div', 'gcap');
  const prev = el('button', 'gnav prev', '‹'); prev.type = 'button'; prev.title = 'Previous (←)';
  const next = el('button', 'gnav next', '›'); next.type = 'button'; next.title = 'Next (→)';
  const close = el('button', 'gclose', '×'); close.type = 'button'; close.title = 'Close (Esc)';
  box.append(stage, cap, close);
  if (items.length > 1) box.append(prev, next);
  const show = () => {
    const it = items[at];
    const media = el(it.video ? 'video' : 'img');
    media.src = it.url;
    if (it.video) { media.controls = true; media.autoplay = true; media.loop = true; }
    else media.alt = it.caption || it.name;
    stage.replaceChildren(media);
    cap.innerHTML = `<span class="gt">${esc(it.caption || it.name)}</span>`
      + (items.length > 1 ? `<span class="gc">${at + 1} / ${items.length}</span>` : '')
      + `<a class="go" href="${esc(it.url)}" target="_blank" rel="noreferrer">Open original ↗</a>`;
  };
  const step = (d) => { at = (at + d + items.length) % items.length; show(); };
  const shut = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') shut();
    else if (e.key === 'ArrowLeft' && items.length > 1) step(-1);
    else if (e.key === 'ArrowRight' && items.length > 1) step(1);
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  prev.onclick = () => step(-1);
  next.onclick = () => step(1);
  close.onclick = shut;
  box.addEventListener('click', (e) => { if (e.target === box || e.target === stage) shut(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
  show();
  box.focus();
  return shut;
}

export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<span class="mk-grid" style="grid-template-columns:repeat(3,1fr)"><i class="mk-b" style="--c:var(--wall-1)"></i><i class="mk-b" style="--c:var(--wall-2)"></i><i class="mk-b" style="--c:var(--wall-3)"></i><i class="mk-b" style="--c:var(--wall-4)"></i><i class="mk-b" style="--c:var(--wall-3)"></i><i class="mk-b" style="--c:var(--wall-1)"></i></span>',
  render(p, { el, esc, fileURL, onDispose }) {
    // A redraw means the panel changed, maybe to a picture saved over an old one
    // under the same name; a fresh stamp keeps the browser from showing the old copy.
    const stamp = Date.now().toString(36);
    const items = (p.items || []).filter((it) => it?.src).map((it) => {
      const url = fileURL(it.src);
      const fresh = url.startsWith('/files/') ? url + (url.includes('?') ? '&' : '?') + 'r=' + stamp : url;
      return { ...it, url: fresh, video: VIDEO.test(it.src), name: nameOf(it.src) };
    });
    if (!items.length) return el('div', 'md', '<p>No pictures yet.</p>');

    const g = el('div', 'gal ' + (items.length === 1 ? 'one' : items.length === 2 ? 'two' : 'many'));
    let shut = null;
    onDispose(() => shut?.());
    items.forEach((it, i) => {
      const fig = el('figure', 'gitem');
      const frame = el('button', 'gframe');
      frame.type = 'button';
      frame.title = it.caption ? `${it.caption} — ${it.name}` : it.name;
      const media = el(it.video ? 'video' : 'img');
      if (it.video) { media.muted = true; media.loop = true; media.playsInline = true; media.preload = 'metadata'; }
      else { media.alt = it.caption || it.name; media.decoding = 'async'; }
      // Rows give each picture the width its shape asks for, once it is known.
      const shape = (w, h) => { if (w && h) fig.style.setProperty('--r', (w / h).toFixed(3)); };
      media.addEventListener(it.video ? 'loadedmetadata' : 'load', () => shape(media.videoWidth ?? media.naturalWidth, media.videoHeight ?? media.naturalHeight));
      media.addEventListener('error', async () => {
        fig.classList.add('broken');
        frame.disabled = true;
        frame.replaceChildren(el('span', 'gerr', `<b>${esc(await reason(it.url))}</b><span>${esc(String(it.src).split(/[?#]/)[0])}</span>`));
      });
      media.src = it.url;
      frame.append(media);
      if (it.video) {
        frame.append(el('span', 'gplay', '▶'));
        frame.addEventListener('mouseenter', () => media.play().catch(() => {}));
        frame.addEventListener('mouseleave', () => media.pause());
      }
      frame.addEventListener('click', () => {
        const ok = items.filter((_, k) => !g.children[k]?.classList.contains('broken'));
        shut = viewer(el, esc, ok, Math.max(0, ok.indexOf(it)));
      });
      fig.append(frame);
      if (it.caption) fig.append(el('figcaption', null, esc(it.caption)));
      g.append(fig);
    });
    return g;
  },
};
