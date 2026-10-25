// The first-run tour: a spotlight that hops from one part of the desk to the next,
// with a card saying what it is. It runs once per machine, after the fire, when an
// agent is connected and everything it points at works. `?tour` in the address
// runs it again, `?notour` holds it back.

// Each stop names what it lights up. A stop whose target is not on the desk is
// left out, rather than pointing at nothing.
const composer = () => document.querySelector('.win[data-id="chat"] .cbar');
const STOPS = [
  { target: () => document.querySelector('.win[data-id="chat"]'), emoji: '💬', title: 'Chat with your agents',
    text: 'Talk to your agent here, in as many chats as you like. It can change the desk too, just by being asked.' },
  { target: () => visible(document.getElementById('launchbar')), emoji: '🚀', title: 'Your shortcuts',
    rect: (bar) => unionRect(bar.querySelectorAll('.licon, #iconsMore, #shortcutBtn')),
    text: 'Each icon opens an app, a website or a window. ＋ adds a new shortcut.' },
  { target: () => visible(document.querySelector('.dockrow')), emoji: '🪟', title: 'Your windows',
    rect: (row) => unionRect(row.querySelectorAll('#dock, #addBtn')),
    text: 'Every window on this desk. Click one to bring it to the front, or to reopen it. ＋ adds a new window.' },
  { target: () => document.querySelector('.win[data-id="chat"] .share') || document.querySelector('.win .share'),
    pad: 5, emoji: '📦', title: 'Share a window',
    text: 'Saves a window’s design as a ZIP to send a friend. Your chats, files and data stay here.' },
  { target: () => document.getElementById('deskBtn'), emoji: '🗂️', title: 'Switch desks',
    text: 'Each project gets its own Fireside. Every one that’s running is listed here, with the ones you stopped lately; click to jump to one or start it again.' },
  // The tour hands over to the newcomer's first question, which arrives with this
  // stop. Otherwise it ends on a plain note.
  { asks: true, target: composer, emoji: '🎉', title: 'You’re all set!',
    text: 'Press send and your agent will look at this project and show you what you can do here.',
    next: 'Let’s go', confetti: true },
  { asks: false, title: 'You’re all set!',
    text: 'Type in Chat to get started.',
    next: 'Let’s go', confetti: true },
];

const visible = (node) => (node && node.getBoundingClientRect().width > 4 ? node : null);

