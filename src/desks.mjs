import { writeJSON } from './storage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { USER_DIR, projectDir, serverPath, statePath, readServer, firesideDir } from './paths.ts';
import { alive } from './process.mjs';
import { markStopped, lastCrash } from './log.mjs';
import { launch } from './launch.mjs';

// Every project gets its own server, and each one only ever knew about itself.
// Exiting the browser left it running: nothing named the other desks, so
// nothing could switch to them or shut one down. This is the one list of the
// desks on this machine, so any desk can show — and stop — the rest. A desk
// that stops, or dies, stays on it to be started again: the few most recently
// seen, as long as their folder still holds a desk.
const FILE = path.join(USER_DIR, 'desks.json');
const KEEP_STOPPED = 5;

function read() {
  try {
    const desks = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(desks) ? desks.filter(d => d && typeof d.dir === 'string') : [];
  } catch { return []; }
}

// Best effort throughout: a desk that cannot write the registry still runs.
function write(desks) {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    writeJSON(FILE, desks);
  } catch (error) { console.error(`Cannot write ${FILE}: ${error.message}`); }
}

/** The desk's own name for itself, which is what the menubar shows. */
function title(dir) {
  try { return JSON.parse(fs.readFileSync(statePath(dir), 'utf8')).title || null; } catch { return null; }
}

// The registry is a cache of processes, so it can only ever be a hint: trust
// the descriptor each server writes for itself. A desk whose server is gone
// keeps its folder, port (so its page keeps its address) and when it was last
// seen up; past the few most recent, or once its folder is gone, it is dropped.
function settle(desks, now = Date.now()) {
  const running = [], stopped = [];
  for (const desk of desks) {
    const info = readServer(desk.dir);
    if (info && info.pid === desk.pid) running.push({ ...desk, lastSeen: now });
    else if (fs.existsSync(firesideDir(desk.dir))) stopped.push(asStopped(desk));
  }
  stopped.sort((a, b) => b.lastSeen - a.lastSeen);
  return [...running, ...stopped.slice(0, KEEP_STOPPED)];
}
const asStopped = (desk, lastSeen = desk.lastSeen || 0) => ({ dir: desk.dir, port: desk.port, lastSeen });

export function register({ dir, url, port, pid }) {
  const me = { dir: projectDir(dir), url, port, pid, lastSeen: Date.now() };
  write(settle([...read().filter(desk => desk.dir !== me.dir), me]));
}

/** Mark a desk stopped. Given a pid, only if that server is still the one listed,
 *  so a server on its way out never marks its replacement stopped. */
export function unregister(dir, pid) {
  const gone = projectDir(dir);
  const desks = read();
  const desk = desks.find(d => d.dir === gone);
  if (!desk || !desk.pid || (pid && desk.pid !== pid)) return;
  write(desks.map(d => d === desk ? asStopped(d, Date.now()) : d));
}

/** Take a stopped desk off the list. A running one stays: stop it first. */
export function forget(dir) {
  const gone = projectDir(dir);
  const desks = settle(read());
  write(desks.filter(desk => desk.dir !== gone || desk.pid));
}

/** Every listed desk, each named the way its page is: the running ones, newest
 *  registration last, then the stopped ones, most recently seen first. */
/** @returns {{dir: string, name: string, running: boolean, url?: string, port?: number, pid?: number, lastSeen: number}[]} */
export function list() {
  const desks = read();
  const settled = settle(desks);
  if (JSON.stringify(settled.map(d => [d.dir, d.pid])) !== JSON.stringify(desks.map(d => [d.dir, d.pid]))) write(settled);
  return settled.map(desk => ({
    dir: desk.dir, url: desk.url, port: desk.port, pid: desk.pid, lastSeen: desk.lastSeen, running: !!desk.pid,
    name: title(desk.dir) || path.basename(desk.dir),
  }));
}

/** Start a stopped desk on the list again, on the port it had if it is free. */
export async function start(dir) {
  const target = projectDir(dir);
  const desk = list().find(d => d.dir === target);
  if (!desk) throw new Error('That desk is not on the list');
  const info = desk.running && readServer(target);
  if (info) return info;
  try { return await launch(target, { port: desk.port }); }
  catch (error) {
    const crash = lastCrash(path.join(firesideDir(target), 'server.log'));
    throw new Error(crash?.error ? `It stopped on start: ${crash.error}` : error.message);
  }
}

/** Stop another desk's server and wait for it to go, so its port frees up. */
export async function stop(dir, { fetch: get = fetch } = {}) {
  const target = projectDir(dir);
  const info = readServer(target);
  if (!info) { unregister(target); return false; }
  // Never signal a pid on the say-so of a file alone: ask the process itself
  // which project it serves, and only then stop it.
  let ping = null;
  try { ping = await get(`${info.url}/api/ping`, { signal: AbortSignal.timeout(2500) }).then(r => r.json()); } catch {}
  if (!ping || ping.root !== target || (ping.pid && ping.pid !== info.pid)) {
    throw new Error('Could not verify that desk’s server; it was left running');
  }
  try { process.kill(info.pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 100 && alive(info.pid); i++) await new Promise(r => setTimeout(r, 50));
  // A server that got SIGTERM marks its own log; a forced or Windows kill can't.
  let forced = process.platform === 'win32';
  if (alive(info.pid)) {
    forced = true;
    try { process.kill(info.pid, 'SIGKILL'); } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  try { fs.unlinkSync(serverPath(target)); } catch {}
  if (forced) markStopped(path.join(firesideDir(target), 'server.log'));
  unregister(target, info.pid);
  return true;
}
