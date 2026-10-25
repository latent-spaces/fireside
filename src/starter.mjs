import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { appIcon } from './launchers.mjs';
import { PKG_ROOT, statePath } from './paths.ts';
import { defaultState, writeState } from './state.mjs';

// Called only when a project has no state.json. Returning users own their desk.
export function seedDesktop(state, root) {
  const panels = [
    { id: 'chat', kind: 'chat', title: 'Chat', span: 5, order: 1 },
    { id: 'tokens', kind: 'tokens', title: 'Usage', order: 3, collapsed: true },
    { id: 'skins', kind: 'skins', title: 'Skins', span: 6, order: 50, collapsed: true },
    { id: 'solitaire', kind: 'solitaire', title: 'Solitaire', span: 6, order: 70, collapsed: true },
    { id: 'wiki', kind: 'browser', title: 'Random Wikipedia', span: 6, height: 520, order: 80, collapsed: true, remember: false, url: 'https://en.wikipedia.org/wiki/Special:Random' },
  ];
  state.panels = panels;
  const art = (file) => 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(PKG_ROOT, 'windows', file)).toString('base64');
  state.icons = [
    { id: 'skins', label: 'Skins', image: art('skins/icon.svg') },
    { id: 'solitaire', label: 'Solitaire', image: art('solitaire/icon.svg') },
    { id: 'wiki', label: 'Random Wiki', image: art('browser/random.svg') },
  ].map(icon => ({ ...icon, kind: 'window', panel: icon.id }));

  // Never copy a personal launcher path. Only offer apps present on this Mac.
  if (process.platform === 'darwin') {
    for (const [id, label, name] of [
      ['chrome', 'Chrome', 'Google Chrome.app'],
      ['vscode', 'VS Code', 'Visual Studio Code.app'],
      ['terminal', 'Terminal', 'Utilities/Terminal.app'],
      ['spotify', 'Spotify', 'Spotify.app'],
    ]) {
      const app = ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')]
        .map(dir => path.join(dir, name)).find(file => fs.existsSync(file));
      if (!app) continue;
      const cmd = id === 'vscode' ? ['open', '-a', app, root] : ['open', '-a', app];
      const icon = { id, label, kind: 'exec', cmd, glyph: id === 'terminal' ? '⌘' : '↗' };
      try { icon.image = appIcon(root, app, id); } catch { /* Keep a working shortcut if icon extraction fails. */ }
      state.icons.push(icon);
    }
  }
  return state;
}

/** Same first-run initialization for the CLI and development server. */
export function initializeDesktop(root) {
  if (fs.existsSync(statePath(root))) return;
  const state = defaultState(root);
  seedDesktop(state, root);
  writeState(state, root);
}
