import { createMenus } from './menus.js';
import { createDesktop } from './desktop.js';
import { md } from './markdown.js';
import { createLayoutStore } from './layout-store.js';
import { windowKind, loadWindows, prepareWindows, renderWindow, disposeWindow } from './windows.js';
import { createSkins } from './skins.js';
import { connectDesk } from './live.js';
import { createRuntime } from './runtime.js';
import { createRecovery } from './recovery.js';
import { shouldTour, startTour } from './tour.js';
import { shouldLight, lightFire } from './fire.js';
// Fireside UI — a little desktop. Panels from .fireside/state.json become
// draggable windows. The page itself never scrolls; windows do.
//
// Claude owns *what* exists (the state file). The viewer owns *where* it sits
// (.fireside/layout.json). Closing a window never deletes the panel — it drops to the
// dock, so Claude's board and your arrangement don't fight each other.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// A project file's address. A query or hash rides along (an agent adds ?v=2 to show a
// file it changed), and an absolute path keeps its slash for the server to place.
const fileURL = (p) => {
  if (/^(https?:|data:|blob:|\/files\/)/.test(p)) return p;
  const [, file, tail] = /^([^?#]*)(.*)$/s.exec(String(p).replace(/^\.\//, ''));
  return '/files/' + file.split('/').map(encodeURIComponent).join('/') + tail;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Everything the server tells the page, in one place. Windows read it as ctx.store.
const store = { state: null, buffers: {}, activity: [], chat: [], git: null, subscriptions: null, usage: null, skins: [], acp: null, tabs: null, updates: [] };
const APP = 'Fireside';
// Window tint hues come from the panel id. Left unbounded they spray the whole
// spectrum, which is fine on a plain ground and fights anything pictorial, so a
// skin can pin the range its artwork lives in.
let tintRange = { from: 0, span: 360 };
const WINS = new Map();          // id -> { el, body, bar, sig }

// --- viewer-owned geometry --------------------------------------------------
let GEO = Object.create(null);
const layoutStore = createLayoutStore(() => GEO, request, (message) => composerNote(message));
const saveGeo = () => layoutStore.schedule();

// --- skins ------------------------------------------------------------------
// A skin can pin the hue range window tints live in; windows that follow
// "theme" redraw once it is on.
const skins = createSkins({ $, el, request, onApplied: (skin) => {
  tintRange = skin.tint || { from: 0, span: 360 };
  paintTints();
  // The next load's splash opens in these colours (see index.html).
  try {
    const ground = getComputedStyle(document.documentElement).getPropertyValue('--ground').trim();
    localStorage.setItem('fireside:boot', JSON.stringify({ theme: skin.base, ground }));
  } catch { /* The splash falls back to the default palette. */ }
  // The skin itself is the news: a window that can re-dress in place takes it,
  // rather than being rebuilt and losing whatever it was in the middle of.
  notify('theme', skin);
} });

// Shared commands are supplied by components.
const runtime = createRuntime(error => composerNote(`Component update failed: ${error.message}`));
const { command } = runtime;
const arm = (...args) => command('arm', ...args);
let recovery = null, recoveryProject = null;
let projectChanged = false;
let shell = null;   // the shell fingerprint this page loaded with
const recoveryWarning = el('div', 'composer-note');
recoveryWarning.setAttribute('role', 'alert');
recoveryWarning.hidden = true;
$('notices').append(recoveryWarning);
function initializeRecovery(project) {
  if (projectChanged) return false;
  if (!project || recoveryProject === project) return true;
  if (recoveryProject) {
    projectChanged = true;
    layoutStore.pause();
    recoveryWarning.hidden = false;
    recoveryWarning.textContent = 'This address now serves a different project. Copy any unsaved text, then reload to open it. Sending and saving are paused.';
    return false;
  }
  recoveryProject = project;
  recovery = createRecovery(project, undefined, failed => {
    if (projectChanged) return;
    recoveryWarning.hidden = !failed;
    recoveryWarning.textContent = 'Browser recovery is unavailable. Keep this page open and copy any unsent or unsaved text before reloading.';
  });
  return true;
}

async function request(route, payload, options = {}) {
  if (projectChanged) throw new Error('The project at this address changed. Copy unsaved text and reload first.');
  const response = await fetch(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fireside-Request': '1' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30000), ...options,
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

/** Shared notices stay visible alongside component tray controls. */
function composerNote(message) {
  document.querySelector('.composer-note:not([role=alert])')?.remove();
  const n = el('div', 'composer-note', esc(message));
  $('notices').append(n);
  setTimeout(() => n.remove(), 7000);
}

// What a window's render(panel, ctx) and update(root, news, panel, ctx) can use.
const ctx = {
  ...runtime, el, esc, md, fileURL, actionRow, openKind, store, request, notice: composerNote,
  slots: { tray: $('trayComponents') },
  onDrag: (...args) => onDrag(...args),
  send: (...args) => command('send', ...args),
  get recovery() { return recovery; },
  // The desk's theme lives in its state: ask the server to change it and the
  // state that comes back is what gets applied. Painting it here as well would
  // leave the applied skin and the state disagreeing until the next push, which
  // is how a skin picker ends up one choice behind.
  chooseSkin: (id) => request('/api/skin', { id }).catch((error) => composerNote(error.message)),
  // Trusted windows write instance data into the shared project store.
  // A saving window owns recovery: do not turn a rejected write into success.
  save: (id, data) => request('/api/panel/data', { id, data }),
  // Run one of the commands a window's window.json lists under `commands`, by name.
  // Resolves once the command has finished; rejects with why it failed.
  run: (id, command) => request('/api/window/command', { id, command }),
  // Run any command (an argument list, no shell) and get { code, stdout, stderr }.
  share: (type, id, anchor) => shareComponent(type, id, anchor),
  exec: (cmd, { cwd, timeout = 25000 } = {}) => request('/api/exec', { cmd, cwd, timeout }, { signal: AbortSignal.timeout(timeout + 5000) }),
  refreshSubscriptions: () => request('/api/subscriptions/refresh', {}),
  wakeUsage: () => request('/api/subscriptions/wake', {}),
};

const renderPanel = (p) => renderWindow(p, ctx);

/**
 * Pass live news to the open windows that follow a feed. A window with update()
 * takes the news itself; any other window, or a feed with no news, redraws.
 */
function notify(feed, news) {
  runtime.publish(feed, news);
  for (const p of store.state?.panels || []) {
    const w = WINS.get(p.id), kind = windowKind(p.kind);
    if (!w || !kind.feeds.includes(feed)) continue;
    if (kind.update && news) kind.update(w.body.firstElementChild, news, p, ctx);
    else fillBody(w, p);
  }
}

// A kind already on the desk comes forward rather than arriving twice.
function openKind(kind) {
  const existing = store.state?.panels?.find((p) => p.kind === kind);
  if (existing) return openWin(existing.id);
  return request('/api/panel/add', { kind }).then(({ id }) => { pendingOpen = id; })
    .catch((error) => { composerNote(`Could not open that window: ${error.message}`); return false; });
}

function actionRow(items) {
  const box = el('div', 'acts');
  for (const it of items) {
    const b = el('button', 'act' + (it.tone ? ' ' + it.tone : ''));
    b.type = 'button';
    b.append(el('span', null, esc(it.label)));
    if (it.disabled) {
      b.disabled = true;
      b.append(el('span', 'why', esc(it.disabled)));
    } else {
      b.title = it.prompt || '';
      b.addEventListener('click', () => (it.window ? openKind(it.window) : arm(it.prompt, { immediate: it.immediate, label: it.label })));
    }
    box.append(b);
  }
  return box;
}

// Sandboxed HTML panels may prepare a prompt, but never send one implicitly.
addEventListener('message', (event) => {
  if (event.data?.type !== 'fireside-prompt' || typeof event.data.prompt !== 'string') return;
  const frames = [...WINS.values()].map((win) => win.body.querySelector('.panel-html'));
  if (frames.some((frame) => frame?.contentWindow === event.source)) arm(event.data.prompt, { label: event.data.label });
});

let pendingOpen = null;

// --- desktop icons ----------------------------------------------------------
// They live on the wallpaper, behind every window, and are dragged and
// remembered the same way windows are.

function activateIcon(ic) {
  if (ic.kind === 'window') {
    if ((store.state?.panels || []).some((p) => p.id === ic.panel)) return openWin(ic.panel);
    // Its window was deleted: the icon kept it, so ask for it back, then open it.
    return request('/api/icon/restore', { id: ic.id })
      .then(() => { pendingOpen = ic.panel; })
      .catch((error) => composerNote(`Could not bring back ${ic.label || ic.id}: ${error.message}`));
  }
  if (ic.kind === 'prompt') return arm(ic.prompt, { label: ic.label });
  if (ic.kind === 'url') return window.open(ic.url, '_blank', 'noreferrer');
  if (ic.kind === 'exec') return request('/api/icon', { id: ic.id }).catch((error) => composerNote(`Could not launch ${ic.label || ic.id}: ${error.message}`));
}

// --- sharing ------------------------------------------------------------------
// A window or skin leaves as a ZIP of its code and assets (none of the project's
// content) and comes back in through the catalogue or a drop onto the desk.

function downloadComponent(type, id) {
  const a = el('a');
  a.href = `/api/component/export?type=${type}&id=${encodeURIComponent(id)}`;
  a.download = `fireside-${type}-${id}.zip`;
  document.body.append(a);
  a.click();
  a.remove();
}

// ⇪ asks first: what is being shared, a download, and a message to send with it.
const shareDialog = $('shareDialog');

function closeShare({ focus = false } = {}) {
  if (shareDialog.hidden) return;
  shareDialog.hidden = true;
  if (focus) shareDialog.anchor?.focus();
}

function shareComponent(type, id, anchor = null) {
  const spec = type === 'window' ? windowKind(id) : (store.skins || []).find((skin) => skin.id === id) || {};
  const name = spec.title || spec.name || id;
  const icon = type === 'window' ? spec.icon || '🪟' : '🎨';
  const message = `Here's a Fireside ${type} I like: ${name} ${icon}\n\n`
    + `To add it, drop the attached ZIP onto your Fireside desk, or click ＋ → Add from file…\n\n`
    + `Don't have Fireside yet? https://github.com/latent-spaces/fireside`;

  const row = el('div', 'upd-row');
  const head = el('div', 'upd-head');
  head.append(el('span', 'upd-name', esc(`${icon} Want to share this ${type === 'window' ? 'window style' : 'skin'}?`)));
  row.append(head, el('p', 'upd-what', esc(type === 'window'
    ? `Your friends get the ${name} window's look and code, not what's in it on your desk.`
    : `Your friends get the ${name} skin: its colours and artwork.`)));
  const download = el('button', 'upd-go', 'Download ZIP');
  download.type = 'button';
  download.addEventListener('click', () => { downloadComponent(type, id); download.textContent = 'Downloaded ✓'; });
  row.append(download);

  const text = el('textarea', 'share-msg');
  text.readOnly = true;
  text.rows = message.split('\n').length + 2;   // roomy enough to read without scrolling
  text.value = message;
  text.setAttribute('aria-label', 'Message to send with the ZIP');
  const copy = el('button', 'upd-go share-copy', 'Copy message');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(message); }
    catch { text.select(); document.execCommand('copy'); }
    copy.textContent = 'Copied ✓';
  });

  shareDialog.replaceChildren(el('p', 'cat-head', 'Share'), row,
    el('p', 'cat-head', 'Send it with this'), text, copy);
  shareDialog.anchor = anchor;
  shareDialog.hidden = false;
  // Beside the button when there is room, always fully on screen. Placed again
  // once laid out: the message box only takes its height after the first frame.
  const place = () => {
    const r = anchor?.getBoundingClientRect();
    const w = shareDialog.offsetWidth, h = shareDialog.offsetHeight;
    shareDialog.style.left = `${Math.max(8, Math.min(r ? r.right - w : (innerWidth - w) / 2, innerWidth - w - 8))}px`;
    shareDialog.style.top = `${Math.max(8, Math.min(r ? r.bottom + 6 : (innerHeight - h) / 2, innerHeight - h - 8))}px`;
  };
  place();
  requestAnimationFrame(place);
  download.focus();
}

addEventListener('pointerdown', (event) => {
  if (!shareDialog.hidden && !shareDialog.contains(event.target) && !shareDialog.anchor?.contains(event.target)) closeShare();
});
addEventListener('keydown', (event) => { if (event.key === 'Escape') closeShare({ focus: true }); });

// A shared ZIP is not installed here: it may be anything. The server checks it is
// a component and unpacks it into the inbox; the agent looks it over, asks about
// duplicates and whether to show it, and installs it.
async function installComponent(file) {
  const response = await fetch('/api/component/stage', {
    method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Fireside-Request': '1' }, body: file,
  });
  const got = await response.json().catch(() => ({}));
  if (!response.ok) return composerNote(`${file.name} is not a Fireside window or skin: ${got.error || `HTTP ${response.status}`}`);
  const already = got.existing?.length
    ? `A ${got.type} called "${got.id}" already exists here (${got.existing.join(', ')}).`
    : `Nothing called "${got.id}" is installed yet.`;
  const prompt = `Install the shared ${got.type} "${got.title}" (${got.id}) that I just added. `
    + `Its files are unpacked at ${got.folder} and the ZIP is ${got.zip}. ${already} `
    + `Follow the Fireside skill's steps for installing a shared component.`;
  const sent = await Promise.resolve(command('send', prompt, `Install ${got.title}`)).catch(() => false);
  if (sent) return;
  arm(prompt);
  composerNote(`Connect a chat and send the prepared message to install ${got.title}.`);
}

function pickComponentFile() {
  const input = el('input');
  input.type = 'file';
  input.accept = '.zip,application/zip';
  input.addEventListener('change', () => { if (input.files[0]) installComponent(input.files[0]); });
  input.click();
}

// Drop a component ZIP anywhere on the desk to install it.
const zipIn = (event) => [...(event.dataTransfer?.items || [])].some((item) => item.kind === 'file');
addEventListener('dragover', (event) => { if (zipIn(event)) event.preventDefault(); });
addEventListener('drop', (event) => {
  const files = [...(event.dataTransfer?.files || [])].filter((file) => /\.zip$/i.test(file.name));
  if (!files.length) return;
  event.preventDefault();
  for (const file of files) installComponent(file);
});

const { paintTints, onDrag, deskSize, openWin, renderIcons, syncWindows, renderDock, fillBody, applyGeo, tidy } = createDesktop({
  $, el, esc, fileURL, activateIcon, WINS, renderPanel, shareComponent,
  getState: () => store.state, getGeometry: () => GEO, getTint: () => tintRange,
  saveGeo,
  onChange: () => notify('desktop'),
  // The server removes the panel and its layout; the state event that follows
  // takes the window and its dock entry away.
  deletePanel: (id) => request('/api/panel/delete', { id })
    .then(() => { delete GEO[id]; })
    .catch((error) => composerNote(`Could not delete the window: ${error.message}`)),
});

// --- chrome -----------------------------------------------------------------
function render() {
  const s = store.state;
  if (!s) return;
  // The project is usually named something other than the app; when it isn't,
  // don't say it twice.
  document.title = s.title && s.title !== APP ? `${s.title} · ${APP}` : APP;
  // The menubar says Fireside, then names the folder this desk runs in. Both are
  // always there: the folder is the one thing every desk has, whatever it was
  // titled, so the bar reads the same on every project.
  const folder = s.project?.name || s.title || 'desk';
  $('deskBtnName').textContent = folder;
  $('deskBtn').title = `${s.project?.dir || folder}\nSwitch workspace`;
  syncUpdateButton();
  skins.apply(s.theme);

  const st = $('status');
  st.dataset.tone = s.status?.tone || 'idle';
  st.lastElementChild.textContent = s.status?.text || 'ready';
  renderIcons();
  syncWindows();
  fitTray();
  if (pendingOpen && (s.panels || []).some((p) => p.id === pendingOpen)) {
    const id = pendingOpen;
    pendingOpen = null;
    openWin(id);
  }
  renderDock();
  notify('chat');
}

// Component updates share one queue and save-before-refresh path. Shell edits
// reach the page through Vite instead.
let componentRevision = null;
let refreshQueue = Promise.resolve();
function refreshDesk({ componentRevision: revision }, force = false) {
  if (!force && componentRevision === revision) return;
  componentRevision = revision;
  $('staleBtn').hidden = true;
  refreshQueue = refreshQueue.then(async () => {
    const prepare = async (kinds = null) => {
      await prepareWindows(kinds);
      for (const panel of store.state?.panels || []) {
        if (!kinds || kinds.includes(panel.kind)) {
          await windowKind(panel.kind).prepareReload?.(WINS.get(panel.id)?.body.firstElementChild, panel, ctx);
        }
      }
    };
    const changed = await loadWindows(ctx, async (kinds) => {
      if (!kinds.length) return;
      await prepare(kinds);
      const response = await fetch('/api/state');
      if (!response.ok) throw new Error('Could not read saved window data');
      const saved = await response.json();
      if (saved.project !== recoveryProject) throw new Error('The project at this address changed');
      store.state = saved.state;
    });
    store.skins = await skins.load();
    for (const panel of store.state?.panels || []) {
      const win = WINS.get(panel.id);
      if (win && changed.includes(panel.kind)) win.sig = '';
    }
    render();
  }).catch((error) => {
    componentRevision = null;
    composerNote(`Refresh paused: ${error.message}`);
    $('staleBtn').hidden = false;
  });
}

// Full reconnects and active-chat updates use the same rendering path.
function applySnapshot(view) {
  const usage = JSON.stringify(store.usage);
  Object.assign(store, view);
  notify('snapshot');
  render();
  if (JSON.stringify(store.usage) !== usage) notify('usage');
  fire?.sync();
  tourWhenReady();
}

const { syncUpdateButton } = createMenus({ $, el, esc, store, request, composerNote, openWin, arm, pickComponentFile });

$('tidyBtn').addEventListener('click', tidy);
$('staleBtn').addEventListener('click', () => refreshDesk({ componentRevision: Date.now() }, true));
const tick = () => { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
tick(); setInterval(tick, 10000);

// Keep windows reachable and icons in their cells when the desktop changes size.
const refit = () => {
  for (const [id, w] of WINS) {
    applyGeo(w.el, GEO[id]);
  }
  renderIcons();
};
addEventListener('resize', refit);

// The desk ends where the tray begins. The tray is only as tall as what it shows:
// components may add tray controls, and the desk follows the space they use.
// The size is set on the desk itself: the page root's inline variables belong to the skin.
// It runs on load, after state updates,
// and whenever the tray resizes on its own.
const tray = document.querySelector('footer.tray');
const deskEl = $('desk');
function fitTray() {
  const h = `${Math.ceil(tray.getBoundingClientRect().height)}px`;
  if (deskEl.style.getPropertyValue('--tray') === h) return;
  deskEl.style.setProperty('--tray', h);
  refit();
}
new ResizeObserver(fitTray).observe(tray);
fitTray();

// The splash stays up until the first state is drawn, and long enough for one hop
// so a fast load reads as a beat rather than a flicker.
function liftSplash() {
  const boot = $('boot');
  if (!boot || boot.classList.contains('done')) return;
  setTimeout(() => requestAnimationFrame(() => {
    boot.classList.add('done');
    setTimeout(() => boot.remove(), 400);
  }), Math.max(0, 800 - performance.now()));
}

// What this machine has already seen. Read once a page; `toured` is the mark that
// no folder needs the tour again.
let machine = null;
let fire = null, desked = false, touring = false;

// The tour shows a working desk, so it waits for the fire and an open chat. It
// leaves a newcomer's first question ready in the chat box, theirs to send.
function tourWhenReady() {
  if (!desked || touring || fire) return;
  const connected = !!store.acp?.sessionId || store.acp?.status === 'asleep';
  if (!shouldTour(machine, connected)) return;
  touring = true;
  const box = () => document.querySelector('.chat textarea');
  const fresh = !machine.toured && box() && !box().value.trim() && !store.chat?.length;
  const ask = () => (box()?.value.trim() ? box().focus() : arm('What can I do here in Fireside?'));
  setTimeout(() => startTour(() => request('/api/toured', {}).catch(() => {}), fresh ? ask : null), 1100);
}

// Windows load before the first snapshot, so every panel has its kind on arrival.
const firstRun = fetch('/api/first-run').then((response) => response.json()).then((seen) => { machine = seen; });
Promise.all([skins.load().then((list) => { store.skins = list; }), loadWindows(ctx), firstRun]).then(() => connectDesk({ store, notify, render,
  snapshot(d) {
    // The shell this page runs is no longer the one on disk: an edit to client/,
    // or a pull while the server was down. Anything else, a server restart
    // included, carries on in place.
    shell ??= d.shell;
    if (d.shell && d.shell !== shell) {
      sessionStorage.setItem('fireside:updated', '1');   // said once the new page is up
      location.reload();
      return false;
    }
    liftSplash();
    if (sessionStorage.getItem('fireside:updated')) {
      sessionStorage.removeItem('fireside:updated');
      composerNote('Fireside was updated, so this page reloaded to pick it up.');
    }
    if (!initializeRecovery(d.project)) return false;
    if (layoutStore.initialize(d.layout)) {
      GEO = Object.assign(Object.create(null), d.layout || {});
      for (const win of WINS.values()) { disposeWindow(win.body.firstElementChild); win.el.remove(); }
      WINS.clear();
    }
    $('stateError').hidden = !d.stateError;
    $('stateError').textContent = d.stateError || '';
    applySnapshot(d);
    for (const feed of ['git', 'subscriptions', 'lines', 'activity']) notify(feed);
    refreshDesk(d);
    if (!desked) {
      desked = true;
      if (shouldLight(d.state, store.tabs)) fire = lightFire({ store, request, machine, onDone() { fire = null; tourWhenReady(); } });
      tourWhenReady();
    }
    return true;
  },
  update: applySnapshot,
  offline() { liftSplash(); const status = $('status'); status.dataset.tone = 'off'; status.lastElementChild.textContent = 'server offline'; },
})).catch(error => { liftSplash(); composerNote(`Could not load the desktop: ${error.message}`); });
