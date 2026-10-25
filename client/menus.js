import { catalogueKinds, askableKinds, byTitle } from './windows.js';
import { popover, placeBelow } from './popover.js';

export function createMenus({ $, el, esc, store, request, composerNote, openWin, arm, pickComponentFile }) {
  // --- the window catalogue ---------------------------------------------------
  // Two halves, grouped by what a click does. The top half puts a window up at
  // once: kinds that are useful the moment they open. The bottom half drafts a
  // message instead, because the window is a frame and only the user knows what
  // goes in it — the agent builds it from what they say. A kind you already reach
  // from a desktop icon stays out of both: it is one click away already.
  const catalogue = $('catalogue');
  const addBtn = $('addBtn');
  const cat = popover(catalogue, addBtn, openCatalogue);
  const closeCatalogue = cat.close;
  const ASK = 'Starts a message to the agent — say what goes in';

  // A one-line box that drafts a message from what the user types.
  function askForm(placeholder, label, onSay) {
    const form = el('form', 'cat-ask');
    const box = el('input', 'cat-input');
    box.type = 'text';
    box.placeholder = placeholder;
    box.setAttribute('aria-label', label);
    form.append(box);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const said = box.value.trim();
      if (said) onSay(said);
    });
    return form;
  }

  function catItem({ icon, name, desc, title, onPick }) {
    const b = el('button', 'cat-item');
    b.type = 'button';
    const text = el('span', 'cat-text');
    text.append(el('span', 'cat-name', esc(name)));
    if (desc) text.append(el('span', 'cat-desc', esc(desc)));
    b.append(el('span', 'cat-ico', icon || '🪟'), text);
    if (title) b.title = title;
    b.addEventListener('click', () => { closeCatalogue({ focus: true }); onPick(); });
    return b;
  }

  // A window in the grid is a small mock of itself: a title bar, and under it the
  // sketch its component exports as `preview` — an HTML string drawn with the
  // shared .mk-* shapes. A kind with no sketch, or a suggestion with no kind,
  // shows its icon in the frame instead. A card the agent builds from what the
  // user says carries a ✎, so it is clear the click starts a message.
  function catCard({ icon, name, desc, note, title, preview, ask = false, onPick }) {
    const b = el('button', 'cat-card');
    b.type = 'button';
    const mock = el('span', 'mock');
    const bar = el('span', 'mock-bar');
    bar.append(el('i'), el('i'), el('span', 'mock-ttl', esc(name)));
    const body = el('span', 'mock-body');
    let sketch = '';
    try { sketch = typeof preview === 'function' ? preview() : ''; } catch (error) { console.error(error); }
    if (sketch) body.innerHTML = sketch;
    else body.append(el('span', 'mock-ico', icon || '🪟'));
    mock.append(bar, body);
    if (ask) mock.append(el('span', 'cat-pen', '✎'));
    if (note) mock.append(el('span', 'cat-here', esc(note)));
    b.append(mock, el('span', 'cat-name', esc(name)));
    b.title = [desc, title].filter(Boolean).join('\n');
    b.setAttribute('aria-label', [name, desc].filter(Boolean).join(': '));
    b.addEventListener('click', () => { closeCatalogue({ focus: true }); onPick(); });
    return b;
  }

  const grid = (cards) => { const g = el('div', 'cat-grid'); g.append(...cards); return g; };

  function openCatalogue() {
    const state = store.state;
    const here = new Map((state?.panels || []).map((panel) => [panel.kind, panel.id]));
    const iconed = new Set((state?.icons || []).filter((icon) => icon.kind === 'window').map((icon) => icon.panel));
    const body = [];

    // One grid, no sections: windows that go straight up and windows the agent
    // fills sit side by side, the agent's suggestions for this project first.
    const cards = [];
    for (const s of (state?.suggestions || []).filter((s) => s?.label && s?.prompt)) {
      cards.push({ icon: '✦', name: s.label, desc: s.hint || '', ask: true,
        title: ASK, onPick: () => arm(s.prompt) });
    }
    const kinds = [
      // A kind that opens many times (`multiple`, like Browser) is always here: a
      // desktop icon reaching one of them says nothing about wanting another.
      ...catalogueKinds().filter((spec) => spec.multiple || !iconed.has(here.get(spec.kind))),
      ...askableKinds(),
    ].sort(byTitle);
    for (const spec of kinds) {
      const name = spec.title || spec.kind;
      const common = { icon: spec.icon, name, desc: spec.description, preview: spec.preview };
      if (!spec.catalogue) {
        cards.push({ ...common, ask: true, title: ASK, onPick: () => arm(spec.ask) });
        continue;
      }
      const existing = spec.multiple ? null : here.get(spec.kind);
      cards.push({
        ...common, note: existing ? 'open' : '',
        title: existing ? 'Already on the desk — click to bring it to the front' : 'Click to add it to the desk',
        onPick: () => (existing ? openWin(existing)
          : request('/api/panel/add', { kind: spec.kind })
            .catch((error) => composerNote(`Could not add the window: ${error.message}`))),
      });
    }
    body.push(el('p', 'cat-head', 'Add a window'), grid(cards.map(catCard)));

    // Someone sent you a window or a skin.
    body.push(catItem({ icon: '📦', name: 'Add from file…', desc: 'Install a window or skin someone shared as a ZIP',
      title: 'Install a shared window or skin (you can also drop the ZIP on the desk)', onPick: pickComponentFile }));

    // The way out when nothing above is it: say what you want in your own words.
    body.push(askForm('or describe a window…', 'Describe a window', (said) => {
      closeCatalogue();
      arm(`Put a window on the desk: ${said}`);
    }));

    catalogue.replaceChildren(...body);
    cat.show();
    // It hangs off the ＋ at the end of the dock, so it opens upwards and can only
    // ever be as tall as the room above the dock — past that it scrolls.
    const r = addBtn.getBoundingClientRect();
    catalogue.style.maxHeight = `${Math.max(160, r.top - 16)}px`;
    const width = catalogue.offsetWidth;
    catalogue.style.left = `${Math.max(8, Math.min(r.right - width, innerWidth - width - 8))}px`;
    catalogue.style.top = `${Math.max(8, r.top - catalogue.offsetHeight - 8)}px`;
    catalogue.querySelector('button, input')?.focus();
  }

  // --- adding a shortcut -------------------------------------------------------
  // The ＋ after the shortcut icons adds one more icon. The agent makes shortcuts,
  // so this only asks what it should open and drafts the request.
  const shortcutMenu = $('shortcutMenu');
  const shortcutBtn = $('shortcutBtn');
  const shortcut = popover(shortcutMenu, shortcutBtn, openShortcut);

  function openShortcut() {
    const form = askForm('VS Code, figma.com, the Notepad window…', 'What should the shortcut open?', (said) => {
      shortcut.close();
      arm(`Add a shortcut to the top bar that opens ${said}.`);
    });
    shortcutMenu.replaceChildren(el('p', 'cat-head', 'Add a shortcut'),
      el('p', 'desk-note', 'What should it open? Your agent adds the icon. To remove one, ask your agent.'), form);
    shortcut.show();
    const r = shortcutBtn.getBoundingClientRect(), width = shortcutMenu.offsetWidth;
    shortcutMenu.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - width / 2, innerWidth - width - 8))}px`;
    shortcutMenu.style.top = `${r.bottom + 8}px`;
    form.querySelector('input').focus();
  }

  // --- the workspace menu -----------------------------------------------------
  // Every project runs its own desk on its own port. Closing the browser leaves
  // that server running, so the menubar button naming this desk's folder lists the
  // desks that are up: click one to go there, or press its × to shut it down.
  // Below them, the few desks stopped most recently: click one to start it again
  // and go there, or press its × to take it off the list.
  const desksMenu = $('desks');
  const deskBtn = $('deskBtn');
  const desksPop = popover(desksMenu, deskBtn, openDesks);

  let deskHome = '';
  const shortDir = (dir) => (deskHome && dir.startsWith(deskHome) ? '~' + dir.slice(deskHome.length) : dir);

  function deskRow(desk) {
    const row = el('div', `desk-row${desk.current ? ' is-current' : ''}${desk.running ? '' : ' is-stopped'}`);
    const go = el('button', 'desk-go');
    go.type = 'button';
    go.disabled = !!desk.current;
    go.title = desk.running ? desk.dir : `Start the ${desk.name} desk (${desk.dir})`;
    const text = el('span', 'cat-text');
    const desc = el('span', 'cat-desc', esc(shortDir(desk.dir)));
    text.append(el('span', 'cat-name', esc(desk.name)), desc);
    go.append(el('span', 'cat-ico', desk.current ? '●' : desk.running ? '○' : '◌'), text);
    if (desk.current) go.append(el('span', 'cat-here', 'here'));
    go.addEventListener('click', async () => {
      if (desk.running) { desksPop.close(); location.href = desk.url; return; }
      go.disabled = true;
      desc.textContent = 'Starting…';
      try {
        const { url } = await request('/api/desks/start', { dir: desk.dir });
        desksPop.close();
        location.href = url;
      } catch (error) {
        go.disabled = false;
        desc.textContent = shortDir(desk.dir);
        desksMenu.append(el('p', 'desk-note', esc(error.message || 'Could not start that desk.')));
      }
    });
    row.append(go);
    if (!desk.current) {
      const label = desk.running ? `Stop the ${desk.name} desk` : `Remove ${desk.name} from this list`;
      const x = el('button', 'desk-stop', '×');
      x.type = 'button';
      x.title = label;
      x.setAttribute('aria-label', label);
      x.addEventListener('click', async () => {
        x.disabled = true;
        try {
          const next = await request(desk.running ? '/api/desks/stop' : '/api/desks/forget', { dir: desk.dir });
          deskHome = next.home || deskHome;
          renderDesks(next.desks);
        }
        catch (error) {
          x.disabled = false;
          desksMenu.append(el('p', 'desk-note', esc(error.message || (desk.running ? 'Could not stop that desk.' : 'Could not remove that desk.'))));
        }
      });
      row.append(x);
    }
    return row;
  }

  function renderDesks(desks) {
    const running = desks.filter((desk) => desk.running);
    const stopped = desks.filter((desk) => !desk.running);
    const body = [el('p', 'cat-head', 'Workspaces'), ...running.map(deskRow)];
    if (running.length < 2) body.push(el('p', 'desk-note', 'No other desk is running.'));
    if (stopped.length) body.push(el('p', 'cat-head', 'Stopped'), ...stopped.map(deskRow));
    desksMenu.replaceChildren(...body);
  }

  async function openDesks() {
    desksMenu.replaceChildren(el('p', 'desk-note', 'Looking for desks…'));
    desksPop.show();
    const place = () => placeBelow(desksMenu, deskBtn, { fit: true });
    place();
    try {
      const { desks, home } = await fetch('/api/desks', { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
      if (desksMenu.hidden) return;
      deskHome = home || '';
      renderDesks(desks || []);
    } catch {
      desksMenu.replaceChildren(el('p', 'desk-note', 'Could not read the list of desks.'));
    }
    place();
  }

  // --- updating agents --------------------------------------------------------
  // Fireside runs agents it installed itself, pinned to exact versions, so a newer
  // release only reaches the desk when the user says so: it can change models
  // and behaviour, and every chat reconnects. The button appears when one is
  // behind. Fireside's own code needs no button; the desk restarts by itself once
  // no chat is replying. Nothing here is a git pull.
  const updatesMenu = $('updates');
  const updateBtn = $('updateBtn');
  const updates = popover(updatesMenu, updateBtn, openUpdates);

  let updating = false;   // Update was pressed and is still installing
  let updatesDrawn = '';  // what the open panel lists; every state push lands here

  function syncUpdateButton() {
    const pending = store.updates || [];
    updateBtn.hidden = !pending.length;
    updateBtn.title = pending.length > 1 ? `${pending.length} agents have updates`
      : pending.length ? `${pending[0].label} ${pending[0].from} → ${pending[0].to}` : '';
    if (!pending.length) { updating = false; updates.close(); }
    else if (!updatesMenu.hidden && !updating && JSON.stringify(pending) !== updatesDrawn) renderUpdates();
  }

  function renderUpdates() {
    const pending = store.updates || [];
    updatesDrawn = JSON.stringify(pending);
    const body = [el('p', 'cat-head', 'Update agents')];
    for (const item of pending) {
      const row = el('div', 'upd-row');
      const head = el('div', 'upd-head');
      head.append(el('span', 'upd-name', esc(item.label)), el('span', 'upd-ver', esc(`${item.from} → ${item.to}`)));
      row.append(head, el('code', 'upd-pkg', esc(item.name)), el('p', 'upd-what', esc(item.what || '')));
      body.push(row);
    }

    const go = el('button', 'upd-go', 'Update');
    go.type = 'button';
    const note = el('p', 'upd-note', '');
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'Updating…';
      updating = true;
      try {
        note.textContent = 'Installing. Chats reconnect when it finishes.';
        await request('/api/updates/apply', { names: pending.map((item) => item.name) }, { signal: AbortSignal.timeout(20 * 60 * 1000) });
        updating = false;
        syncUpdateButton();
      } catch (error) {
        updating = false;
        go.disabled = false;
        go.textContent = 'Update';
        note.textContent = error.message || 'Could not update.';
      }
    });
    body.push(go, note);
    // Two things the user cannot see from here and would reasonably assume wrong.
    body.push(el('p', 'upd-foot', 'Fireside’s own code is not updated by this — only the packages it runs. Every desk on this machine shares them, so this changes all of them at once.'));
    updatesMenu.replaceChildren(...body);
  }

  function openUpdates() {
    renderUpdates();
    updates.show();
    placeBelow(updatesMenu, updateBtn);
  }

  return { syncUpdateButton };
}
