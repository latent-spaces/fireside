import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Publish complete JSON, never a partially written file. */
export function writeJSON(file, value, mode = 0o600) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** Prepare a replacement beside its destination, then publish it in one rename. */
export function replacePath(target, prepare, previous = target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(target), '.fireside-install-'));
  const ready = path.join(stage, 'new'), backup = path.join(stage, 'old');
  let keepBackup = false;
  try {
    prepare(ready);
    const exists = fs.existsSync(previous);
    if (exists) fs.renameSync(previous, backup);
    try { fs.renameSync(ready, target); }
    catch (error) {
      if (exists) {
        try { fs.renameSync(backup, previous); }
        catch (rollback) {
          keepBackup = true;
          throw new Error(`Replacement failed: ${error.message}. Previous version is at ${backup}: ${rollback.message}`);
        }
      }
      throw error;
    }
  } finally { if (!keepBackup) fs.rmSync(stage, { recursive: true, force: true }); }
  return target;
}
