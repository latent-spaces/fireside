import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { firesideDir } from './paths.ts';

export const validCommand = (cmd) => Array.isArray(cmd) && cmd.length > 0
  && typeof cmd[0] === 'string' && cmd[0].trim().length > 0
  && cmd.every((arg) => typeof arg === 'string' && !arg.includes('\0'));

// Parse an argument list, without shell expansion or shell execution.
export function commandArgs(text) {
  const args = [];
  let word = '', quote = null, escaped = false, started = false;
  for (const char of text) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = null; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { args.push(word); word = ''; started = false; }
    } else { word += char; started = true; }
  }
  if (quote || escaped) throw new Error('Unclosed quote or trailing escape in --exec');
  if (started) args.push(word);
  if (!validCommand(args)) throw new Error('Expected a nonempty command');
  return args;
}

export function appIcon(project, app, id) {
  if (process.platform !== 'darwin') throw new Error('--app requires macOS');
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 };
  let name = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', path.join(app, 'Contents/Info.plist')], options).trim();
  if (!name.endsWith('.icns')) name += '.icns';
  const dir = path.join(firesideDir(project), 'icons');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${encodeURIComponent(id)}.png`;
  execFileSync('sips', ['-s', 'format', 'png', '-Z', '256', path.join(app, 'Contents/Resources', name), '--out', path.join(dir, filename)], options);
  return `.fireside/icons/${filename}`;
}

// Windows has no execve, and `code`, `npm` and most Node-ecosystem tools are
// `.cmd` shims. Since the 2024 argument-injection fix Node refuses to spawn one
// without a shell, so a launcher icon for them dies before it starts. Resolve
// the name the way a shell would -- PATH by PATHEXT -- and hand a batch file to
// cmd.exe with arguments we quote ourselves. `shell: true` would do neither:
// it joins the argument list on spaces without quoting anything.
const BATCH = /\.(?:bat|cmd)$/i;

/** The program a bare name runs from PATH (trying PATHEXT on Windows), or null. */
export function which(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean) : [];
  const candidates = path.extname(name) || !exts.length ? [name] : exts.map((ext) => name + ext);
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try { if (fs.statSync(full).isFile()) return full; } catch {}
    }
  }
  return null;
}
const resolveOnWindows = (name) => name.includes('/') || name.includes('\\') ? name : which(name) || name;

// Every argument quoted, with cmd.exe's own doubling for an embedded quote.
// The list is validated and comes from the icon's stored command, never from
// text typed at launch time.
const quoteForCmd = (arg) => `"${String(arg).replaceAll('"', '""')}"`;

/** The spawn() call for a stored command, without a shell. */
export function spawnable(cmd, options) {
  if (!validCommand(cmd)) throw new Error('Invalid launcher command');
  const onWindows = process.platform === 'win32';
  const file = onWindows ? resolveOnWindows(cmd[0]) : cmd[0];
  const batch = onWindows && BATCH.test(file);
  options = { ...options, shell: false };
  if (batch) { options.windowsVerbatimArguments = true; options.windowsHide = true; }
  const command = batch ? (process.env.COMSPEC || 'cmd.exe') : file;
  // cmd /c wants the whole command line as one already-quoted argument.
  const args = batch
    ? ['/d', '/s', '/c', `"${[file, ...cmd.slice(1)].map(quoteForCmd).join(' ')}"`]
    : cmd.slice(1);
  return [command, args, options];
}

export function launch(cmd, project) {
  const [command, args, options] = spawnable(cmd, { cwd: project, detached: true, stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/**
 * Run a stored command to the end, for a window waiting on what it does. Resolves
 * once it exits cleanly; otherwise rejects with the last line it wrote to stderr.
 * The timeout stays under the page's 30s request limit, so the window hears why.
 */
export function runToEnd(cmd, project, timeout = 25000) {
  const [command, args, options] = spawnable(cmd, { cwd: project, stdio: ['ignore', 'ignore', 'pipe'], timeout });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) return resolve();
      const last = stderr.trim().split('\n').filter(Boolean).at(-1);
      reject(new Error(last || (signal ? `stopped by ${signal}` : `exited with ${code}`)));
    });
  });
}

/**
 * Run any command for a window and hand back what it printed. Windows are trusted
 * local code, so this is the same as the user typing it: no shell, but no list of
 * allowed commands either. Output is capped; a timeout stops it.
 */
export function runCommand(cmd, cwd, timeout = 25000) {
  const [command, args, options] = spawnable(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '', stderr = '';
    const cap = (text, chunk) => (text + chunk).slice(-1e6);
    child.stdout.on('data', (chunk) => { stdout = cap(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = cap(stderr, chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
