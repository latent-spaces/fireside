import fs from 'node:fs';

/** Whether a process is still there. EPERM means it exists but isn't ours. */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** The Node to start children with. Upgrading Node through a package manager
 *  deletes the binary a long-running desk started on, so fall back to PATH. */
export function nodeBin() {
  return fs.existsSync(process.execPath) ? process.execPath : 'node';
}
