import fs from 'node:fs';

// Each desk's server writes to .fireside/server.log: its stdout and stderr, so
// whatever Node itself prints on a crash lands there too. It holds errors only,
// each with a time, between a line marking each start and each clean stop. A
// start with no stop after it is a server that died.

const STARTED = 'fireside started';
const STOPPED = 'fireside stopped';
const LIMIT = 1024 * 1024;

/** Put the time in front of everything the server says. */
export function stampConsole() {
  for (const method of ['log', 'warn', 'error']) {
    const write = console[method].bind(console);
    console[method] = (...args) => write(`[${new Date().toISOString()}]`, ...args);
  }
}

/** Keep at most two files: past a megabyte, the log becomes server.log.1. */
export function rotate(file) {
  try { if (fs.statSync(file).size > LIMIT) fs.renameSync(file, `${file}.1`); } catch {}
}

export const markStart = () => console.log(`${STARTED} (pid ${process.pid})`);
export const markStop = () => console.log(STOPPED);
/** Mark another server's log as stopped on purpose: a kill on Windows, or a
 *  forced one anywhere, gives that server no chance to say so itself. */
export function markStopped(file) {
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${STOPPED}\n`); } catch {}
}

/** How the last run ended, read from the end of the log before this run writes
 *  to it: null if it stopped cleanly (or there is nothing to go on), else when it
 *  died and the error it died of. Node's own crash output has no time on it, so
 *  "when" is the log's last write. */
export function lastCrash(file) {
  // A start may just have rotated the log, leaving the last run in server.log.1.
  for (const candidate of [file, `${file}.1`]) {
    const found = readRun(candidate);
    if (found !== undefined) return found;
  }
  return null;
}
/** undefined when this file holds no run at all. */
function readRun(file) {
  let text, at;
  try {
    const fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd), length = Math.min(stat.size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    fs.closeSync(fd);
    text = buffer.toString('utf8'); at = stat.mtimeMs;
  } catch { return undefined; }
  const start = text.lastIndexOf(STARTED);
  if (start === -1) return undefined;
  const run = text.slice(start);
  if (run.includes(STOPPED)) return null;
  // Node ends a crash with its own version line; the error is the last line that names one.
  const error = run.split('\n').filter((line) => /\w*Error\b/.test(line)).pop()?.replace(/^\[[^\]]+\]\s*/, '').trim();
  return { at, error: error || null };
}
