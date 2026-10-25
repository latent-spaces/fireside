import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { PKG_ROOT, projectDir, ensureDirs, readServer, firesideDir } from './paths.ts';
import { initializeDesktop } from './starter.mjs';
import { rotate } from './log.mjs';
import { nodeBin } from './process.mjs';

/** Keep `.fireside/` out of the project's repo. It holds chats and the server's
 *  token. The exclude file is local to this clone, so the repo itself is unchanged. */
function excludeFromGit(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    git('rev-parse', '--git-dir');
    try { git('check-ignore', '-q', '.fireside/'); return; } catch {}
    const exclude = path.resolve(root, git('rev-parse', '--git-path', 'info/exclude'));
    const text = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.fireside/\n`);
  } catch {} // No git, not a repo, or a read-only one: nothing to protect or no way to.
}

/** Start a desk's server in the background and wait for it to serve. Both
 *  `fireside start` and the desk menu start desks through here. */
export async function launch(dir, { port } = {}) {
  const root = projectDir(dir);
  ensureDirs(root);
  excludeFromGit(root);
  initializeDesktop(root);
  const env = { ...process.env, FIRESIDE_PROJECT: root };
  // Started from another desk's server, this process carries that desk's settings.
  delete env.FIRESIDE_CONNECTION; delete env.FIRESIDE_PORT; delete env.FIRESIDE_SERVER_PID;
  if (port) env.FIRESIDE_PORT = String(port);
  const logFile = path.join(firesideDir(root), 'server.log');
  rotate(logFile);
  const log = fs.openSync(logFile, 'a');
  const child = spawn(nodeBin(), [path.join(PKG_ROOT, 'src', 'server.ts')], { cwd: root, env, detached: true, stdio: ['ignore', log, log] });
  let failed = null;
  child.on('error', (error) => { failed = error; });
  fs.closeSync(log);
  child.unref();
  for (let i = 0; i < 300 && !failed; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const info = readServer(root);
    if (info) return info;
  }
  throw failed || new Error('The server did not start; see .fireside/server.log');
}
