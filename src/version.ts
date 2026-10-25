import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT, CLIENT_DIR } from './paths.ts';

function fingerprint(dir: string, files: RegExp): string {
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(dir).filter((name) => files.test(name)).sort()) {
    hash.update(name);
    hash.update(fs.readFileSync(path.join(dir, name)));
  }
  return hash.digest('hex').slice(0, 12);
}

/** A fingerprint of the server's own source, so a desk can tell it runs older code. */
export const serverCodeId = () => fingerprint(path.join(PKG_ROOT, 'src'), /\.(ts|mjs)$/);

/** A fingerprint of the shell's scripts and page. A page that loaded other ones
 *  has to reload; its stylesheet is swapped in place instead, so CSS is left out. */
export const shellCodeId = () => fingerprint(CLIENT_DIR, /\.(js|html)$/);
