import fs from 'node:fs';
import path from 'node:path';
import { writeJSON } from './storage.mjs';
import { validCommand } from './launchers.mjs';
import { acquireLock } from './lock.mjs';
import { statePath, ensureDirs, projectDir, dataDir } from './paths.ts';
import { KIND } from './catalog.ts';

/** A panel's `data` names a file in .fireside/data by this pattern, or is inline JSON. */
export const DATA_FILE = /^[\w.-]+\.json$/;

/** The state as windows see it: a panel's data file read into `data`, or `dataError` saying why not. */
/** @returns {import("./contracts.ts").DeskState} */
export function withData(state, dir) {
  const panels = state.panels.map((panel) => {
    if (typeof panel.data !== 'string') return panel;
    try { return { ...panel, data: JSON.parse(fs.readFileSync(path.join(dataDir(dir), panel.data), 'utf8')) }; }
    catch (error) { return { ...panel, data: null, dataError: `.fireside/data/${panel.data}: ${error.code === 'ENOENT' ? 'not found' : error.message}` }; }
  });
  return { ...state, panels };
}

/** @returns {import("./contracts.ts").DeskState} */
export function defaultState(dir) {
  const root = projectDir(dir);
  return {
    version: 1,
    project: { name: path.basename(root), dir: root },
    title: path.basename(root),
    theme: {},
    status: { text: 'ready', tone: 'idle' },
    // Windows the agent suggests for this project, offered beside the built-in
    // kinds in the desk's ＋ catalogue. Each one is a draft, not a panel.
    suggestions: [],
    icons: [],
    panels: [],
  };
}

/** @returns {import("./contracts.ts").DeskState} */
export function validateState(raw, dir) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('state must be an object');
  const defaults = defaultState(dir);
  const state = { ...defaults, ...raw };
  for (const key of ['panels', 'icons', 'suggestions']) {
    if (!Array.isArray(state[key])) throw new Error(`${key} must be an array`);
  }
  const ids = new Set();
  for (const panel of state.panels) {
    if (!panel || typeof panel.id !== 'string' || !panel.id || Object.hasOwn(Object.prototype, panel.id) || ids.has(panel.id)) throw new Error('panel ids must be unique, nonempty strings');
    if (typeof panel.kind !== 'string' || !KIND.test(panel.kind)) throw new Error('panel kind must be a component ID');
    for (const key of ['span', 'height', 'order']) {
      if (panel[key] !== undefined && !Number.isFinite(panel[key])) throw new Error(`${panel.id}.${key} must be a number`);
    }
    if (panel.span !== undefined && (panel.span < 1 || panel.span > 12)) throw new Error('span must be between 1 and 12');
    if (panel.file && (typeof panel.file !== 'string' || path.basename(panel.file) !== panel.file)) throw new Error('Panel file must be a filename');
    if (panel.data !== undefined && !(typeof panel.data === 'string' ? DATA_FILE.test(panel.data) : panel.data && typeof panel.data === 'object')) {
      throw new Error(`${panel.id}.data must be inline JSON or a .json filename in .fireside/data`);
    }
    ids.add(panel.id);
  }
  if (!state.theme || typeof state.theme !== 'object') throw new Error('theme must be an object');
  state.theme = { ...state.theme };
  delete state.theme.mode;
  // theme.accent only ever coloured the default skin. theme.vars apply over any
  // skin; a custom accent carries over, the old default is just dropped.
  if ('accent' in state.theme) {
    const { accent } = state.theme;
    if (typeof accent === 'string' && accent.toUpperCase() !== '#F2789F') state.theme.vars = { '--accent': accent, ...state.theme.vars };
    delete state.theme.accent;
  }
  const { vars } = state.theme;
  if (vars !== undefined && (!vars || typeof vars !== 'object' || Array.isArray(vars) || Object.values(vars).some((v) => typeof v !== 'string'))) {
    throw new Error('theme.vars must map CSS variables to strings');
  }
  const iconIds = new Set();
  for (const icon of state.icons) {
    if (!icon || typeof icon.id !== 'string' || !icon.id || iconIds.has(icon.id)) throw new Error('Icon ids must be unique, nonempty strings');
    if (!['exec', 'prompt', 'url', 'window'].includes(icon.kind)) throw new Error(`Unknown icon kind: ${icon.kind}`);
    if (icon.kind === 'exec' && !validCommand(icon.cmd)) throw new Error(`Invalid command for icon ${icon.id}`);
    iconIds.add(icon.id);
  }
  state.project = defaults.project;
  return state;
}

/** @returns {import("./contracts.ts").DeskState} */
export function readState(dir) {
  try { return validateState(JSON.parse(fs.readFileSync(statePath(dir), 'utf8')), dir); }
  catch (error) {
    if (error.code === 'ENOENT') return defaultState(dir);
    throw new Error(`Cannot read ${statePath(dir)}: ${error.message}`);
  }
}

function save(state, dir) {
  const next = validateState(state, dir);
  writeJSON(statePath(dir), next);
  return next;
}

function withLock(dir, fn) {
  ensureDirs(dir);
  const release = acquireLock(statePath(dir) + '.lock');
  try { return fn(); } finally { release(); }
}

export function writeState(state, dir) {
  return withLock(dir, () => save(state, dir));
}

/** @param {(state: import("./contracts.ts").DeskState) => import("./contracts.ts").DeskState | void} fn */
export function mutate(fn, dir) {
  return withLock(dir, () => {
    const state = readState(dir);
    return save(fn(state) || state, dir);
  });
}

/** Both the CLI and trusted windows save instance data through this path. */
export function savePanelData(id, data, dir) {
  let name;
  mutate((state) => {
    const panel = state.panels.find((panel) => panel.id === id);
    if (!panel) throw Object.assign(new Error(`Unknown window: ${id}`), { status: 404 });
    name = typeof panel.data === 'string' ? panel.data : `${id}.json`;
    if (!DATA_FILE.test(name)) throw Object.assign(new Error('Invalid data file name'), { status: 400 });
    writeJSON(path.join(dataDir(dir), name), data);
    panel.data = name;
  }, dir);
  return name;
}

/** Insert or merge a panel by id, keeping the list sorted by `order`. */
export function upsertPanel(state, panel) {
  const i = state.panels.findIndex((p) => p.id === panel.id);
  if (i === -1) {
    const order = panel.order ?? (state.panels.length ? Math.max(...state.panels.map((p) => p.order ?? 0)) + 10 : 10);
    state.panels.push({ span: 6, ...panel, order });
  } else {
    state.panels[i] = { ...state.panels[i], ...panel };
  }
  state.panels.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return state;
}

