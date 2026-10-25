import fs from 'node:fs';
import path from 'node:path';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { firesideDir, USER_DIR } from './paths.ts';
import { windowFolder, findSkin, KIND, origins } from './catalog.ts';
import { replacePath } from './storage.mjs';

type ComponentType = 'window' | 'skin';
interface PackageManifest { format: 1; type: ComponentType; id: string; version: string; fireside: 1 }
const OMIT = new Set(['.git', '.fireside', 'node_modules', '.DS_Store']);
const LIMIT = 64 * 1024 * 1024;
// A window is defined by window.json under windows/, a skin by skin.json under skins/.
const definitionFile = (type: ComponentType) => `${type}.json`;
const layerName = (type: ComponentType) => `${type}s` as 'windows' | 'skins';

function manifest(value: unknown): PackageManifest {
  if (!value || typeof value !== 'object') throw new Error('Missing component manifest');
  const v = value as Partial<PackageManifest>;
  if (v.format !== 1 || v.fireside !== 1 || !['window', 'skin'].includes(String(v.type)) ||
      typeof v.id !== 'string' || !KIND.test(v.id) || typeof v.version !== 'string' || !v.version) {
    throw new Error('Unsupported component package');
  }
  return v as PackageManifest;
}

function validateFiles(meta: PackageManifest, files: Record<string, Uint8Array>) {
  const definition = files[definitionFile(meta.type)];
  if (!definition) throw new Error(`Missing ${meta.type} definition`);
  const spec = JSON.parse(strFromU8(definition));
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Invalid component definition');
  if (meta.type === 'window' && !files['window.js']) throw new Error('Missing window.js');
  if (meta.type === 'skin' && spec.id !== meta.id) throw new Error('Skin ID does not match the package');
}

