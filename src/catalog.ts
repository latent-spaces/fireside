import fs from 'node:fs';
import path from 'node:path';
import { layers } from './paths.ts';
import type { Skin } from './contracts.ts';

export const KIND = /^[a-z][a-z0-9-]*$/;
const FROM = ['built-in', '~/.fireside', 'project'];

// One name, one component. Built-in, then ~/.fireside, then the project: the
// first definition of a name is the one used, and a later folder with the same
// name is skipped, never swapped in. A copy quietly standing in for a built-in
// is how a desk ends up running code nobody is editing. Change a built-in in
// windows/ (or send a PR); give your own variant a name of its own.
const skipped = new Set<string>();
function skip(type: string, id: string, file: string) {
  if (skipped.has(file)) return;
  skipped.add(file);
  console.error(`fireside: skipping ${file}: a ${type.slice(0, -1)} named "${id}" already exists. Rename it to use it.`);
}

function definitions(type: 'windows' | 'skins', dir: string) {
  const found = new Map<string, { folder: string | null; file: string; from: string }>();
  layers(type, dir).forEach((root, layer) => {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const isDir = entry.isDirectory();
      const id = isDir ? entry.name : entry.name.replace(/\.json$/, '');
      // A window is a folder named after its kind; a skin is a folder or a .json file.
      if (id.startsWith('.') || (type === 'windows' ? !isDir || !KIND.test(id) : !isDir && !entry.name.endsWith('.json'))) continue;
      const folder = isDir ? path.join(root, entry.name) : null;
      const file = folder ? path.join(folder, type === 'windows' ? 'window.json' : 'skin.json') : path.join(root, entry.name);
      if (type === 'skins' && !fs.existsSync(file)) continue;
      if (found.has(id)) { skip(type, id, folder || file); continue; }
      found.set(id, { folder, file, from: FROM[layer] });
    }
  });
  return found;
}

/** Every layer that defines this id, not just the one that wins. */
export const origins = (type: 'windows' | 'skins', id: string, dir: string) => layers(type, dir).flatMap((root, layer) =>
  fs.existsSync(path.join(root, id)) || (type === 'skins' && fs.existsSync(path.join(root, id + '.json'))) ? [FROM[layer]] : []);

export const windowFolder = (kind: string, dir: string) => definitions('windows', dir).get(kind)?.folder;

function read<T>(type: 'windows' | 'skins', dir: string, make: (spec: Record<string, unknown>, id: string, folder: string | null, from: string) => T): T[] {
  return [...definitions(type, dir)].flatMap(([id, { file, folder, from }]) => {
    try { return [make(JSON.parse(fs.readFileSync(file, 'utf8')), id, folder, from)]; }
    catch (error) { console.error(`${file}: ${(error as Error).message}`); return []; }
  });
}

type WindowDefinition = { kind: string; from: string; css: boolean; title?: string; catalogue?: boolean; feeds?: string[]; [key: string]: unknown };
export function listWindows(dir: string): WindowDefinition[] {
  return read('windows', dir, (spec, kind, folder, from) => ({
    ...spec, kind, from, css: fs.existsSync(path.join(folder!, 'window.css')),
  })).sort((a, b) => a.kind.localeCompare(b.kind));
}

export function listSkins(dir: string): Skin[] {
  const skins = read('skins', dir, (spec, id, folder): Skin => ({ ...spec, id: typeof spec.id === 'string' ? spec.id : id, folder }));
  const byId = new Map<string, Skin>();
  for (const skin of skins) {
    if (byId.has(skin.id)) skip('skins', skin.id, skin.folder || skin.id);
    else byId.set(skin.id, skin);
  }
  return [...byId.values()];
}
export const findSkin = (id: unknown, dir: string) => listSkins(dir).find((skin) => skin.id === id);

/** A file the skin bundles, by URL; a revision segment makes the page fetch it afresh. */
export const bundledURL = (skin: Skin, asset: { file?: string }, revision?: string | number) =>
  asset.file && skin.folder ? `/skins/${encodeURIComponent(skin.id)}/${revision === undefined ? '' : `~${revision}/`}${encodeURI(asset.file)}` : null;
