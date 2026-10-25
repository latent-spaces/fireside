import { createScope } from './runtime.js';
// Every window, including chat, is loaded from a component folder.
const KINDS = new Map();
const LOADED = new Map();
const CLEANUPS = new WeakMap();
const SERVICES = new Map();

export function defineWindow(spec) {
  KINDS.set(spec.kind, { icon: '🪟', height: 280, fill: false, feeds: [], catalogue: false, description: '', ask: '', ...spec });
}

export const byTitle = (a, b) => (a.title || a.kind).localeCompare(b.title || b.kind);

/** The kinds the desk can put up on its own: useful the moment they open, with
 *  nothing for the agent to fill. A kind says so itself — `feeds` is not the
 *  signal, since `stream` feeds on lines yet needs a source the agent supplies. */
export const catalogueKinds = () => [...KINDS.values()].filter((spec) => spec.catalogue).sort(byTitle);

/** The kinds that are a frame and no content: the desk cannot fill them, but the
 *  user can say what goes in. `ask` is the draft their answer completes. */
export const askableKinds = () => [...KINDS.values()].filter((spec) => spec.ask && !spec.catalogue).sort(byTitle);

/** Missing implementations report their own kind rather than substituting another. */
export const windowKind = (kind) => KINDS.get(kind) || {
  kind, icon: '⚠', height: 280, feeds: [],
  render() { throw new Error(`Window component unavailable: ${kind}`); },
};

export function renderWindow(panel, ctx) {
  const spec = windowKind(panel.kind);
  const scope = createScope(ctx);
  const context = scope.context;
  const cleanup = (root) => {
    scope.dispose();
    try { spec.dispose?.(root, panel, context); } catch (error) { console.error(error); }
  };
  try {
    const root = spec.render(panel, context);
    CLEANUPS.set(root, { dispose: () => cleanup(root), close: () => spec.beforeClose?.(root, panel, context) });
    return root;
  } catch (error) { cleanup(null); throw error; }
}

export const closeWindow = (root) => CLEANUPS.get(root)?.close();

export function disposeWindow(root) {
  CLEANUPS.get(root)?.dispose();
  CLEANUPS.delete(root);
}


export const naturalHeights = () => Object.fromEntries([...KINDS].map(([kind, spec]) => [kind, spec.height]));
export const naturalWidths = () => Object.fromEntries([...KINDS].filter(([, spec]) => spec.width).map(([kind, spec]) => [kind, spec.width]));

export async function prepareWindows(kinds = null) {
  for (const [kind, service] of SERVICES) {
    if (!kinds || kinds.includes(kind)) await service.prepareReload?.();
  }
}

export async function loadWindows(ctx, prepare = async () => {}) {
  const response = await fetch('/api/windows');
  if (!response.ok) throw new Error(`Windows: HTTP ${response.status}`);
  const { windows } = await response.json();
  const next = new Map(windows.map((manifest) => [manifest.kind, JSON.stringify(manifest)]));
  const changed = [...new Set([...LOADED.keys(), ...next.keys()])].filter((kind) => LOADED.get(kind) !== next.get(kind));
  await prepare(changed);
  for (const kind of changed) {
    SERVICES.get(kind)?.dispose(); SERVICES.delete(kind);
    if (!next.has(kind)) {
      KINDS.delete(kind); LOADED.delete(kind);
      document.querySelector(`link[data-window-kind="${kind}"]`)?.remove();
    }
  }
  await Promise.all(windows.filter((manifest) => changed.includes(manifest.kind)).map(async (manifest) => {
    const dir = `/windows/${encodeURIComponent(manifest.kind)}/~${manifest.revision}`;
    document.querySelector(`link[data-window-kind="${manifest.kind}"]`)?.remove();
    if (manifest.css) {
      const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${dir}/window.css` });
      link.dataset.windowKind = manifest.kind;
      document.head.append(link);
    }
    try {
      const { default: code } = await import(/* @vite-ignore */ `${dir}/window.js`);
      if (typeof code?.render !== 'function') throw new Error('Expected a render function');
      if (code.setup) {
        const scope = createScope(ctx);
        let service;
        try { service = await code.setup(scope.context); }
        catch (error) { scope.dispose(); throw error; }
        SERVICES.set(manifest.kind, {
          prepareReload: service?.prepareReload,
          dispose() { try { service?.dispose?.(); } finally { scope.dispose(); } },
        });
      }
      defineWindow({ ...manifest, ...code });
    } catch (error) {
      defineWindow({ ...manifest, render() { throw new Error(`Window ${manifest.kind}: ${error.message}`); } });
    }
    LOADED.set(manifest.kind, next.get(manifest.kind));
  }));
  return changed;
}
