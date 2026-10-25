// Klondike solitaire for a Fireside window: something to do while Claude thinks.
// Written for Fireside, no dependencies. Draw one, unlimited passes through the
// stock. Click a card to pick it up, click where it goes; click it twice to send
// it home. Right-click the felt to fold: every card that can go home does,
// the way the Windows original did it. The game lives in this browser, so it survives reloads.

const KEY = 'fireside-solitaire';
const SUITS = ['♠', '♥', '♦', '♣'];
const RANK = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const red = (s) => s === 1 || s === 2;

function deal() {
  const deck = [];
  for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) deck.push({ s, r, up: false });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const tableau = [];
  for (let c = 0; c < 7; c++) {
    const col = deck.splice(0, c + 1);
    col[c].up = true;
    tableau.push(col);
  }
  return { stock: deck, waste: [], found: [[], [], [], []], tableau, moves: 0, won: false };
}

function load() {
  try {
    const g = JSON.parse(localStorage.getItem(KEY));
    if (g?.tableau?.length === 7 && g.found?.length === 4) return g;
  } catch {}
  return null;
}
const save = (g) => { try { localStorage.setItem(KEY, JSON.stringify(g)); } catch {} };

const node = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const button = (label, fn) => {
  const b = node('button', null, label);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
};

/** Card size and spacing for a board of W×H. */
function metrics(W, H) {
  const gap = Math.max(5, Math.round(W * 0.014));
  const cw = Math.max(18, Math.min((W - gap * 8) / 7, (H - gap * 3) / 1.4 / 2.3));
  return { gap, cw, ch: cw * 1.4, x: (c) => gap + c * (cw + gap) };
}

