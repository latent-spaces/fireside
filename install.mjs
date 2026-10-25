#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));

const homeDir = os.homedir();
const binDir = path.join(homeDir, '.local/bin');
const links = [
  [PKG_ROOT, path.join(homeDir, '.claude/skills/fireside')],
  [path.join(PKG_ROOT, 'bin/fireside.mjs'), path.join(binDir, 'fireside')],
];
const dry = process.argv.includes('--dry-run');
const uninstall = process.argv.includes('--uninstall');

/** Run a step in this folder, so a fresh clone needs nothing but this script. */
function step(label, command, args) {
  console.log(label);
  if (dry) return;
  const result = spawnSync(command, args, { cwd: PKG_ROOT, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed; see the output above. Installation was not changed`);
}

/** The line that puts binDir on PATH for the user's shell. */
function pathHint() {
  if (process.platform === 'win32') return `Add ${binDir} to your user PATH (Settings → Environment Variables), then open a new terminal.`;
  const shell = path.basename(process.env.SHELL || '');
  const line = shell === 'fish' ? `fish_add_path ${binDir}` : `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.${shell === 'bash' ? 'bashrc' : 'zshrc'}`;
  return `One more step: ${binDir} is not on your PATH. Run this, then open a new terminal:\n\n  ${line}`;
}

function install() {
  console.log(`${uninstall ? 'Uninstalling' : 'Installing'} Fireside${dry ? ' (dry run)' : ''}`);
  if (!uninstall) {
    step('npm install', 'npm', ['install', '--no-audit', '--no-fund']);
  }
  const undo = [];
  try {
    for (const [target, originalLink] of links) {
      const wrapper = process.platform === 'win32' && originalLink === path.join(binDir, 'fireside');
      const link = wrapper ? originalLink + '.cmd' : originalLink;
      if (wrapper) {
        const content = `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`;
        const existing = fs.existsSync(link) ? fs.readFileSync(link, 'utf8') : null;
        if (existing !== null && existing !== content) { console.log(`Skipped ${link}: already exists`); continue; }
        if (!dry) {
          if (uninstall) { if (existing !== null) { fs.unlinkSync(link); undo.push(() => fs.writeFileSync(link, existing)); } }
          else if (existing === null) {
            fs.mkdirSync(binDir, { recursive: true });
            // A failed write may leave a partial wrapper; register cleanup first.
            undo.push(() => fs.rmSync(link, { force: true }));
            fs.writeFileSync(link, content);
          }
        }
        console.log(`${uninstall ? 'Remove' : 'Write'} ${link}`);
        continue;
      }
      const stat = fs.lstatSync(link, { throwIfNoEntry: false });
      const current = stat?.isSymbolicLink() ? fs.readlinkSync(link) : null;
      if (uninstall) {
        if (current === target) { if (!dry) { fs.unlinkSync(link); undo.push(() => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : undefined)); } console.log(`Remove ${link}`); }
      } else if (stat && current !== target) {
        console.log(`Skipped ${link}: already exists`);
      } else {
        console.log(`Link ${link} → ${target}`);
        if (!dry && !stat) { fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : undefined); undo.push(() => fs.unlinkSync(link)); }
      }
    }
  } catch (error) {
    const failures = [];
    for (const restore of undo.reverse()) { try { restore(); } catch (failure) { failures.push(failure.message); } }
    if (failures.length) throw new Error(`${error.message}; rollback incomplete: ${failures.join('; ')}`);
    throw error;
  }
  if (uninstall) return;
  if (!(process.env.PATH || '').split(path.delimiter).includes(binDir)) console.log(`\n${pathHint()}`);
  console.log('\nDone. Open a project with:\n\n  cd path/to/project\n  fireside\n');
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) { console.error(`Fireside needs Node 22.18 or newer; this is Node ${process.versions.node}.`); process.exit(1); }

try { install(); } catch (error) { console.error(error.message); process.exitCode = 1; }
