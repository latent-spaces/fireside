import fs from 'node:fs';
import { USER_DIR } from './paths.ts';
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

export function firstRun() {
  const seen = read();
  return { toured: !!seen.toured, agent: seen.agent || null };
}

export const markToured = () => write({ toured: new Date().toISOString() });

let last = null;
export function rememberAgent(agent) {
  if (agent === last) return;
  last = agent;
  write({ agent });
}