export function mount(root) {
  let game = load() || deal();
  let undo = [];
  let sel = null;                       // { pile: 'waste' | 'found' | 'tab', col, idx }
  let last = { key: '', at: 0 };        // for telling a second click from a new one
  let party = null;                     // the win celebration while it plays: { stop }
  let folding = null;                   // the timer for the next card of a fold

  const bar = node('div', 'sol-bar');
  const undoBtn = button('Undo', () => {
    if (!undo.length) return;
    stopFold();
    game = JSON.parse(undo.pop());
    sel = null;
    commit();
  });
  const newGame = () => { stopFold(); game = deal(); undo = []; sel = null; commit(); };
  const count = node('span', 'sol-count');
  bar.append(button('New game', newGame), undoBtn, count);
  const board = node('div', 'sol-board');
  root.replaceChildren(bar, board);

  board.addEventListener('click', () => { if (sel) { sel = null; draw(); } });
  board.addEventListener('contextmenu', (e) => { e.preventDefault(); fold(); });
  // Touching the cards mid-fold takes the game back.
  board.addEventListener('pointerdown', (e) => { if (e.button === 0) stopFold(); }, true);

  // Resizing the window re-lays the cards. draw() measures for itself, so a
  // click redraws correctly even where resize callbacks are held back.
  const ro = new ResizeObserver(() => {
    if (!root.isConnected) { ro.disconnect(); party?.stop(); stopFold(); return; }
    draw();
  });
  ro.observe(board);

  // --- rules ---------------------------------------------------------------

  const snapshot = () => { undo.push(JSON.stringify(game)); if (undo.length > 300) undo.shift(); };

  function commit() {
    const was = game.won;
    game.won = game.found.every((f) => f.length === 13);
    save(game);
    if (game.won && !was) celebrate();
    else if (!game.won) party?.stop(false);
    draw();
  }

  function moving(from) {
    if (from.pile === 'waste') return game.waste.slice(-1);
    if (from.pile === 'found') return game.found[from.col].slice(-1);
    return game.tableau[from.col].slice(from.idx);
  }

  function legal(cards, dest) {
    const c = cards[0];
    if (!c || !c.up) return false;
    if (dest.pile === 'found') {
      if (cards.length !== 1) return false;
      const f = game.found[c.s];
      return f.length ? f[f.length - 1].r === c.r - 1 : c.r === 1;
    }
    const col = game.tableau[dest.col];
    const top = col[col.length - 1];
    if (!top) return c.r === 13;
    return top.up && red(top.s) !== red(c.s) && top.r === c.r + 1;
  }

  function tryMove(from, dest, record = true) {
    if (from.pile === dest.pile && (from.pile === 'found' || from.col === dest.col)) return false;
    const cards = moving(from);
    if (!legal(cards, dest)) return false;
    if (record) snapshot();
    if (from.pile === 'waste') game.waste.pop();
    else if (from.pile === 'found') game.found[from.col].pop();
    else {
      const col = game.tableau[from.col];
      col.splice(from.idx);
      if (col.length && !col[col.length - 1].up) col[col.length - 1].up = true;
    }
    // Foundations are kept one per suit, whichever pile was clicked.
    if (dest.pile === 'found') game.found[cards[0].s].push(cards[0]);
    else game.tableau[dest.col].push(...cards);
    game.moves++;
    sel = null;
    commit();
    return true;
  }

  function sendHome(w) {
    if (w.pile === 'found') return false;
    if (w.pile === 'tab' && w.idx !== game.tableau[w.col].length - 1) return false;
    return tryMove(w, { pile: 'found', col: 0 });
  }

  // Fast fold: send every card that can go home, one after another, as a single
  // undo step. Each move can free the card under it, so look again after each.
  function homeable() {
    const home = { pile: 'found', col: 0 };
    if (legal(game.waste.slice(-1), home)) return { pile: 'waste' };
    for (let c = 0; c < 7; c++) {
      const idx = game.tableau[c].length - 1;
      if (legal(game.tableau[c].slice(idx), home)) return { pile: 'tab', col: c, idx };
    }
    return null;
  }

  function fold() {
    if (folding || party || game.won || !homeable()) return;
    snapshot();
    sel = null;
    const step = () => {
      const w = homeable();
      folding = w && tryMove(w, { pile: 'found', col: 0 }, false) ? setTimeout(step, 70) : null;
    };
    step();
  }

  function stopFold() { clearTimeout(folding); folding = null; }

  function drawStock() {
    if (!game.stock.length && !game.waste.length) return;
    snapshot();
    if (game.stock.length) {
      const c = game.stock.pop();
      c.up = true;
      game.waste.push(c);
    } else {
      game.stock = game.waste.reverse().map((c) => ({ ...c, up: false }));
      game.waste = [];
    }
    game.moves++;
    sel = null;
    commit();
  }

  const cardAt = (w) => (w.pile === 'tab' ? game.tableau[w.col][w.idx] : moving(w)[0]);
  const same = (a, b) => a && b && a.pile === b.pile && a.col === b.col && a.idx === b.idx;

  function clickCard(w) {
    // The board is redrawn after every click, so a real dblclick never lands
    // on the same element twice. Count a quick repeat on one card instead.
    const key = `${w.pile}:${w.col}:${w.idx}`, now = Date.now();
    const twice = key === last.key && now - last.at < 380;
    last = { key, at: now };
    if (twice) { sel = null; if (!sendHome(w)) draw(); return; }

    const card = cardAt(w);
    if (!card) return;
    if (!card.up) {
      const col = game.tableau[w.col];
      if (w.pile === 'tab' && w.idx === col.length - 1) { snapshot(); card.up = true; commit(); }
      return;
    }
    if (sel) {
      if (same(sel, w)) { sel = null; draw(); return; }
      const dest = w.pile === 'waste' ? null : { pile: w.pile, col: w.col };
      if (dest && tryMove(sel, dest)) return;
    }
    sel = w;
    draw();
  }

  function clickPile(dest) {
    if (sel && tryMove(sel, dest)) return;
    sel = null;
    draw();
  }

  // --- the win -------------------------------------------------------------
  // The old desktop classic: the foundations spring off one card at a time and
  // bounce down the felt, leaving a trail, while confetti bursts over the top.
  // A click skips to the score.

  function celebrate() {
    party?.stop(false);
    const W = board.clientWidth, H = board.clientHeight;
    if (!W || !H || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const { gap, cw, ch, x } = metrics(W, H);
    const dpr = window.devicePixelRatio || 1;
    const layer = (cls) => {
      const c = node('canvas', 'sol-fx ' + cls);
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      Object.assign(c.style, { top: board.offsetTop + 'px', width: W + 'px', height: H + 'px' });
      const g = c.getContext('2d');
      g.scale(dpr, dpr);
      root.append(c);
      return g;
    };
    const trail = layer('trail'), sparks = layer('confetti');
    const css = getComputedStyle(root);
    const font = css.fontFamily;
    const accent = css.getPropertyValue('--accent').trim() || '#F2789F';
    const colors = [accent, '#FFCF6B', '#7CC6FE', '#8FD694', '#C9A0FF', '#FF8DA1'];

    // Kings first, the way the foundations would come off.
    const queue = [];
    for (let r = 13; r >= 1; r--) for (let s = 0; s < 4; s++) queue.push({ s, r, x: x(3 + s), y: gap });
    const flying = [];
    const bits = [];
    const burst = (bx, by, n, spread) => {
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * spread;
        const v = 5 + Math.random() * 9;
        bits.push({ x: bx, y: by, vx: Math.cos(a) * v, vy: Math.sin(a) * v, w: 4 + Math.random() * 5, h: 3 + Math.random() * 4,
          rot: Math.random() * 6.3, spin: (Math.random() - 0.5) * 0.4, color: colors[i % colors.length] });
      }
    };
    burst(W * 0.5, H * 0.55, 90, 1.6);
    const later = [setTimeout(() => burst(W * 0.15, H, 60, 0.9), 700), setTimeout(() => burst(W * 0.85, H, 60, 0.9), 1100)];

    const paintCard = (c, cx, cy) => {
      const rad = cw * 0.09;
      trail.beginPath();
      trail.roundRect(cx, cy, cw, ch, rad);
      trail.fillStyle = '#fffdf8';
      trail.fill();
      trail.strokeStyle = 'rgba(0,0,0,.28)';
      trail.lineWidth = 1;
      trail.stroke();
      trail.fillStyle = red(c.s) ? '#c2382f' : '#2a2622';
      trail.textBaseline = 'top';
      trail.font = `700 ${cw * 0.24}px ${font}`;
      trail.fillText(RANK[c.r], cx + cw * 0.09, cy + ch * 0.05);
      trail.font = `${cw * 0.46}px ${font}`;
      trail.textBaseline = 'bottom';
      trail.textAlign = 'right';
      trail.fillText(SUITS[c.s], cx + cw * 0.91, cy + ch * 0.95);
      trail.textAlign = 'left';
    };

    let launched = 0, prev = performance.now(), sinceLaunch = 0;
    const started = prev;
    const tick = (now) => {
      if (!party) return;
      const f = Math.min(3, (now - prev) / 16.67);
      prev = now;
      sinceLaunch += f * 16.67;
      if (launched < queue.length && sinceLaunch >= 95) {
        sinceLaunch = 0;
        const c = queue[launched++];
        const dir = Math.random() < 0.5 ? -1 : 1;
        flying.push({ ...c, vx: dir * (1.8 + Math.random() * 3.2) * (W / 560), vy: -(1 + Math.random() * 4) });
      }
      for (let i = flying.length - 1; i >= 0; i--) {
        const c = flying[i];
        c.vy += 0.42 * f;
        c.x += c.vx * f;
        c.y += c.vy * f;
        if (c.y + ch > H) { c.y = H - ch; c.vy = -Math.abs(c.vy) * 0.72; }
        if (c.x < -cw || c.x > W) flying.splice(i, 1);
        else paintCard(c, c.x, c.y);
      }
      sparks.clearRect(0, 0, W, H);
      for (let i = bits.length - 1; i >= 0; i--) {
        const b = bits[i];
        b.vy += 0.22 * f;
        b.vx *= 0.985;
        b.x += b.vx * f;
        b.y += b.vy * f;
        b.rot += b.spin * f;
        if (b.y > H + 20) { bits.splice(i, 1); continue; }
        sparks.save();
        sparks.translate(b.x, b.y);
        sparks.rotate(b.rot);
        sparks.fillStyle = b.color;
        sparks.fillRect(-b.w / 2, -b.h / 2, b.w, b.h * Math.abs(Math.cos(b.rot * 2)) + 1);
        sparks.restore();
      }
      const done = launched === queue.length && !flying.length && !bits.length;
      if (done || now - started > 12000) party.stop();
      else raf = requestAnimationFrame(tick);
    };
    let raf = requestAnimationFrame(tick);

    // Clicking anywhere in the game skips ahead; the finished board can't be disturbed meanwhile.
    const skip = (e) => {
      if (e.target.closest('.sol-bar')) return;
      e.stopPropagation();
      party?.stop();
    };
    root.addEventListener('click', skip, true);

    party = {
      stop(fade = true) {
        if (!party) return;
        party = null;
        cancelAnimationFrame(raf);
        later.forEach(clearTimeout);
        root.removeEventListener('click', skip, true);
        const layers = root.querySelectorAll('.sol-fx');
        if (fade) {
          layers.forEach((c) => c.classList.add('fade'));
          setTimeout(() => layers.forEach((c) => c.remove()), 700);
        } else layers.forEach((c) => c.remove());
        draw();
      },
    };
  }

  // --- drawing -------------------------------------------------------------

  function draw() {
    count.textContent = `${game.moves} move${game.moves === 1 ? '' : 's'}`;
    undoBtn.disabled = !undo.length;
    const W = board.clientWidth, H = board.clientHeight;
    if (!W || !H) return;

    const { gap, cw, ch, x } = metrics(W, H);
    board.style.setProperty('--cw', cw + 'px');
    board.style.setProperty('--ch', ch + 'px');
    const kids = [];

    const slot = (left, top, glyph, onClick) => {
      const s = node('div', 'sol-slot', glyph);
      s.style.left = left + 'px';
      s.style.top = top + 'px';
      s.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      kids.push(s);
    };
    const card = (c, left, top, where) => {
      const n = node('div', 'sol-card ' + (c.up ? 'up' : 'down'));
      if (c.up && red(c.s)) n.classList.add('red');
      if (sel && where.pile === sel.pile && where.col === sel.col && (where.pile !== 'tab' || where.idx >= sel.idx)) n.classList.add('sel');
      n.style.left = left + 'px';
      n.style.top = top + 'px';
      if (c.up) {
        const corner = node('span', 'c', RANK[c.r]);
        corner.append(node('i', null, SUITS[c.s]));
        n.append(corner, node('b', null, SUITS[c.s]));
        n.setAttribute('aria-label', `${RANK[c.r]} of ${['spades', 'hearts', 'diamonds', 'clubs'][c.s]}`);
      }
      n.addEventListener('click', (e) => { e.stopPropagation(); clickCard(where); });
      kids.push(n);
    };

    // Top row: stock, waste, then the four foundations on the right.
    if (game.stock.length) {
      const n = node('div', 'sol-card down');
      n.style.left = x(0) + 'px';
      n.style.top = gap + 'px';
      n.title = `${game.stock.length} left`;
      n.addEventListener('click', (e) => { e.stopPropagation(); drawStock(); });
      kids.push(n);
    } else {
      slot(x(0), gap, game.waste.length ? '↻' : '', drawStock);
    }
    if (game.waste.length) card(game.waste[game.waste.length - 1], x(1), gap, { pile: 'waste' });
    for (let s = 0; s < 4; s++) {
      const f = game.found[s];
      if (f.length) card(f[f.length - 1], x(3 + s), gap, { pile: 'found', col: s });
      else slot(x(3 + s), gap, SUITS[s], () => clickPile({ pile: 'found', col: s }));
    }

    // Tableau: fan each column, squeezing it when it would run off the bottom.
    const y0 = gap * 2 + ch;
    const avail = H - y0 - gap;
    game.tableau.forEach((col, c) => {
      slot(x(c), y0, '', () => clickPile({ pile: 'tab', col: c }));
      const down = col.filter((k) => !k.up).length;
      const up = col.length - down;
      let dOff = ch * 0.14, uOff = ch * 0.28;
      const spread = down * dOff + Math.max(0, up - 1) * uOff;
      if (spread > 0 && spread + ch > avail) {
        const k = Math.max(0.12, (avail - ch) / spread);
        dOff *= k;
        uOff *= k;
      }
      let y = y0;
      col.forEach((k, i) => {
        card(k, x(c), y, { pile: 'tab', col: c, idx: i });
        y += k.up ? uOff : dOff;
      });
    });

    // The score waits until the celebration has had its moment.
    if (game.won && !party) {
      const won = node('div', 'sol-won');
      const inner = node('div');
      inner.append(node('div', 'sol-trophy', '🏆'), node('div', null, 'You won!'),
        node('div', 'sol-score', `Solved in ${game.moves} moves`), button('Deal again', newGame));
      won.append(inner);
      won.addEventListener('click', (e) => e.stopPropagation());
      kids.push(won);
    }
    board.replaceChildren(...kids);
  }

  // mount() runs before the window puts the board on the page; draw once it's there.
  queueMicrotask(draw);
}