// Bars stretch wider than what is in them; light up only the buttons.
function unionRect(nodes) {
  const rects = [...nodes].filter((n) => !n.hidden).map((n) => n.getBoundingClientRect()).filter((r) => r.width);
  const left = Math.min(...rects.map((r) => r.left)), right = Math.max(...rects.map((r) => r.right));
  const top = Math.min(...rects.map((r) => r.top)), bottom = Math.max(...rects.map((r) => r.bottom));
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

export function shouldTour(machine, connected) {
  const params = new URLSearchParams(location.search);
  return params.has('tour') || (!params.has('notour') && !machine.toured && connected);
}

export function startTour(onDone, ask = null) {
  if (document.querySelector('.tour')) return;
  const offering = !!(ask && composer());
  const stops = STOPS.filter((stop) => (!stop.target || stop.target()) && (stop.asks === undefined || stop.asks === offering));
  const root = document.createElement('div');
  root.className = 'tour';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Fireside tour');
  root.innerHTML = '<div class="tour-hole"></div><div class="tour-card" tabindex="-1"></div>';
  document.body.append(root);
  const hole = root.querySelector('.tour-hole');
  const card = root.querySelector('.tour-card');
  const before = document.activeElement;
  let at = 0, lit = null;

  function finish() {
    onDone();
    if (new URLSearchParams(location.search).has('tour')) history.replaceState(null, '', location.pathname);
    lit?.classList.remove('tour-lit');
    root.classList.add('tour-out');
    removeEventListener('keydown', onKey, true);
    removeEventListener('resize', place);
    setTimeout(() => root.remove(), 260);
    before?.focus?.();
    if (offering) ask();   // leaving early still gets the question
  }

  function go(i) {
    if (i < 0) return;
    if (i >= stops.length) return finish();
    at = i;
    const stop = stops[at];
    if (stop.asks) ask();
    lit?.classList.remove('tour-lit');
    lit = stop.target?.() || null;
    lit?.classList.add('tour-lit');
    const last = at === stops.length - 1;
    const dots = stops.map((_, n) => `<i${n === at ? ' class="on"' : ''}></i>`).join('');
    card.innerHTML = `
      ${lit ? `<span class="tour-emoji">${stop.emoji}</span>` : '<div class="tour-mascot"><span class="boot-tile"><i><b></b><b></b></i></span><span class="boot-shadow"></span></div>'}
      <h2 class="tour-title">${stop.title}</h2>
      <p class="tour-text">${stop.text}</p>
      <div class="tour-foot">
        <span class="tour-dots" aria-hidden="true">${dots}</span>
        ${last ? '' : '<button type="button" class="tour-skip">Skip</button>'}
        ${at > 0 && !last ? '<button type="button" class="tour-back">Back</button>' : ''}
        <button type="button" class="tour-next">${stop.next || 'Next'}</button>
      </div>`;
    card.querySelector('.tour-skip')?.addEventListener('click', finish);
    card.querySelector('.tour-back')?.addEventListener('click', () => go(at - 1));
    card.querySelector('.tour-next').addEventListener('click', () => go(at + 1));
    root.classList.toggle('tour-open', !lit);
    // Restart the card's entrance so every stop arrives rather than just changes.
    card.classList.remove('tour-in');
    void card.offsetWidth;
    card.classList.add('tour-in');
    place();
    card.querySelector('.tour-next').focus({ preventScroll: true });
    if (stop.confetti) confetti(root);
  }

  function place() {
    const stop = stops[at];
    const w = card.offsetWidth, h = card.offsetHeight, gap = 16, m = 12;
    if (!lit) {
      // No target: the hole shrinks to the middle and the card sits there.
      Object.assign(hole.style, { left: `${innerWidth / 2}px`, top: `${innerHeight / 2}px`, width: '0px', height: '0px' });
      Object.assign(card.style, { left: `${(innerWidth - w) / 2}px`, top: `${(innerHeight - h) / 2}px` });
      card.dataset.side = '';
      return;
    }
    const pad = stop.pad ?? 8;
    const r = stop.rect ? stop.rect(lit) : lit.getBoundingClientRect();
    // A tall window would swallow the screen; light up its top, where its title is.
    const hTop = Math.max(m, r.top - pad), hBottom = Math.min(innerHeight - m, r.bottom + pad);
    const box = { left: r.left - pad, top: hTop, width: r.width + pad * 2, height: hBottom - hTop };
    Object.assign(hole.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    const clampX = (x) => Math.max(m, Math.min(x, innerWidth - w - m));
    const clampY = (y) => Math.max(m, Math.min(y, innerHeight - h - m));
    const cx = clampX(box.left + box.width / 2 - w / 2);
    let side, left, top;
    if (box.top + box.height + gap + h < innerHeight - m) { side = 'below'; left = cx; top = box.top + box.height + gap; }
    else if (box.top - gap - h > m) { side = 'above'; left = cx; top = box.top - gap - h; }
    else if (box.left + box.width + gap + w < innerWidth - m) { side = 'right'; left = box.left + box.width + gap; top = clampY(box.top + 24); }
    else { side = 'left'; left = clampX(box.left - gap - w); top = clampY(box.top + 24); }
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
    card.dataset.side = side;
    // The little pointer aims at the target, wherever the card had to be clamped to.
    const aim = side === 'below' || side === 'above'
      ? Math.max(22, Math.min(box.left + box.width / 2 - left, w - 22))
      : Math.max(22, Math.min(box.top + Math.min(box.height / 2, 40) - top, h - 22));
    card.style.setProperty('--aim', `${aim}px`);
  }

  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); finish(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); go(at + 1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); go(at - 1); }
    else if (event.key === 'Tab') {
      // Keep focus inside the card while the tour is up.
      const items = [...card.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      event.preventDefault();
      items[(i + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
    }
  }
  addEventListener('keydown', onKey, true);
  addEventListener('resize', place);
  requestAnimationFrame(() => { root.classList.add('tour-on'); go(0); });
}

function confetti(root) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['var(--accent)', 'var(--mint)', 'var(--lilac)', 'var(--sun)', 'var(--clay)'];
  const burst = document.createElement('div');
  burst.className = 'tour-confetti';
  for (let i = 0; i < 70; i++) {
    const bit = document.createElement('i');
    const angle = Math.random() * Math.PI * 2, dist = 140 + Math.random() * 260;
    bit.style.setProperty('--x', `${Math.cos(angle) * dist}px`);
    bit.style.setProperty('--y', `${Math.sin(angle) * dist * 0.7 - 80}px`);
    bit.style.setProperty('--r', `${Math.random() * 720 - 360}deg`);
    bit.style.background = colors[i % colors.length];
    bit.style.animationDelay = `${Math.random() * 90}ms`;
    if (i % 3 === 0) bit.style.borderRadius = '50%';
    burst.append(bit);
  }
  root.insertBefore(burst, root.querySelector('.tour-card'));
  setTimeout(() => burst.remove(), 1600);
}
