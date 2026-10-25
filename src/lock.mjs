import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { alive } from './process.mjs';

// Publish a fully written PID with an exclusive hard link. Unlike symlinks,
// regular-file hard links do not need Windows Developer Mode or elevation.
export function acquireLock(file, timeout = 3000) {
  const candidate = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(candidate, String(process.pid), { flag: 'wx', mode: 0o600 });
  const deadline = Date.now() + timeout;
  const owner = () => fs.lstatSync(file).isSymbolicLink()
    ? fs.readlinkSync(file) // Allow upgrades from the old symlink locks.
    : fs.readFileSync(file, 'utf8');
  try {
    for (;;) {
      try { fs.linkSync(candidate, file); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          if (!alive(Number(owner()))) { fs.unlinkSync(file); continue; }
        } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (Date.now() >= deadline) throw new Error(`Busy: ${file}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
  } finally { fs.unlinkSync(candidate); }
  return () => {
    try { if (Number(owner()) === process.pid) fs.unlinkSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
