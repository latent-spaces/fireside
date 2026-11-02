import type { ServerDescriptor } from './contracts.ts';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLIENT_DIR = path.join(PKG_ROOT, 'client');
/** What the user installs for every project. FIRESIDE_HOME moves it. */
export const USER_DIR = process.env.FIRESIDE_HOME || path.join(os.homedir(), '.fireside');

/** Where windows or skins come from, lowest priority first: built in, ~/.fireside, then the project. */
export const layers = (name: string, dir: string) => [path.join(PKG_ROOT, name), path.join(USER_DIR, name), path.join(firesideDir(dir), name)];

/** The project a fireside instance belongs to. Defaults to cwd. */
export function projectDir(dir = process.env.FIRESIDE_PROJECT || process.cwd()) {
  return path.resolve(dir);
}

/** The project's own folder. */
export function firesideDir(dir: string) {
  return path.join(projectDir(dir), '.fireside');
}

/** Folders inside .fireside that windows may show: panel files, skin and icon images,
 *  `fireside shot` pictures, media the CLI copied in from outside the project, and
 *  images pasted into a chat. */
export const SHARED = ['panels', 'skins/assets', 'icons', 'shots', 'media', 'images'];

export function statePath(dir: string) {
  return path.join(firesideDir(dir), 'state.json');
}

export function serverPath(dir: string) {
  return path.join(firesideDir(dir), 'server.json');
}

export function panelsDir(dir: string) {
  return path.join(firesideDir(dir), 'panels');
}

/** Windows' project data: files a panel names with `data: "name.json"`. */
export function dataDir(dir: string) {
  return path.join(firesideDir(dir), 'data');
}

export function ensureDirs(dir: string) {
  fs.mkdirSync(panelsDir(dir), { recursive: true });
  fs.mkdirSync(dataDir(dir), { recursive: true });
  return firesideDir(dir);
}

/** The address people open a desk on. YouTube refuses some embeds on a page at 127.0.0.1. */
export const deskAddress = (url: string) => url.replace('127.0.0.1', 'localhost');

/** Read the running server's descriptor, or null if nothing is listening. */
export function readServer(dir: string): ServerDescriptor | null {
  try {
    const info = JSON.parse(fs.readFileSync(serverPath(dir), 'utf8'));
    if (!Number.isInteger(info.pid) || info.pid <= 1 || info.dir !== projectDir(dir)) return null;
    const address = new URL(info.url);
    if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.port !== String(info.port)) return null;
    try { process.kill(info.pid, 0); }
    catch (error) {
      // Sandboxed agents may see the descriptor but cannot signal its process.
      // EPERM means existence is unknown, not that the server has stopped.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      throw new Error('Cannot check Fireside server: process access denied (EPERM). Run the CLI with permission to access the local desk.');
    }
    return info;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cannot check Fireside server:')) throw error;
    return null;
  }
}
