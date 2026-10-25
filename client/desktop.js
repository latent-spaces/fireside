import { tilePanels, fitRect } from './layout.js';
import { windowKind, naturalHeights, naturalWidths, disposeWindow, closeWindow } from './windows.js';
import { popover, placeBelow } from './popover.js';

// Window geometry and lifecycle. Panel renderers supply content; this module
// owns placement, dragging, resizing, docking, and restoring user layouts.
export function createDesktop({
  $, el, esc, fileURL, activateIcon, WINS, renderPanel, shareComponent,
  getState, getGeometry, getTint, saveGeo, onChange, deletePanel,
}) {
  let zTop = 10;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  // --- window management ------------------------------------------------------
  const desk = $('desk');
  const deskSize = () => ({ w: desk.clientWidth, h: desk.clientHeight });
  // The desk runs under the tray, so a window can be dragged or stretched all the
  // way down behind it. Anything placed for the user (new windows, tidy, snapping,
  // maximise) stays in the work area above the tray instead.
  const workSize = () => ({ w: desk.clientWidth,
    h: Math.max(0, desk.clientHeight - (parseFloat(desk.style.getPropertyValue('--tray')) || 0)) });
  const M = 18, G = 13;            // desktop margin, gap between windows
  const MIN_BESIDE = 320;          // narrower than this, a window is better off overlapping
  /** A stable hue per window id, so you learn windows by colour. */
  function hueOf(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
    return h;
  }

  /** The window's own hue, folded into whatever range the skin allows. */
  const tintHue = (id) => (getTint().from + (hueOf(id) % Math.max(1, getTint().span))) % 360;

  function paintTints() {
    for (const [id, w] of WINS) w.el.style.setProperty('--tint-h', String(tintHue(id)));
  }

  // A kind whose height depends on its content can work it out; `height` is the fallback.
  const heightOf = (p) => p.height || windowKind(p.kind).heightFor?.(p) || windowKind(p.kind).height;

  function defaultSize(p) {
    const { w: DW, h: DH } = workSize();
    const narrow = DW < 760;
    const usable = DW - M * 2;
    const span = clamp(p.span || 6, 1, 12);
    // A kind that knows its content's width opens at it, not at a share of the desk.
    const natural = windowKind(p.kind).width;
    const width = narrow ? usable : natural || Math.round((usable + G) * (span / 12)) - G;
    return {
      w: clamp(width, 240, Math.max(240, DW - M * 2)),
      h: clamp(heightOf(p), 120, Math.max(140, DH - M * 2)),
    };
  }

  /**
   * Open a new window on the stage — the work area beside the chat and any pinned
   * windows — in the free spot nearest its middle. When nothing is free, cascade
   * from the middle.
   */
  function place(p, taken) {
    const { w: DW, h: DH } = workSize();
    let { w, h } = defaultSize(p);
    // The chat and pinned windows stay put, so the stage is the band between them.
    // If that band is too narrow, keep just the chat out of it, then nothing.
    const band = (fixed) => {
      let lo = 0, hi = DW;
      for (const r of fixed.sort((a, b) => a.x - b.x)) {
        if (r.x + r.w / 2 < (lo + hi) / 2) lo = Math.max(lo, r.x + r.w);
        else hi = Math.min(hi, r.x);
      }
      return [lo, hi];
    };
    const room = ([lo, hi]) => hi - lo - G - M;
    // Windows never move for a newcomer, so one too wide for the space beside the
    // chat takes that space rather than covering it, if that leaves it usable.
    const beside = room(band(taken.filter((r) => r.chat)));
    if (beside < w && beside >= MIN_BESIDE) w = beside;
    const stage = (fixed) => (room(band(fixed)) >= w ? band(fixed) : null);
    const [lo, hi] = stage(taken.filter((r) => r.chat || r.pinned))
      || stage(taken.filter((r) => r.chat)) || [0, DW];
    // Beside the chat a window lines up with its top; otherwise it aims for the middle.
    const chat = taken.find((r) => r.chat);
    const cx = (lo + hi) / 2, cy = chat ? chat.y + h / 2 : DH / 2;

    // Candidates sit against a margin or a neighbour, or centred in the gap between them.
    const axis = (span, len, near, far) => {
      const starts = [M, ...taken.map((r) => near(r) + G)];
      const ends = [span - M, ...taken.map((r) => far(r) - G)];
      const out = new Set();
      for (const a of starts) for (const b of ends) {
        if (b - a < len) continue;
        out.add(a); out.add(b - len); out.add(Math.round((a + b - len) / 2));
      }
      return [...out].filter((v) => v >= 0 && v + len <= span);
    };
    const hits = (x, y) => taken.some((r) => x < r.x + r.w && r.x < x + w && y < r.y + r.h && r.y < y + h);
    let best = null;
    // Only spots on the stage: a free corner under a pinned window is not the middle.
    for (const x of axis(DW, w, (r) => r.x + r.w, (r) => r.x).filter((v) => v >= lo && v + w <= hi)) {
      for (const y of axis(DH, h, (r) => r.y + r.h, (r) => r.y)) {
        if (hits(x, y)) continue;
        const d = Math.hypot(x + w / 2 - cx, y + h / 2 - cy);
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    if (best) return { x: best.x, y: best.y, w, h };

    const n = taken.length % 5;
    return {
      x: clamp(Math.round(cx - w / 2) + n * 26 - 52, lo, Math.max(lo, hi - w)),
      y: clamp(Math.round(DH / 2 - h / 2) + n * 26 - 52, 0, Math.max(0, DH - h)),
      w, h,
    };
  }

  /** Use the entire work area without letting minimum sizes overflow it. */
  function layoutAll(panels) {
    const { w, h } = workSize();
    const bounds = { x: Math.min(M, w / 2), y: Math.min(M, h / 2),
      w: Math.max(1, w - M * 2), h: Math.max(1, h - M * 2) };
    const rects = tilePanels(panels.map((p) => ({ ...p, height: heightOf(p) })), bounds, naturalHeights(), naturalWidths());
    // A window with `aloneWidth` keeps that size when it has the desk to itself,
    // on the left, leaving room beside it rather than stretching across.
    const alone = panels.length === 1 && windowKind(panels[0].kind).aloneWidth;
    if (alone && bounds.w >= alone) {
      rects[0] = { ...rects[0], w: Math.min(alone, Math.round(bounds.w * .6)), h: Math.min(bounds.h, alone * .75) };
    }
    panels.forEach((p, i) => {
      getGeometry()[p.id] = { closed: !!p.collapsed, ...getGeometry()[p.id], ...rects[i] };
      delete getGeometry()[p.id].max;
      delete getGeometry()[p.id].snap;
    });
  }

  // Which window is in front is part of the arrangement, so it is saved with it
  // as `z` and comes back when the desk opens again.
  // A pinned window stays above every unpinned one; among themselves, pinned
  // windows stack by focus like the rest. Windows live inside the desk's own
  // stacking context, so the offset never covers the top bar, tray or dock.
  const PIN = 200000;
  function stack(win, z) {
    win.dataset.z = z;
    win.style.zIndex = z + (getGeometry()[win.dataset.id]?.pinned ? PIN : 0);
  }

  function togglePin(win, id) {
    const g = getGeometry()[id];
    if (!g) return;
    if (g.pinned) delete g.pinned; else g.pinned = true;
    win.classList.toggle('pinned', !!g.pinned);
    const btn = win.querySelector('.bar .pin');
    btn.setAttribute('aria-pressed', String(!!g.pinned));
    btn.title = g.pinned ? 'Unpin' : 'Pin on top';
    stack(win, Number(win.dataset.z));
    saveGeo();
  }

  function focusWin(win) {
    if (!win) return;
    const geo = getGeometry();
    if (zTop > 100000) {
      // Keep the numbers small: renumber the open windows in their current order.
      zTop = 10;
      [...WINS].sort(([, a], [, b]) => Number(a.el.dataset.z) - Number(b.el.dataset.z)).forEach(([id, w]) => {
        stack(w.el, ++zTop);
        if (geo[id]) geo[id].z = zTop;
      });
    }
    const id = win.dataset.id;
    if (Number(win.dataset.z) !== zTop || !geo[id]) stack(win, ++zTop);
    if (geo[id] && geo[id].z !== Number(win.dataset.z)) { geo[id].z = Number(win.dataset.z); saveGeo(); }
    for (const w of WINS.values()) w.el.classList.toggle('focused', w.el === win);
    markDock();
  }

  /** The dock entry of the window in front is framed, so the dock reads as "what's open, and where you are". */
  function markDock() {
    const front = [...WINS.values()].find((w) => w.el.classList.contains('focused'))?.el.dataset.id;
    for (const b of $('dock').children) b.toggleAttribute('data-front', b.dataset.id === front);
  }

  function applyGeo(win, g) {
    const { w, h } = deskSize();
    // Viewport fitting is temporary; never overwrite the saved arrangement.
    const view = fitRect(g, w, h);
    win.style.minWidth = Math.min(240, w) + 'px';
    win.style.minHeight = Math.min(120, h) + 'px';
    win.style.left = view.x + 'px';
    win.style.top = view.y + 'px';
    win.style.width = view.w + 'px';
    win.style.height = view.h + 'px';
  }

  /** One gesture lifecycle for window moves, resizing, icons, and tab scrolling. */
  function onDrag(handle, start, { buttons = false, threshold = 0, persist = true } = {}) {
    let stop = () => {};
    const down = (e) => {
      if (e.button !== 0 || (!buttons && handle.tagName !== 'BUTTON' && e.target.closest('button'))) return;
      stop();
      const step = start(e);
      if (!step) return;
      let dragging = threshold === 0;
      const fn = typeof step === 'function' ? step : step.move;
      const move = (ev) => {
        if (ev.pointerId !== e.pointerId) return;
        const dx = ev.clientX - e.clientX, dy = ev.clientY - e.clientY;
        if (!dragging && Math.hypot(dx, dy) < threshold) return;
        dragging = true;
        ev.preventDefault(); document.body.style.userSelect = 'none';
        fn(dx, dy, ev);
      };
      const up = (ev) => {
        if (ev && ev.pointerId !== e.pointerId) return;
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        removeEventListener('pointercancel', up);
        document.body.style.userSelect = '';
        step.end?.(dragging);
        if (dragging && persist) saveGeo();
        stop = () => {};
      };
      if (dragging) { e.preventDefault(); document.body.style.userSelect = 'none'; }
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      addEventListener('pointercancel', up);
      stop = up;
    };
    handle.addEventListener('pointerdown', down);
    return () => { stop(); handle.removeEventListener('pointerdown', down); };
  }

  function closeWin(id) {
    const w = WINS.get(id);
    if (!w) return;
    closeWindow(WINS.get(id)?.body.firstElementChild);
    if (getGeometry()[id]) {
      getGeometry()[id].closed = true;
      // A component may request reopening when its token changes.
      getGeometry()[id].closedFor = panelList().find(p => p.id === id)?.reopenToken || null;
      saveGeo();
    }
    w.el.classList.add('closing');
    const el_ = w.el;
    disposeWindow(w.body.firstElementChild);
    WINS.delete(id);
    setTimeout(() => { el_.remove(); syncDesk(); }, 170);
    renderDock();
  }

  function openWin(id) {
    if (getGeometry()[id]) {
      getGeometry()[id].closed = false;
      // Reopening onto a spot that's now off-screen or under the tray is a bad surprise.
      const { w: DW, h: DH } = workSize();
      getGeometry()[id].x = clamp(getGeometry()[id].x, 0, Math.max(0, DW - 120));
      getGeometry()[id].y = clamp(getGeometry()[id].y, 0, Math.max(0, DH - 60));
      saveGeo();
    }
    syncWindows();
    focusWin(WINS.get(id)?.el);
    renderDock();
  }

  function toggleMax(win, id) {
    const g = getGeometry()[id];
    const { w: DW, h: DH } = workSize();
    if (g.max) {
      Object.assign(g, g.max);
      delete g.max;
      win.classList.remove('maxed');
    } else {
      g.max = { x: g.x, y: g.y, w: g.w, h: g.h };
      Object.assign(g, { x: 10, y: 10, w: DW - 20, h: DH - 20 });
      win.classList.add('maxed');
    }
    applyGeo(win, g);
    saveGeo();
  }

  // --- snapping ---------------------------------------------------------------
  // Drop a window on an edge and it takes half the desktop; on a corner, a
  // quarter; on the top, all of it. ⌥ drops it exactly where it is. Nothing here
  // ever moves a window the user isn't holding.

  const MIN_W = 240, MIN_H = 120;
  const SNAP_EDGE = 16, SNAP_CORNER = 110;

  /** The rectangle a drop at (px, py) would snap to, or null. */
  function snapTarget(px, py) {
    // The edges are the screen's; the halves and quarters fill the work area.
    const { w: DW, h: DH } = deskSize();
    if (DW < 760) return null;   // halves would be narrower than a window can be
    const a = { x: M, y: M, w: DW - M * 2, h: workSize().h - M * 2 };
    const hw = Math.round((a.w - G) / 2), hh = Math.round((a.h - G) / 2);
    const left = { x: a.x, w: hw }, right = { x: a.x + hw + G, w: a.w - hw - G };
    const top = { y: a.y, h: hh }, bottom = { y: a.y + hh + G, h: a.h - hh - G }, tall = { y: a.y, h: a.h };
    const atL = px < SNAP_EDGE, atR = px > DW - SNAP_EDGE, atT = py < SNAP_EDGE, atB = py > DH - SNAP_EDGE;
    const nearT = py < SNAP_CORNER, nearB = py > DH - SNAP_CORNER;
    if (atL || atR) return { ...(atL ? left : right), ...(nearT ? top : nearB ? bottom : tall) };
    if (atT || atB) {
      if (px < SNAP_CORNER) return { ...left, ...(atT ? top : bottom) };
      if (px > DW - SNAP_CORNER) return { ...right, ...(atT ? top : bottom) };
      if (atT) return a;
    }
    return null;
  }

  let ghost = null;
  function showGhost(t, win) {
    if (!ghost) { ghost = el('div', 'snap-ghost'); ghost.hidden = true; desk.append(ghost); }
    if (t && ghost.hidden) {
      // Above every other window, still under the one being dragged.
      stack(win, ++zTop);
      ghost.style.zIndex = String(Number(win.style.zIndex) - 1);
    }
    ghost.hidden = !t;
    if (t) applyGeo(ghost, t);
  }

  /** Resize one window from any edge or corner. Its neighbours stay put. */
  function startResize(id, win, dir, handle) {
    const g = getGeometry()[id];
    const { w: DW, h: DH } = deskSize();
    Object.assign(g, fitRect(g, DW, DH));
    const o = { x: g.x, y: g.y, w: g.w, h: g.h };
    handle.classList.add('active');
    document.body.classList.add('resizing');
    // Resizing makes this its own size; there is nothing to snap back to.
    delete g.snap; delete g.max;
    win.classList.remove('maxed');

    return {
      move(dx, dy) {
        let L = o.x, T = o.y, R = o.x + o.w, B = o.y + o.h;
        if (dir.includes('w')) L = clamp(o.x + dx, 0, R - MIN_W);
        if (dir.includes('e')) R = clamp(R + dx, L + MIN_W, DW);
        if (dir.includes('n')) T = clamp(o.y + dy, 0, B - MIN_H);
        if (dir.includes('s')) B = clamp(B + dy, T + MIN_H, DH);
        Object.assign(g, { x: L, y: T, w: R - L, h: B - T });
        applyGeo(win, g);
      },
      end() {
        handle.classList.remove('active');
        document.body.classList.remove('resizing');
      },
    };
  }

  function buildWin(p) {
    const win = el('section', 'win');
    win.dataset.id = p.id;
    // Only the hue is per-window; how saturated and how light it is belongs to
    // the theme, so a skin can restyle every title bar at once.
    win.style.setProperty('--tint-h', String(tintHue(p.id)));

    const bar = el('div', 'bar');
    const dots = el('div', 'dots');
    const x = el('button', 'x'); x.type = 'button'; x.title = 'Close — stays in the dock'; x.append(el('span', null, '×'));
    const z = el('button', 'z'); z.type = 'button'; z.title = 'Maximise'; z.append(el('span', null, '+'));
    x.addEventListener('click', () => closeWin(p.id));
    z.addEventListener('click', () => toggleMax(win, p.id));
    dots.append(x, z);
    bar.append(dots, el('span', 'ico', windowKind(p.kind).icon), el('span', 'ttl', esc(p.title || p.id)));
    bar.append(el('span', 'tag', esc(p.tag || '')));
    const pinned = !!getGeometry()[p.id]?.pinned;
    const pin = el('button', 'pin');
    pin.type = 'button';
    pin.title = pinned ? 'Unpin' : 'Pin on top';
    pin.setAttribute('aria-pressed', String(pinned));
    pin.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M9.8 1.5l4.7 4.7-1.4.4-2.6 2.6.3 3.1-1.2 1.2-3-3-3.8 3.8-.7-.7 3.8-3.8-3-3 1.2-1.2 3.1.3 2.6-2.6z" fill="currentColor"/></svg>';
    pin.addEventListener('click', () => togglePin(win, p.id));
    win.classList.toggle('pinned', pinned);
    const share = el('button', 'share');
    share.type = 'button';
    share.title = `Share the ${windowKind(p.kind).title || p.kind} window as a ZIP (its code, not this desk's content)`;
    share.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M8 1.5l3.5 3.5-1 1L8.7 4.2V10H7.3V4.2L5.5 6l-1-1zM3 9h1.5v3.5h7V9H13v5H3z" fill="currentColor"/></svg>';
    share.addEventListener('click', () => shareComponent('window', p.kind, share));
    bar.append(share, pin);
    bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleMax(win, p.id); });

    const body = el('div', 'body' + (windowKind(p.kind).fill ? ' fill' : ''));
    win.append(bar, body);
    win.addEventListener('pointerdown', () => focusWin(win), true);

    onDrag(bar, (e0) => {
      const g = getGeometry()[p.id];
      Object.assign(g, fitRect(g, desk.clientWidth, desk.clientHeight));
      let ox = g.x;
      const oy = g.y;
      const { w: DW, h: DH } = deskSize();
      const rect = desk.getBoundingClientRect();
      const cx = e0.clientX - rect.left;
      let target = null;
      document.body.classList.add('moving');
      return {
        move(dx, dy, ev) {
          // Pulling a snapped or maximised window away gives it back its own
          // size, with the title bar still under the cursor where it was grabbed.
          const prev = g.snap || g.max;
          if (prev) {
            if (Math.hypot(dx, dy) < 8) return;
            const frac = clamp((cx - ox) / g.w, 0, 1);
            g.w = prev.w; g.h = prev.h;
            ox = Math.round(cx - g.w * frac);
            delete g.snap; delete g.max;
            win.classList.remove('maxed');
            applyGeo(win, g);
          }
          g.x = clamp(ox + dx, 90 - g.w, DW - 90);   // always leave a grabbable strip on screen
          g.y = clamp(oy + dy, 0, DH - 38);
          win.style.left = g.x + 'px';
          win.style.top = g.y + 'px';
          target = ev.altKey ? null : snapTarget(ev.clientX - rect.left, ev.clientY - rect.top);
          showGhost(target, win);
        },
        end() {
          document.body.classList.remove('moving');
          showGhost(null);
          if (target) {
            g.snap = { w: g.w, h: g.h };
            Object.assign(g, target);
            applyGeo(win, g);
          }
        },
      };
    });

    for (const dir of ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']) {
      const h = el('div', 'rz ' + dir);
      win.append(h);
      onDrag(h, () => startResize(p.id, win, dir, h));
    }
    return { el: win, body, bar };
  }

  function fillBody(rec, p) {
    const draft = rec.body.querySelector('textarea')?.value;
    disposeWindow(rec.body.firstElementChild);
    rec.body.replaceChildren();
    rec.body.classList.toggle('fill', windowKind(p.kind).fill);
    try {
      rec.body.append(renderPanel(p));
    } catch (e) {
      rec.body.append(el('div', 'md', `<p><code>${esc(p.kind)}</code> panel failed to render: ${esc(e.message)}</p>`));
    }
    if (draft && rec.body.querySelector('textarea')) {
      const box = rec.body.querySelector('textarea'); box.value = draft;
      box.dispatchEvent(new Event('input'));
    }
    const old = rec.el.querySelector(':scope > .note');
    if (old) old.remove();
    if (p.note) rec.body.after(el('p', 'note', esc(p.note)));
  }

  const panelList = () => getState()?.panels || [];

  function syncWindows() {
    const panels = panelList();
    const ids = new Set(panels.map((p) => p.id));

    for (const [id, w] of [...WINS]) {
      if (!ids.has(id)) { disposeWindow(w.body.firstElementChild); w.el.remove(); WINS.delete(id); }
    }
    if (panels.length && panels.every((p) => !getGeometry()[p.id])) layoutAll(panels.filter(p => !p.collapsed));

    for (const p of panels) {
      if (!getGeometry()[p.id]) {
        const taken = panels.filter((q) => getGeometry()[q.id] && !getGeometry()[q.id].closed).map((q) => ({ ...getGeometry()[q.id], chat: q.kind === 'chat' }));
        getGeometry()[p.id] = place(p, taken);
        if (p.collapsed) getGeometry()[p.id].closed = true;   // "collapsed" now means "starts in the dock"
      }
      // A changed reopen token outranks closing the earlier instance.
      if (p.reopenToken && getGeometry()[p.id].closed && (getGeometry()[p.id].closedFor || null) !== (p.reopenToken || null)) {
        getGeometry()[p.id].closed = false;
      }
      if (getGeometry()[p.id].closed) {
        const w = WINS.get(p.id);
        if (w) { disposeWindow(w.body.firstElementChild); w.el.remove(); WINS.delete(p.id); }
        continue;
      }
      let rec = WINS.get(p.id);
      if (!rec) {
        rec = buildWin(p);
        WINS.set(p.id, rec);
        desk.append(rec.el);
        applyGeo(rec.el, getGeometry()[p.id]);
        // Back where it was in the stack; a window with no saved place opens in front.
        const g = getGeometry()[p.id];
        if (Number.isInteger(g.z)) { stack(rec.el, g.z); zTop = Math.max(zTop, g.z); }
        else {
          zTop = Math.max(zTop, ...Object.values(getGeometry()).map((q) => q.z || 0)) + 1;
          stack(rec.el, g.z = zTop);
        }
        rec.sig = '';
      }
      const sig = JSON.stringify(p);
      if (sig !== rec.sig) {
        rec.sig = sig;
        rec.bar.querySelector('.ttl').textContent = p.title || p.id;
        rec.bar.querySelector('.ico').textContent = windowKind(p.kind).icon;
        rec.bar.querySelector('.tag').textContent = p.tag || '';
        fillBody(rec, p);
      }
    }
    syncDesk();
    saveGeo();
  }

  function syncDesk() {
    $('deskEmpty').hidden = WINS.size > 0;
    onChange();
  }

  // A pinned window is one the user placed on purpose, so tidy leaves it be.
  function tidy() {
    const open = panelList().filter((p) => !getGeometry()[p.id]?.closed && !getGeometry()[p.id]?.pinned);
    layoutAll(open);
    for (const p of open) {
      const w = WINS.get(p.id);
      if (w) { w.el.classList.remove('maxed'); applyGeo(w.el, getGeometry()[p.id]); }
    }
    saveGeo();
  }

  let dockDrawn = '';
  function renderDock() {
    // Every state push lands here; rebuild only when what the dock shows changed.
    const panels = panelList();
    const drawn = JSON.stringify(panels.map((p) => [p.id, p.title, windowKind(p.kind).icon, !getGeometry()[p.id]?.closed, p.deletable]));
    if (drawn !== dockDrawn) drawDock(panels, drawn);
    markDock();
  }

  function drawDock(panels, drawn) {
    dockDrawn = drawn;
    // Every window stays in the dock when closed, shortcut or not.
    $('dock').replaceChildren(...panels.map((p) => {
      const open = !getGeometry()[p.id]?.closed;
      const b = el('button');
      b.type = 'button';
      b.dataset.open = String(open);
      b.dataset.id = p.id;
      b.title = open ? `Bring "${p.title || p.id}" to the front` : `Reopen "${p.title || p.id}"`;
      b.append(el('span', 'e', windowKind(p.kind).icon), el('span', null, esc(p.title || p.id)));
      b.addEventListener('click', () => (open ? focusWin(WINS.get(p.id)?.el) : openWin(p.id)));
      if (p.deletable !== false) {
        b.addEventListener('pointerenter', () => showTrash(p, b));
        b.addEventListener('pointerleave', hideTrash);
      }
      return b;
    }));
    markDockEdges();
  }

  // A crowded dock scrolls sideways with no scrollbar: a plain mouse wheel or a
  // drag moves it too, and each end fades while there are names past it.
  const dock = $('dock');
  function markDockEdges() {
    const rest = dock.scrollWidth - dock.clientWidth - dock.scrollLeft;
    dock.toggleAttribute('data-more-left', dock.scrollLeft > 1);
    dock.toggleAttribute('data-more-right', rest > 1);
  }
  dock.addEventListener('scroll', markDockEdges, { passive: true });
  new ResizeObserver(markDockEdges).observe(dock);
  dock.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY) || dock.scrollWidth <= dock.clientWidth) return;
    e.preventDefault();
    dock.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
  }, { passive: false });
  // A press that travels a few pixels is a drag, not a click on the name under it.
  // Touch already pans the dock natively.
  let pull = null;
  dock.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch' || dock.scrollWidth <= dock.clientWidth) return;
    pull = { id: e.pointerId, x: e.clientX, from: dock.scrollLeft, moved: false };
  });
  dock.addEventListener('pointermove', (e) => {
    if (pull?.id !== e.pointerId) return;
    const dx = e.clientX - pull.x;
    if (!pull.moved && Math.abs(dx) < 5) return;
    if (!pull.moved) {
      pull.moved = true;
      dock.setPointerCapture(e.pointerId);
      dock.classList.add('pulling');
      hideTrash();
    }
    dock.scrollLeft = pull.from - dx;
  });
  const letGo = (e) => {
    if (pull?.id !== e.pointerId) return;
    if (pull.moved) {
      dock.classList.remove('pulling');
      // The click that ends a drag lands on whatever name is under the pointer; drop
      // it, and stop waiting if the release made no click at all.
      const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, true));
    }
    pull = null;
  };
  dock.addEventListener('pointerup', letGo);
  dock.addEventListener('pointercancel', letGo);


  // --- shortcuts ---------------------------------------------------------------
  // They sit in the menu bar, where no window can cover them. As many as fit are
  // shown; the rest wait behind ⋯. Their order is the user's, saved with the layout.
  const ICON_STEP = 34;    // a 28px tile and the 6px gap after it
  const ICON_MORE = 40;    // the ⋯ button and the bar's gap beside it
  const ICON_ADD = 36;     // the ＋ after the shortcuts and the gap before it
  const iconsMore = $('iconsMore'), iconMenu = $('iconMenu');

  function iconTile(ic) {
    const tile = el('span', 'tile' + (ic.image ? ' img' : ''));
    if (ic.image) {
      const img = el('img');
      img.src = fileURL(ic.image);
      img.alt = '';
      img.draggable = false;
      tile.append(img);
    } else {
      tile.textContent = ic.glyph || '▦';
      if (ic.color) tile.style.background = ic.color;
    }
    return tile;
  }

  /** Shortcuts in the user's order. A desk laid out when they stood in columns on
   *  the wallpaper reads column by column, which is the same sort. */
  function orderedIcons() {
    const GEO = getGeometry();
    const list = (getState()?.icons || []).filter((icon) => ['exec', 'window', 'prompt', 'url'].includes(icon.kind));
    const at = new Map(list.map((ic, i) => [ic, GEO[`icon:${ic.id}`] || { x: Infinity, y: i }]));
    list.sort((a, b) => (at.get(a).x - at.get(b).x) || (at.get(a).y - at.get(b).y));
    list.forEach((ic, i) => {
      const g = GEO[`icon:${ic.id}`];
      if (g?.x !== i || g.y !== 0) GEO[`icon:${ic.id}`] = { x: i, y: 0 };
    });
    return list;
  }

  let iconsDrawn = '';
  let iconsHidden = [];     // the ones behind ⋯

  const more = popover(iconMenu, iconsMore, openIconMenu);
  const closeIconMenu = more.close;

  function openIconMenu() {
    iconMenu.replaceChildren(el('p', 'cat-head', 'More shortcuts'), ...iconsHidden.map((ic) => {
      const row = el('div', 'desk-row');
      const go = el('button', 'desk-go icon-go');
      go.type = 'button';
      go.append(iconTile(ic), el('span', 'cat-name', esc(ic.label || ic.id)));
      go.addEventListener('click', () => { closeIconMenu(); activateIcon(ic); });
      row.append(go);
      return row;
    }));
    more.show();
    placeBelow(iconMenu, iconsMore, { fit: true });
  }

  function renderIcons() {
    const row = $('icons');
    const list = orderedIcons();
    // The row shares the bar's middle with ＋, and gives up room to ⋯ only
    // when something has to go behind it.
    const room = row.parentElement.clientWidth - ICON_ADD;
    const fits = (width) => Math.max(0, Math.floor((width + 6) / ICON_STEP));
    const count = list.length <= fits(room) ? list.length : fits(room - ICON_MORE);
    // Every state update calls this; redrawing unchanged icons would drop a drag
    // in progress, so rebuild only when the icons themselves change.
    const drawn = JSON.stringify([list, count]);
    if (drawn === iconsDrawn) return;
    iconsDrawn = drawn;
    closeIconMenu();
    iconsHidden = list.slice(count);
    iconsMore.hidden = !iconsHidden.length;

    const shown = list.slice(0, count);
    const nodes = shown.map((ic, from) => {
      const n = el('button', 'licon');
      n.type = 'button';
      const detail = ic.kind === 'exec' ? '' : ic.prompt || ic.url || '';
      n.title = detail ? `${ic.label || ic.id}\n${detail}` : ic.label || ic.id;
      n.setAttribute('aria-label', ic.label || ic.id);
      n.append(iconTile(ic));

      // Drag sideways to reorder; a click that didn't move is an open. The icon
      // follows the pointer and the ones it passes step aside.
      let moved = false;
      onDrag(n, () => {
        let to = from;
        moved = false;
        const move = (dx) => {
          if (Math.abs(dx) > 3) moved = true;
          if (!moved) return;
          to = clamp(from + Math.round(dx / ICON_STEP), 0, shown.length - 1);
          n.classList.add('dragging');
          n.style.transform = `translateX(${clamp(dx, -from * ICON_STEP, (shown.length - 1 - from) * ICON_STEP)}px)`;
          nodes.forEach((other, i) => {
            if (other === n) return;
            const shift = i > from && i <= to ? -ICON_STEP : i < from && i >= to ? ICON_STEP : 0;
            other.style.transform = shift ? `translateX(${shift}px)` : '';
          });
        };
        const end = () => {
          if (!moved || to === from) {
            n.classList.remove('dragging');
            for (const other of nodes) other.style.transform = '';
            return;
          }
          const next = list.slice();
          next.splice(to, 0, ...next.splice(from, 1));
          next.forEach((item, i) => { getGeometry()[`icon:${item.id}`] = { x: i, y: 0 }; });
          renderIcons();
        };
        return { move, end };
      });
      n.addEventListener('click', () => { if (!moved) activateIcon(ic); });
      return n;
    });
    row.replaceChildren(...nodes);
  }
  new ResizeObserver(() => renderIcons()).observe($('launchbar'));

  // --- delete -----------------------------------------------------------------
  // One 🗑 for the whole dock, floating above whichever name is hovered. It
  // lives outside the dock because the dock scrolls sideways and would clip it,
  // and so a dock redraw never drops a "Delete?" that is about to be confirmed.
  // It deletes open windows too: once the server drops the panel, syncWindows
  // takes the window away.
  const trash = el('button', 'dock-trash');
  trash.type = 'button';
  trash.hidden = true;
  $('dock').after(trash);
  let doomed = null, hideTimer = null, askTimer = null;

  function disarm() {
    clearTimeout(askTimer);
    trash.classList.remove('confirm');
    trash.textContent = '🗑';
    trash.title = doomed ? `Delete "${doomed.title || doomed.id}"` : '';
    trash.setAttribute('aria-label', trash.title);
  }

  function showTrash(p, anchor) {
    clearTimeout(hideTimer);
    if (doomed?.id !== p.id) { doomed = p; disarm(); }
    const r = anchor.getBoundingClientRect();
    trash.style.left = `${r.left + r.width / 2}px`;
    trash.style.top = `${r.top}px`;
    trash.hidden = false;
  }

  // A short grace period lets the pointer travel up from the name to the 🗑.
  function hideTrash() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { trash.hidden = true; doomed = null; disarm(); }, 300);
  }

  trash.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  trash.addEventListener('pointerleave', hideTrash);
  trash.addEventListener('click', () => {
    if (!doomed) return;
    if (!trash.classList.contains('confirm')) {
      trash.classList.add('confirm');
      trash.textContent = 'Delete?';
      askTimer = setTimeout(disarm, 3000);
      return;
    }
    const { id } = doomed;
    closeWindow(WINS.get(id)?.body.firstElementChild);
    trash.hidden = true;
    doomed = null;
    disarm();
    deletePanel(id);
  });

  // A click inside a frame never reaches this page, so the capture listener on
  // the window cannot raise it. The page does lose focus to the frame, though:
  // raise whichever window holds the focused frame, and keep watching while
  // focus is out, since moving from one frame to another blurs nothing here.
  let framed = null, watch = null;
  const raiseFramed = () => {
    const frame = document.activeElement;
    if (frame === framed || frame?.tagName !== 'IFRAME') return;
    framed = frame;
    const win = frame.closest('.win');
    if (win && WINS.get(win.dataset.id)?.el === win) focusWin(win);
  };
  addEventListener('blur', () => {
    setTimeout(raiseFramed);
    watch ||= setInterval(raiseFramed, 250);
  });
  addEventListener('focus', () => { clearInterval(watch); watch = null; framed = null; });

  return { paintTints, onDrag, deskSize, openWin, renderIcons, syncWindows, renderDock, fillBody, applyGeo, tidy };
}