/** Export reusable files only. Project content is never collected from the shared store. */
export function exportComponent(type: ComponentType, id: string, output: string, root: string) {
  const { folder } = locate(type, id, root);
  if (folder) {
    const relative = path.relative(fs.realpathSync(folder), path.resolve(output));
    if (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('Export ZIP must be outside the component folder');
  }
  fs.writeFileSync(output, packComponent(type, id, root));
  return path.resolve(output);
}

/** Where a component lives: its folder, and for a skin its definition (a skin may be a lone .json file). */
function locate(type: ComponentType, id: string, root: string) {
  const skin = type === 'skin' ? findSkin(id, root) : undefined;
  return { skin, folder: type === 'window' ? windowFolder(id, root) : skin?.folder };
}

/** A component's ZIP, in memory: the desk hands it to the browser as a download. */
export function packComponent(type: ComponentType, id: string, root: string) {
  if (!KIND.test(id)) throw new Error('Invalid component ID');
  const { skin, folder } = locate(type, id, root);
  const files: Record<string, Uint8Array> = {};
  let size = 0;
  function collect(dir: string, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (OMIT.has(entry.name)) continue;
      const name = prefix + entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Bundle the actual asset instead of a symlink: ${name}`);
      if (entry.isDirectory()) collect(file, name + '/');
      else if (entry.isFile()) {
        size += fs.statSync(file).size;
        if (size > LIMIT) throw new Error('Component exceeds 64 MB');
        files[name] = fs.readFileSync(file);
      }
    }
  }
  if (folder) collect(folder);
  else if (skin) {
    const { folder: _folder, ...definition } = skin;
    files['skin.json'] = strToU8(JSON.stringify(definition, null, 2));
  } else throw new Error(`Unknown ${type}: ${id}`);
  const spec = JSON.parse(strFromU8(files[definitionFile(type)]));
  const meta: PackageManifest = files['component.json']
    ? manifest(JSON.parse(strFromU8(files['component.json'])))
    : { format: 1, type, id, version: String(spec.version || '1'), fireside: 1 };
  if (meta.type !== type || meta.id !== id) throw new Error('Component manifest does not match its folder');
  validateFiles(meta, files);
  files['component.json'] = strToU8(JSON.stringify({ ...meta, fireside: 1 }, null, 2));
  return zipSync(files);
}

/**
 * A name already used anywhere else can't be taken again: importing a second
 * "chat" would leave two, and the desk would run one while the other is edited.
 * Updating your own component where it already lives is still allowed.
 */
function checkName(type: ComponentType, id: string, root: string, project: boolean, rename: string) {
  const here = project ? 'project' : '~/.fireside';
  const elsewhere = origins(layerName(type), id, root).filter((from) => from !== here);
  if (elsewhere.length) {
    throw Object.assign(new Error(`A ${type} named "${id}" already exists (${elsewhere.join(', ')}). ${rename}`), { status: 409, code: 'ENAME' });
  }
}

/** Import trusted code, with explicit replacement and no installation scripts. */
export function importComponent(archive: string, root: string, options: { project?: boolean; replace?: boolean; as?: string } = {}) {
  if (fs.statSync(archive).size > LIMIT) throw new Error('Component ZIP exceeds 64 MB');
  return unpackComponent(fs.readFileSync(archive), root, options);
}

/** Unpack and check a component ZIP in memory: its paths, size, manifest and definition. */
export function readPackage(archive: Uint8Array) {
  if (archive.length > LIMIT) throw new Error('Component ZIP exceeds 64 MB');
  let size = 0;
  const files = unzipSync(archive, { filter(entry) {
    const name = entry.name;
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some((part) => part === '..' || part.includes(':'))) {
      throw new Error(`Invalid package path: ${name}`);
    }
    size += entry.originalSize;
    if (size > LIMIT) throw new Error('Expanded component exceeds 64 MB');
    return !name.endsWith('/');
  } });
  if (!files['component.json']) throw new Error('Missing component.json');
  const meta = manifest(JSON.parse(strFromU8(files['component.json'])));
  if (Object.keys(files).some((name) => name.split('/').some((part) => OMIT.has(part)))) throw new Error('Package contains runtime or project folders');
  validateFiles(meta, files);
  return { meta, files };
}

/** Install a component from ZIP bytes, under a new name when `as` gives one. */
export function unpackComponent(archive: Uint8Array, root: string, { project = false, replace = false, as = '' } = {}) {
  const { meta, files } = readPackage(archive);
  if (as && as !== meta.id) {
    if (!KIND.test(as)) throw Object.assign(new Error(`"${as}" can't be a name: use lowercase letters, digits and dashes`), { status: 400 });
    meta.id = as;
    files['component.json'] = strToU8(JSON.stringify(meta, null, 2));
    if (meta.type === 'skin') files['skin.json'] = strToU8(JSON.stringify({ ...JSON.parse(strFromU8(files['skin.json'])), id: as }, null, 2));
  }
  checkName(meta.type, meta.id, root, project, 'Import it under a new name with --as <name>.');
  const parent = path.join(project ? firesideDir(root) : USER_DIR, layerName(meta.type));
  const target = path.join(parent, meta.id);
  // A skin installed here may be a folder or a lone .json file; either one is replaced.
  const previous = [target, ...(meta.type === 'skin' ? [path.join(parent, meta.id + '.json')] : [])].find((file) => fs.existsSync(file));
  if (previous && !replace) throw Object.assign(new Error(`${meta.id} is already installed here; use --replace to update it, or --as <name> to keep both`), { status: 409, code: 'EEXIST' });
  replacePath(target, (ready: string) => writeFiles(ready, files), previous || target);
  return { ...meta, folder: target };
}

function writeFiles(dir: string, files: Record<string, Uint8Array>) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/**
 * Hold a shared component for the agent to look at before anything is installed:
 * the ZIP and its unpacked files go to .fireside/inbox, and the answer says where a
 * component of the same name already lives (built-in, ~/.fireside, project).
 */
export function stageComponent(archive: Uint8Array, root: string) {
  const { meta, files } = readPackage(archive);
  const name = `${meta.type}-${meta.id}-${Date.now()}`;
  const inbox = path.join(firesideDir(root), 'inbox');
  writeFiles(path.join(inbox, name), files);
  fs.writeFileSync(path.join(inbox, name + '.zip'), archive);
  const spec = JSON.parse(strFromU8(files[definitionFile(meta.type)]));
  return {
    ...meta, title: String(spec.title || spec.name || meta.id),
    folder: path.join('.fireside', 'inbox', name), zip: path.join('.fireside', 'inbox', name + '.zip'),
    existing: origins(layerName(meta.type), meta.id, root),
  };
}

/** Folder installs and ZIP imports use the same replacement lifecycle. */
export function installComponent(source: string, type: string, root: string, { project = false } = {}) {
  const target = path.join(project ? firesideDir(root) : USER_DIR, type, path.basename(source));
  checkName(type === 'windows' ? 'window' : 'skin', path.basename(source, '.json'), root, project,
    type === 'windows' ? 'Rename the folder to give it a name of its own.' : 'Change its "id" and file or folder name to give it a name of its own.');
  const canonical = (file: string): string => {
    try { return fs.realpathSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return path.join(canonical(path.dirname(file)), path.basename(file));
    }
  };
  const src = canonical(path.resolve(source)), dest = canonical(target);
  const contains = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);
  if (contains(src, dest) || contains(dest, src)) throw new Error('Source and installation folder overlap');
  return replacePath(target, (ready: string) => fs.cpSync(src, ready, { recursive: true, verbatimSymlinks: true }));
}
