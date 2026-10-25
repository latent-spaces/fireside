// The menus that hang off a menubar or tray button all behave alike: the button
// toggles them, a press outside or Escape closes them, and only one is open at a
// time. `open` fills the menu, then calls show() and places it.
const all = [];

export function popover(menu, button, open) {
  const pop = {
    close({ focus = false } = {}) {
      if (menu.hidden) return;
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (focus) button.focus();
    },
    show() {
      for (const other of all) if (other !== pop) other.close();
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
    },
  };
  all.push(pop);
  button.addEventListener('click', () => (menu.hidden ? open() : pop.close({ focus: true })));
  addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) pop.close();
  });
  addEventListener('keydown', (event) => { if (event.key === 'Escape') pop.close({ focus: true }); });
  return pop;
}

/** Under its button, left edges lined up, never past the right of the screen.
 *  `fit` caps its height at the room left below, past which it scrolls. */
export function placeBelow(menu, button, { fit = false } = {}) {
  const r = button.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${r.bottom + 6}px`;
  if (fit) menu.style.maxHeight = `${Math.max(160, innerHeight - r.bottom - 22)}px`;
}
