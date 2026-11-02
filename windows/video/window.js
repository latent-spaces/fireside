// A player for one video (`src`) or a playlist (`items`). Project files and direct
// links play in a <video>; YouTube and Vimeo links play in the site's own embed.
// Where you stopped in each file or YouTube list is remembered in this browser only, so a redraw
// or a reload picks up there, and a playlist moves on when a video ends.
const playing = new Map();   // panel id -> index in the playlist
const posKey = (src) => `fireside:video:${src}`;

const embed = (src) => {
  const playlist = src.match(/^https?:\/\/(?:www\.|m\.)?youtube\.com\/playlist\?(?:.*&)?list=([\w-]+)/);
  if (playlist) return `https://www.youtube.com/embed/videoseries?list=${playlist[1]}`;
  const yt = src.match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) {
    const list = src.match(/[?&]list=([\w-]+)/)?.[1];
    return `https://www.youtube.com/embed/${yt[1]}${list ? `?list=${list}` : ''}`;
  }
  const vimeo = src.match(/^https?:\/\/(?:www\.)?vimeo\.com\/(\d+)/);
  return vimeo ? `https://player.vimeo.com/video/${vimeo[1]}` : null;
};

// A YouTube frame opens at the saved video and second, and reports back as it plays.
const YOUTUBE = 'https://www.youtube.com';
const youtubeURL = (frameURL, key) => {
  const url = new URL(frameURL);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
  if (saved?.video) url.pathname = `/embed/${saved.video}`;
  if (saved?.time >= 1) url.searchParams.set('start', Math.floor(saved.time));
  url.searchParams.set('enablejsapi', 1);
  url.searchParams.set('origin', location.origin);
  return url.href;
};

const nameOf = (it) => it.caption || decodeURIComponent(it.src.split(/[?#]/)[0].split('/').pop()) || it.src;

export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<span class="mk-b mk-edge" style="flex:1;display:grid;place-items:center;border-radius:0;--c:#2A2433"><i style="width:0;height:0;border-left:11px solid #fff;border-top:7px solid transparent;border-bottom:7px solid transparent;opacity:.85"></i></span>',
  render(p, { el, esc, fileURL, onDispose }) {
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

    let unfollow = null;
    onDispose(() => unfollow?.());

    // YouTube's player only starts reporting once it's asked to.
    function follow(frame, key) {
      let state = -1;
      let now = {};
      const onMessage = (e) => {
        if (e.source !== frame.contentWindow || e.origin !== YOUTUBE) return;
        let info = null;
        try { info = JSON.parse(e.data).info; } catch {}
        if (!info) return;
        state = info.playerState ?? state;
        if (info.videoData?.video_id) now.video = info.videoData.video_id;
        if (typeof info.currentTime === 'number') now.time = info.currentTime;
        // Only while playing: a player waiting at its start time reports 0.
        if (state === 1 && now.video) try { localStorage.setItem(key, JSON.stringify(now)); } catch {}
      };
      addEventListener('message', onMessage);
      frame.addEventListener('load', () => frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', channel: 'widget' }), YOUTUBE));
      return () => removeEventListener('message', onMessage);
    }

    function show(i, autoplay) {
      unfollow?.();
      unfollow = null;
      const it = items[i];
      playing.set(p.id, i);
      rows.forEach((row, n) => row.classList.toggle('on', n === i));

      const frameURL = embed(it.src);
      if (frameURL) {
        const frame = el('iframe');
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation');
        frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write';
        frame.allowFullscreen = true;
        frame.referrerPolicy = 'strict-origin-when-cross-origin';
        frame.title = nameOf(it);
        const key = posKey(it.src);
        const src = frameURL.startsWith(YOUTUBE) ? youtubeURL(frameURL, key) : frameURL;
        frame.src = src + (autoplay ? `${src.includes('?') ? '&' : '?'}autoplay=1` : '');
        if (src !== frameURL) unfollow = follow(frame, key);
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
