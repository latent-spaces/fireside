(() => {
  // Skins: the chat's requests restyle the page, and it remembers the choice.
  // Each skin's face loads only when the skin is worn.
  const FONTS = {
    synthwave: 'Audiowide',
    stardew: 'Pixelify+Sans:wght@500;700',
    vangogh: 'Lora:ital,wght@1,600',
    terminal: 'JetBrains+Mono:wght@400;700',
  };
  const swatches = [...document.querySelectorAll('.skins button')];
  function wear(skin) {
    document.body.dataset.skin = skin;
    swatches.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.skin === skin)));
    const font = FONTS[skin];
    if (font && !document.querySelector(`link[data-font="${skin}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.dataset.font = skin;
      link.href = `https://fonts.googleapis.com/css2?family=${font}&display=swap`;
      document.head.append(link);
    }
  }
  swatches.forEach((b) => b.addEventListener('click', () => {
    wear(b.dataset.skin);
    try { localStorage.setItem('fireside-skin', b.dataset.skin); } catch {}
  }));
  if (document.body.dataset.skin) wear(document.body.dataset.skin);

  // Chat tabs: one conversation per agent.
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function select(tab) {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const n = { ArrowRight: tabs[(i + 1) % tabs.length], ArrowLeft: tabs[(i - 1 + tabs.length) % tabs.length],
        Home: tabs[0], End: tabs[tabs.length - 1] }[e.key];
      if (n) { e.preventDefault(); select(n); n.focus(); }
    });
  });

  // Drag a window by its title bar; it moves from where it sits in the layout,
  // stays on the page, and settles back into place when the layout stacks.
  const WIDE = 900;
  const wins = [...document.querySelectorAll('.win')].filter((w) => w.querySelector('.bar'));
  wins.forEach((w) => {
    const bar = w.querySelector('.bar');
    bar.addEventListener('pointerdown', (e) => {
      if (innerWidth < WIDE || e.button !== 0) return;
      const ox = w._ox || 0, oy = w._oy || 0;
      const r = w.getBoundingClientRect();
      // Where the window sits in the layout, in page coordinates.
      const left = r.left + scrollX - ox, top = r.top + scrollY - oy;
      const maxX = document.documentElement.clientWidth - r.width - left;
      const maxY = document.documentElement.scrollHeight - r.height - top;
      const minY = 52 - top;   // below the menu bar
      const sx = e.clientX - ox, sy = e.clientY - oy;
      bar.setPointerCapture(e.pointerId);
      w.classList.add('lifted');
      const move = (ev) => {
        w._ox = Math.min(maxX, Math.max(-left, ev.clientX - sx));
        w._oy = Math.min(maxY, Math.max(minY, ev.clientY - sy));
        w.style.translate = `${w._ox}px ${w._oy}px`;
      };
      const drop = () => {
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', drop);
        bar.removeEventListener('pointercancel', drop);
        w.classList.remove('lifted');
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', drop);
      bar.addEventListener('pointercancel', drop);
    });
  });
  addEventListener('resize', () => {
    if (innerWidth >= WIDE) return;
    wins.forEach((w) => { w._ox = w._oy = 0; w.style.translate = ''; });
  });

  // Copy buttons.
  document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Select & copy'; }
    setTimeout(() => (b.textContent = 'Copy'), 1600);
  }));

  // Recordings hold still for people who ask for less motion.
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) {
    document.querySelectorAll('video[autoplay]').forEach((v) => { v.removeAttribute('autoplay'); v.pause(); v.controls = true; });
  }

  // Share: the visitor shares a skin or a window through a copy of the app's
  // dialog, then plays the friend: drops the ZIP on their desk, the agent checks
  // it, and saying yes installs it. Nothing is really downloaded, and an
  // installed skin lasts until a reload.
  const swap = document.getElementById('swap');
  const zip = document.getElementById('zip');
  const drop = document.getElementById('drop');
  const talk = document.getElementById('talk');
  const tip = document.getElementById('tip');
  const dialog = document.getElementById('share-dialog');
  const sendDesk = document.getElementById('send-desk');
  const steps = [...document.querySelectorAll('#share-steps li')];
  const kinds = [...swap.querySelectorAll('[data-kind]')].filter((b) => b.tagName === 'BUTTON');
  // The dialog's words and the file's name are the app's own (client/app.js).
  const KINDS = {
    skin: {
      name: 'Terminal', id: 'terminal', icon: '🎨', label: 'skin', ask: 'skin',
      what: 'Your friends get the Terminal skin: its colours and artwork.',
      hover: 'On your own desk, ⇪ appears when you hover a skin.',
      found: `<p><b>What it is:</b> a colour scheme in plain CSS, with no scripts and no commands.</p>
        <ul><li>It loads one font from Google Fonts.</li></ul>`,
      done: '“Terminal” is installed and is now your active skin.',
    },
    window: {
      name: 'Solitaire', id: 'solitaire', icon: '🃏', label: 'window', ask: 'window style',
      what: 'Your friends get the Solitaire window\'s look and code, not what\'s in it on your desk.',
      hover: 'On your own desk, the share button appears when you hover a title bar.',
      found: `<p><b>What it is:</b> a solitaire game in plain HTML, CSS and JavaScript.</p>
        <ul><li>It runs no commands and makes no network requests.</li><li>It saves your game in the browser.</li></ul>`,
      done: '“Solitaire” is installed and open on your desk.',
    },
  };
  let kind = KINDS.window, before = null;
  const file = () => `fireside-${kind.label}-${kind.id}.zip`;
  const message = () => `Here's a Fireside ${kind.label} I like: ${kind.name} ${kind.icon}\n\n`
    + 'To add it, drop the attached ZIP onto your Fireside desk, or click ＋ → Add from file…';
  const chat = (body) => `<div class="fwin" style="--tint-h:320"><div class="fbar"><span class="fdots" aria-hidden="true"><i></i><i></i></span><span class="fico" aria-hidden="true">💬</span><span class="fttl">Chat</span></div>
    <div class="fchat">${body}</div></div>`;
  const asked = () => `<div class="fmsg user"><span class="who">You</span><div class="bub">Install the shared ${kind.label} "${kind.name}" (${kind.id}) that I just added.</div></div>
    <div class="ftool"><b>execute</b> cat .fireside/inbox/${kind.id}/${kind.label === 'skin' ? 'skin' : 'window'}.json</div>`;
  const said = (html) => `<div class="fmsg agent"><span class="who">Claude</span><div class="bub">${html}</div></div>`;
  const SCENES = {
    share: { step: 0, side: 'send', tip: () => kind.hover },
    ready: { step: 1, side: 'send', tip: () => '' },
    sent: { step: 1, side: 'send', tip: () => '<button class="btn" type="button" data-do="send">Send it to a friend</button>' },
    waiting: { step: 2, side: 'receive', html: () => '<p class="hint">Drag the ZIP onto this desk, or click it.</p>' },
    checking: { step: 3, side: 'receive', html: () => chat(asked()) },
    asking: { step: 3, side: 'receive', html: () => chat(`${asked()}${said(`<p>I've checked "${kind.name}" and haven't installed it yet.</p>${kind.found}<p>Do you want it installed, and where?</p>`)}
      <div class="choices"><button type="button" data-do="install">Every project</button><button type="button" data-do="install">This project only</button><button type="button" data-do="skip">Don't install</button></div>`) },
    installed: { step: -1, side: 'receive', html: () => `${kind === KINDS.window ? '<div class="fwin" style="--tint-h:125"><div class="fbar"><span class="fdots" aria-hidden="true"><i></i><i></i></span><span class="fico" aria-hidden="true">🃏</span><span class="fttl">Solitaire</span></div><img src="assets/solitaire-window.jpg" width="614" height="380" alt="" /></div>' : ''}
      ${chat(`${said(kind.done)}<div class="choices"><button type="button" data-do="undo">${kind === KINDS.skin ? 'Take it off' : 'Start again'}</button></div>`)}` },
    skipped: { step: -1, side: 'receive', html: () => chat(`${said('Nothing installed. I\'ve cleared the ZIP from the inbox.')}<div class="choices"><button type="button" data-do="reset">Start again</button></div>`) },
  };
  function scene(name) {
    const s = SCENES[name];
    swap.dataset.state = name;
    swap.dataset.side = s.side;
    swap.dataset.kind = kind.label;
    tip.innerHTML = s.tip ? s.tip() : '';
    talk.innerHTML = s.html ? s.html() : '';
    if (s.side === 'receive') dialog.hidden = true;
    steps.forEach((li, i) => (i === s.step ? li.setAttribute('aria-current', 'step') : li.removeAttribute('aria-current')));
  }
  function openDialog(anchor) {
    dialog.innerHTML = `<p class="cat-head">Share</p><div class="upd-row"><span class="upd-name">${kind.icon} Want to share this ${kind.ask}?</span>
      <p class="upd-what">${kind.what}</p><button class="upd-go" type="button" data-do="download">Download ZIP</button></div>
      <p class="cat-head">Send it with this</p><p class="share-msg"></p><button class="upd-go share-copy" type="button" data-do="copy">Copy message</button>`;
    dialog.querySelector('.share-msg').textContent = message();
    dialog.hidden = false;
    // Beside the button when there is room, always inside the desk, as in the app.
    const r = anchor.getBoundingClientRect(), d = sendDesk.getBoundingClientRect();
    dialog.style.left = `${Math.max(8, Math.min(r.right - d.left - dialog.offsetWidth, d.width - dialog.offsetWidth - 8))}px`;
    dialog.style.top = `${Math.max(8, Math.min(r.bottom - d.top + 6, d.height - dialog.offsetHeight - 8))}px`;
    dialog.querySelector('.upd-go').focus({ preventScroll: true });
  }
  function choose(next) {
    kind = next; dialog.hidden = true;
    kinds.forEach((b) => b.setAttribute('aria-pressed', String(KINDS[b.dataset.kind] === kind)));
    document.getElementById('friend-msg').textContent = message();
    document.getElementById('zip-name').textContent = file();
    document.getElementById('zip-kind').textContent = kind === KINDS.skin ? 'Skin' : 'Window';
    zip.setAttribute('aria-label', `${file()}. Drop it on your desk`);
    scene('share');
  }
  // A skin's wider face reflows the page above; keep this section under the reader.
  function steady(change) {
    const top = swap.getBoundingClientRect().top;
    change();
    scrollBy({ top: swap.getBoundingClientRect().top - top, behavior: 'instant' });
  }
  const focusChoice = () => talk.querySelector('button')?.focus({ preventScroll: true });
  const again = () => {
    reached = still; choose(kind);
    swap.querySelector(kind === KINDS.skin ? '.skinshare' : '.fshare').focus({ preventScroll: true });
  };
  function land() {
    drop.classList.remove('over');
    scene('checking');
    setTimeout(() => { scene('asking'); focusChoice(); }, still ? 0 : 1100);
  }
  function toDesk() {
    if (still) return land();
    const from = zip.getBoundingClientRect(), to = drop.getBoundingClientRect();
    const x = to.left + 14 - from.left, y = to.top + 40 - from.top;
    zip.animate([{ transform: 'none' }, { transform: `translate(${x * .6}px, ${y * .6}px) rotate(4deg) scale(1.06)`, offset: .6 }, { transform: `translate(${x}px, ${y}px) scale(.7)`, opacity: .4 }],
      { duration: 480, easing: 'cubic-bezier(.3,0,.2,1)' }).finished.then(land);
  }

  // Until the visitor reaches for the ZIP, a ghost of it shows where it goes.
  let ghost = null, reached = still, showing = false;
  function stopBeckon() {
    reached = true;
    drop.classList.remove('over');
    ghost?.remove();
  }
  function beckon() {
    if (reached || !showing || swap.dataset.state !== 'waiting' || ghost?.isConnected) return;
    ghost = zip.cloneNode(true);
    ghost.removeAttribute('id');
    ghost.classList.add('ghost');
    ghost.inert = true;
    ghost.style.left = `${zip.offsetLeft}px`; ghost.style.top = `${zip.offsetTop}px`;
    swap.append(ghost);
    const x = drop.offsetLeft + drop.offsetWidth / 2 - zip.offsetLeft - zip.offsetWidth / 2;
    const y = drop.offsetTop + drop.offsetHeight / 2 - zip.offsetTop - zip.offsetHeight / 2 - 40;
    const flight = ghost.animate([{ opacity: 0, transform: 'none' }, { opacity: .9, offset: .15 }, { opacity: .9, offset: .75 }, { opacity: 0, transform: `translate(${x}px, ${y}px)` }],
      { duration: 1500, easing: 'cubic-bezier(.45,0,.3,1)' });
    setTimeout(() => { if (!reached) drop.classList.add('over'); }, 900);
    flight.onfinish = () => {
      ghost.remove();
      drop.classList.remove('over');
      setTimeout(beckon, 2200);
    };
  }
  new IntersectionObserver(([entry]) => {
    showing = entry.isIntersecting;
    beckon();
  }, { threshold: .5 }).observe(swap);
  ['pointerenter', 'pointerdown', 'focus'].forEach((type) => zip.addEventListener(type, stopBeckon));

  // Dragging and clicking share one button; a press that moved is a drag.
  let moved = false;
  zip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    moved = false;
    zip.setPointerCapture(e.pointerId);
    const over = (ev) => {
      const r = drop.getBoundingClientRect();
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    };
    const move = (ev) => {
      moved ||= Math.hypot(ev.clientX - sx, ev.clientY - sy) > 6;
      if (!moved) return;
      zip.classList.add('held');
      zip.style.translate = `${ev.clientX - sx}px ${ev.clientY - sy}px`;
      drop.classList.toggle('over', over(ev));
    };
    const up = (ev) => {
      zip.removeEventListener('pointermove', move);
      zip.removeEventListener('pointerup', up);
      zip.removeEventListener('pointercancel', up);
      zip.classList.remove('held');
      zip.style.translate = '';
      if (moved && ev.type === 'pointerup' && over(ev)) land();
      drop.classList.remove('over');
    };
    zip.addEventListener('pointermove', move);
    zip.addEventListener('pointerup', up);
    zip.addEventListener('pointercancel', up);
  });
  zip.addEventListener('click', () => { if (!moved) toDesk(); moved = false; });

  swap.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-do]');
    const action = button?.dataset.do;
    if (action === 'kind') { reached = still; choose(KINDS[button.dataset.kind]); }
    if (action === 'open') { scene('ready'); openDialog(button); }
    if (action === 'download') {
      button.textContent = 'Downloaded ✓';
      scene('sent');
      tip.querySelector('button').focus({ preventScroll: true });
    }
    if (action === 'copy') {
      try { await navigator.clipboard.writeText(message()); button.textContent = 'Copied ✓'; } catch { button.textContent = 'Select & copy'; }
    }
    if (action === 'send') {
      scene('waiting'); beckon();
      if (!e.detail) zip.focus({ preventScroll: true });   // a keyboard's "click" has no count
    }
    if (action === 'install') {
      if (kind === KINDS.skin) {
        before = document.body.dataset.skin || 'house';
        steady(() => wear('terminal'));
      }
      scene('installed'); focusChoice();
    }
    if (action === 'skip') { scene('skipped'); focusChoice(); }
    if (action === 'undo') {
      if (kind === KINDS.skin) steady(() => wear(before));
      again();
    }
    if (action === 'reset') again();
  });
  // Choosing another look from the chat takes the skin off, so the story starts over.
  swatches.forEach((b) => b.addEventListener('click', () => {
    if (swap.dataset.state === 'installed' && kind === KINDS.skin) { reached = still; choose(kind); }
  }));
  choose(KINDS.window);
})();
