// A player for one video (`src`) or a playlist (`items`). Project files and direct
// links play in a <video>; YouTube and Vimeo links play in the site's own embed.
// Where you stopped in each file is remembered in this browser only, so a redraw
// or a reload picks up there, and a playlist moves on when a video ends.
const playing = new Map();   // panel id -> index in the playlist
const posKey = (src) => `fireside:video:${src}`;

const embed = (src) => {
  const yt = src.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const vimeo = src.match(/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)/);
  return vimeo ? `https://player.vimeo.com/video/${vimeo[1]}` : null;
};

const nameOf = (it) => it.caption || decodeURIComponent(it.src.split(/[?#]/)[0].split('/').pop()) || it.src;

export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<span class="mk-b mk-edge" style="flex:1;display:grid;place-items:center;border-radius:0;--c:#2A2433"><i style="width:0;height:0;border-left:11px solid #fff;border-top:7px solid transparent;border-bottom:7px solid transparent;opacity:.85"></i></span>',
  render(p, { el, esc, fileURL }) {
    const items = (p.items?.length ? p.items : [{ src: p.src }]).filter((it) => typeof it?.src === 'string' && it.src);
    const wrap = el('div', 'vid');
    if (!items.length) {
      wrap.append(el('div', 'vnote', 'No video yet. Give this window a <code>src</code> or a list of <code>items</code>.'));
      return wrap;
    }

    const stage = el('div', 'vstage');
    wrap.append(stage);
    const rows = items.map((it, i) => {
      const row = el('button', 'vrow', `<span class="vnum">${i + 1}</span><span class="vname">${esc(nameOf(it))}</span>`);
      row.type = 'button';
      row.title = it.src;
      row.onclick = () => show(i, true);
      return row;
    });
    if (items.length > 1) {
      const list = el('div', 'vlist');
      list.append(...rows);
      wrap.append(list);
    }

    function show(i, autoplay) {
      const it = items[i];
      playing.set(p.id, i);
      rows.forEach((row, n) => row.classList.toggle('on', n === i));

      const frameURL = embed(it.src);
      if (frameURL) {
        const frame = el('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation');
        frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write';
        frame.allowFullscreen = true;
        frame.referrerPolicy = 'strict-origin-when-cross-origin';
        frame.title = nameOf(it);
        frame.src = frameURL + (autoplay ? '?autoplay=1' : '');
        stage.replaceChildren(frame);
        return;
      }

      const video = el('video');
      const key = posKey(it.src);
      video.controls = true;
      video.playsInline = true;
      video.autoplay = autoplay;
      video.loop = !!p.loop && items.length === 1;
      if (it.poster) video.poster = fileURL(it.poster);
      video.addEventListener('loadedmetadata', () => {
        let t = 0;
        try { t = Number(localStorage.getItem(key)); } catch {}
        if (t > 0 && t < video.duration - 2) video.currentTime = t;
      });
      video.addEventListener('timeupdate', () => {
        // A closed or redrawn window drops its player, which would otherwise play on unseen.
        if (!video.isConnected) return video.pause();
        try { localStorage.setItem(key, video.currentTime); } catch {}
      });
      video.addEventListener('ended', () => {
        try { localStorage.removeItem(key); } catch {}
        if (i < items.length - 1) show(i + 1, true);
      });
      video.addEventListener('error', () => {
        stage.replaceChildren(el('div', 'vnote', `<b>${esc(nameOf(it))} won't play.</b>
          <span>The file is missing, or in a format this browser can't decode.</span>`));
      });
      video.src = fileURL(it.src);
      stage.replaceChildren(video);
    }

    show(Math.min(playing.get(p.id) || 0, items.length - 1), false);
    return wrap;
  },
};
