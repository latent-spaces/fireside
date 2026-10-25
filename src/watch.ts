import fs from 'node:fs';
import path from 'node:path';
import { layers, firesideDir, dataDir, statePath, PKG_ROOT, CLIENT_DIR } from './paths.ts';

// Watch state, component definitions (including new folders), and the server's own code.
export function watchDesk(root: string, onState: () => void, onComponents: (changes: {windows: string[]; skins: boolean}) => void, onCode: () => void, onShell: (css: boolean) => void) {
  const changedWindows = new Set<string>();
  let changedSkins = false;
  const emitComponents = () => {
    onComponents({ windows: [...changedWindows], skins: changedSkins });
    changedWindows.clear(); changedSkins = false;
  };
  const watchers: fs.FSWatcher[] = [];
  const timers = new Map<string, NodeJS.Timeout>();
  const debounce = (key: string, fn: () => void) => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(fn, 100));
  };
  const watch = (folder: string, options: fs.WatchOptions, fn: (name: string) => void) => {
    watchers.push(fs.watch(folder, options, (_event, name) => fn(String(name || ''))));
  };
  watch(firesideDir(root), {}, (name) => {
    if (name === path.basename(statePath(root))) debounce('state', onState);
  });
  watch(dataDir(root), {}, () => debounce('state', onState));
  for (const type of ['windows', 'skins']) {
    for (const folder of layers(type, root)) {
      fs.mkdirSync(folder, { recursive: true });
      watch(folder, { recursive: true }, (name) => {
        const id = name.split(/[\\/]/)[0];
        if (id.startsWith('.')) return;
        if (type === 'windows') changedWindows.add(id); else changedSkins = true;
        debounce('components', emitComponents);
      });
    }
  }
  watch(path.join(PKG_ROOT, 'src'), {}, (name) => {
    if (/\.(ts|mjs)$/.test(name)) debounce('code', onCode);
  });
  watch(CLIENT_DIR, {}, (name) => {
    if (/\.css$/.test(name)) debounce('shell-css', () => onShell(true));
    else if (/\.(js|html)$/.test(name)) debounce('shell', () => onShell(false));
  });
  return () => {
    for (const watcher of watchers) watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
