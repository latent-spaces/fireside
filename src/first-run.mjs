import fs from 'node:fs';
import { USER_DIR, statePath } from './paths.ts';
import { dirs as deskDirs } from './desks.mjs';
import { writeJSON } from './storage.mjs';
import path from 'node:path';

// What this machine has already been through. The tour explains Fireside, not a
// project, so it runs once here however many folders the desk is opened in, and
// a new project starts with the agent used last.
const FILE = path.join(USER_DIR, 'first-run.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

// Best effort: a machine that cannot keep this only repeats the tour.
function write(news) {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    writeJSON(FILE, { ...read(), ...news });
  } catch (error) { console.error(`Cannot write ${FILE}: ${error.message}`); }
}

// The tour used to be marked per project, so a desk toured before this file
// existed counts: an upgrade should not bring it back.
function touredDesk(dir) {
  try { return !!JSON.parse(fs.readFileSync(statePath(dir), 'utf8')).toured; } catch { return false; }
}

export function firstRun(dir) {
  const seen = read();
  return { toured: !!seen.toured || [dir, ...deskDirs()].some(touredDesk), agent: seen.agent || null };
}

export const markToured = () => write({ toured: new Date().toISOString() });

let last = null;
export function rememberAgent(agent) {
  if (agent === last) return;
  last = agent;
  write({ agent });
}
