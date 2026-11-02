import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unzipSync } from 'fflate';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { PKG_ROOT, USER_DIR, layers } from './paths.ts';
import { writeJSON } from './storage.mjs';
import { nodeBin } from './process.mjs';
import { fail } from './errors.ts';
import { which, spawnable } from './launchers.mjs';

// An agent is a small file: a name and how to start something that speaks ACP.
// Fireside keeps no list of agents of its own. Claude and Codex ship as files in
// agents/, the user's own sit in ~/.fireside/agents, and a project can add more in
// .fireside/agents -- the same layers windows and skins come from.
//
//   { "name": "Gemini CLI", "npm": "@google/gemini-cli", "args": ["--acp"] }
//   { "name": "OpenCode", "command": "opencode", "args": ["acp"] }
//
// `npm` names a package installed beside the file (in <id>/, or Fireside's own
// node_modules for a built-in) and runs its bin; its version is pinned in that
// folder's package.json, which is what the Update button moves. `command` runs a
// program: on PATH, or under <id>/ when it starts with "./".
//
// The ACP registry is read only to fill one of these in when an agent is added.
// After that nothing here looks at it, except an opt-in update check, so a
// registry that changes shape or goes away cannot stop an agent that works.

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LAYERS = ['built-in', 'user', 'project'];
const AGENTS_DIR = path.join(USER_DIR, 'agents');
const REGISTRY_URL = process.env.FIRESIDE_ACP_REGISTRY || 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

const strings = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string');
const stringMap = (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string');
const https = (value) => typeof value === 'string' && /^https:\/\//.test(value);

/** @returns {Agent | null} */
function readAgent(dir, file, layer) {
  const id = path.basename(file, '.json');
  if (!ID.test(id)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) return null;
  if ((typeof raw.npm === 'string') === (typeof raw.command === 'string')) return null;
  if (raw.args !== undefined && !strings(raw.args)) return null;
  if (raw.env !== undefined && !stringMap(raw.env)) return null;
  return {
    id, layer, file: path.join(dir, file),
    // Where a package or a "./" command lives: Fireside itself for a built-in.
    home: layer === 'built-in' ? PKG_ROOT : path.join(dir, id),
    name: raw.name.trim().slice(0, 60), about: typeof raw.about === 'string' ? raw.about : '',
    npm: raw.npm, command: raw.command, args: raw.args || [], env: raw.env || {},
    link: https(raw.link) ? raw.link : null,
    signIn: typeof raw.signIn === 'string' ? raw.signIn : null,
    icon: typeof raw.icon === 'string' ? raw.icon : null,
    from: raw.from && typeof raw.from === 'object' ? raw.from : null,
    raw,
  };
}

/** @param {string[]} dirs */
function scan(dirs) {
  /** @type {Map<string, Agent>} */
  const found = new Map();
  dirs.forEach((dir, index) => {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
    for (const file of files) {
      const agent = readAgent(dir, file, LAYERS[index]);
      if (!agent) continue;
      // One name, one agent, as with windows and skins: a later file with a
      // taken name is skipped. A cloned repository can't change what "Claude" runs.
      if (found.has(agent.id)) continue;
      found.set(agent.id, agent);
    }
  });
  return [...found.values()];
}

/** @typedef {{ id: string, layer: string, file: string, home: string, name: string, about: string, npm?: string, command?: string,
 *   args: string[], env: Record<string, string>, link: string | null, signIn: string | null, icon: string | null, from: Record<string, any> | null, raw: Record<string, any> }} Agent */
/** @type {{ key: string, at: number, list: Agent[] }} */
let cache = { key: '', at: 0, list: [] };
/** Every agent this project can use, built-ins first. Cached briefly: the chat view asks often. */
export function list(root) {
  const dirs = layers('agents', root);
  const key = dirs.join('\0');
  if (cache.key !== key || Date.now() - cache.at > 1500) cache = { key, at: Date.now(), list: scan(dirs) };
  return cache.list;
}
export const get = (root, id) => list(root).find((a) => a.id === id) || null;
/** Built-in and ~/.fireside agents only: the ones Fireside installed and keeps up to date. */
export const managed = () => scan([path.join(PKG_ROOT, 'agents'), AGENTS_DIR]);
const forget = () => { cache.at = 0; };

const icons = new Map();
function iconURL(agent) {
  if (!agent.icon || path.basename(agent.icon) !== agent.icon || !agent.icon.endsWith('.svg')) return null;
  const file = path.join(path.dirname(agent.file), agent.icon);
  if (!icons.has(file)) {
    try {
      const svg = fs.readFileSync(file);
      icons.set(file, svg.length < 65536 ? `data:image/svg+xml;base64,${svg.toString('base64')}` : null);
    } catch { icons.set(file, null); }
  }
  return icons.get(file);
}

/** What the chat window draws. */
export function view(root) {
  return list(root).map((a) => ({ id: a.id, name: a.name, icon: iconURL(a), link: a.link, signIn: a.signIn, removable: a.layer === 'user',
    // Claude and Codex have marks of their own in the stylesheet.
    mark: a.layer === 'built-in' && a.signIn ? a.id : 'other' }));
}

/** An npm package as resolved from `home`, the way Node would load it: its package.json and what it says. */
export function installedPackage(home, name) {
  const file = createRequire(path.join(home, 'package.json')).resolve(`${name}/package.json`);
  return { file, pkg: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

/** The program to run for an agent, resolved now so a moved install shows up as an error, not a hang. */
export function launch(agent) {
  if (agent.npm) {
    let installed;
    try { installed = installedPackage(agent.home, agent.npm); }
    catch { throw fail(`${agent.name} is not installed. Remove it and add it again.`); }
    const { file, pkg } = installed;
    const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin || {};
    const bin = bins[pkg.name.split('/').pop()] || Object.values(bins)[0];
    if (!bin) throw fail(`${agent.npm} has no program to run`);
    const entry = path.join(path.dirname(file), bin);
    return script(entry) ? { command: nodeBin(), args: [entry, ...agent.args] } : { command: entry, args: agent.args };
  }
  const local = agent.command.startsWith('./');
  return { command: local ? path.join(agent.home, agent.command) : agent.command, args: agent.args };
}
function script(file) {
  if (/\.[cm]?js$/.test(file)) return true;
  try { return /^#!.*\bnode\b/.test(fs.readFileSync(file, 'utf8').slice(0, 200)); } catch { return false; }
}

// --- the registry, read once per add ----------------------------------------

let registryCache = { at: 0, agents: null };
export async function fetchRegistry({ fresh = false } = {}) {
  if (!fresh && registryCache.agents && Date.now() - registryCache.at < 10 * 60 * 1000) return registryCache.agents;
  let data;
  try {
    const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`it answered ${response.status}`);
    data = await response.json();
  } catch (error) { throw fail(`Couldn't load the agent list (${error.message}).`, 502); }
  if (!Array.isArray(data?.agents)) throw fail('The agent list came back in a shape Fireside does not understand.', 502);
  registryCache = { at: Date.now(), agents: data.agents };
  return data.agents;
}

const PLATFORM = `${{ darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]}-${{ arm64: 'aarch64', x64: 'x86_64' }[process.arch]}`;
/** "@scope/name@1.2.3" or "name==1.2.3" → { name, version } */
function spec(value, separators) {
  for (const sep of separators) {
    const at = value.lastIndexOf(sep);
    if (at > 0) return { name: value.slice(0, at), version: value.slice(at + sep.length) };
  }
  return { name: value, version: null };
}
/** How one registry entry would run here, or null if Fireside can't run it. Unknown fields are ignored. */
export function plan(entry) {
  const d = entry?.distribution;
  if (!d || typeof d !== 'object') return null;
  const extra = (x) => ({ args: strings(x.args) ? x.args : [], env: stringMap(x.env) ? x.env : {} });
  if (typeof d.npx?.package === 'string') return { kind: 'npm', ...spec(d.npx.package, ['@']), ...extra(d.npx), host: 'npmjs.com' };
  const binary = d.binary?.[PLATFORM];
  if (https(binary?.archive) && typeof binary.cmd === 'string') {
    return { kind: 'binary', archive: binary.archive, cmd: binary.cmd, sha256: typeof binary.sha256 === 'string' ? binary.sha256.toLowerCase() : null,
      version: typeof entry.version === 'string' ? entry.version : null, ...extra(binary), host: new URL(binary.archive).hostname };
  }
  if (typeof d.uvx?.package === 'string') return { kind: 'uvx', ...spec(d.uvx.package, ['==', '@']), ...extra(d.uvx), host: 'pypi.org' };
  return null;
}

const binaryName = (cmd) => path.basename(cmd).replace(/\.exe$/i, '');
/** The agent-file command for a downloaded binary, unpacked into <id>/<version>/. */
export const binaryCommand = (version, cmd) => `./${path.posix.join(version, cmd.replace(/^\.\//, ''))}`;
const description = (entry) => typeof entry.description === 'string' ? entry.description : '';
const homepage = (entry) => [entry.repository, entry.website].find(https) || null;

/** The registry as the "Add another agent…" list shows it: only what can run here. */
export async function registry(root) {
  const mine = list(root);
  const packages = new Set(mine.filter((a) => a.layer === 'built-in').map((a) => a.npm));
  const added = new Set(mine.map((a) => a.from?.registry).filter(Boolean));
  return (await fetchRegistry({ fresh: true })).flatMap((entry) => {
    const how = plan(entry);
    if (!how || typeof entry.id !== 'string' || typeof entry.name !== 'string') return [];
    // Claude and Codex are in the registry too; they are already here.
    if (how.kind === 'npm' && packages.has(how.name)) return [];
    const local = how.kind === 'binary' && which(binaryName(how.cmd));
    return [{
      id: entry.id, name: entry.name, description: description(entry),
      version: how.version || entry.version || '', kind: how.kind, host: local ? null : how.host, installed: !!local,
      authors: strings(entry.authors) ? entry.authors.join(', ') : '', license: typeof entry.license === 'string' ? entry.license : '',
      link: homepage(entry), icon: https(entry.icon) ? entry.icon : null,
      added: added.has(entry.id),
    }];
  });
}

// --- adding and removing ------------------------------------------------------

function freeId(root, wanted) {
  const base = (wanted.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 50)) || 'agent';
  const taken = new Set(list(root).map((a) => a.id));
  let id = base;
  for (let n = 2; taken.has(id) || fs.existsSync(path.join(AGENTS_DIR, id)); n++) id = `${base}-${n}`;
  return id;
}

/** Run a program to its end, logging each line it prints and keeping the tail of its output for the error. */
export function run(command, args, cwd, { log = () => {}, timeout = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    // spawnable quotes for cmd.exe itself; `shell: true` would split paths with spaces.
    const child = spawn(...spawnable([command, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }));
    let tail = '';
    // Whole lines only: a chunk can end mid-line.
    const lines = (stream) => {
      let partial = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        tail = (tail + chunk).slice(-2000);
        const parts = (partial + chunk).split('\n');
        partial = parts.pop();
        for (const line of parts) if (line.trim()) log(line.trim());
      });
    };
    lines(child.stdout); lines(child.stderr);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} timed out`)); }, timeout);
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`Could not run ${command}: ${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}${tail.trim() ? `: ${tail.trim().split('\n').slice(-3).join(' ')}` : ''}`));
    });
  });
}

/** Install one npm package, pinned exactly, into a folder of its own. */
async function npmInstall(dir, name, version) {
  fs.mkdirSync(dir, { recursive: true });
  writeJSON(path.join(dir, 'package.json'), { private: true, description: 'Installed by Fireside. Its Update button moves this pin.', dependencies: { [name]: version || 'latest' } }, 0o644);
  await run('npm', ['install', '--no-audit', '--no-fund', '--save-exact'], dir);
  // "latest" becomes the exact version npm chose, so later updates have a pin to move.
  const installed = installedPackage(dir, name).pkg.version;
  writeJSON(path.join(dir, 'package.json'), { ...JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')), dependencies: { [name]: installed } }, 0o644);
  return installed;
}

/** Download a release archive, check it when the registry gave a checksum, and unpack it into `dir`. */
export async function installBinary(dir, how) {
  fs.mkdirSync(dir, { recursive: true });
  const name = new URL(how.archive).pathname.split('/').pop() || 'download';
  const file = path.join(dir, `.download-${name}`);
  const response = await fetch(how.archive, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`The download failed (${response.status})`);
  const hash = createHash('sha256');
  await pipeline(Readable.fromWeb(response.body), async function* (source) { for await (const chunk of source) { hash.update(chunk); yield chunk; } }, fs.createWriteStream(file));
  if (how.sha256 && hash.digest('hex') !== how.sha256) throw new Error('The download does not match its published checksum, so it was not installed');
  try {
    if (/\.zip$/i.test(name)) {
      for (const [entry, bytes] of Object.entries(unzipSync(fs.readFileSync(file)))) {
        if (entry.endsWith('/')) continue;
        if (entry.startsWith('/') || entry.split(/[\\/]/).includes('..')) throw new Error(`The archive has an unsafe path: ${entry}`);
        const out = path.join(dir, entry);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, bytes);
      }
    } else if (/\.(tar|tgz|tar\.(gz|bz2|xz|zst))$/i.test(name)) {
      await run('tar', ['-xf', file, '-C', dir], dir);
    } else {
      fs.copyFileSync(file, path.join(dir, path.basename(how.cmd)));
    }
  } finally { fs.rmSync(file, { force: true }); }
  const program = path.join(dir, how.cmd);
  if (!fs.existsSync(program)) throw new Error(`The download has no ${how.cmd} in it`);
  if (process.platform !== 'win32') fs.chmodSync(program, 0o755);
}

async function fetchIcon(url, file) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const svg = response.ok ? await response.text() : '';
    if (svg.length < 65536 && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg)) { fs.writeFileSync(file, svg); return path.basename(file); }
  } catch {}
  return null;
}

/** Fetch what a registry entry needs and say how to start it afterwards. */
async function installFor(entry, how, home) {
  if (how.kind === 'npm') { await npmInstall(home, how.name, how.version); return { npm: how.name, args: how.args }; }
  if (how.kind === 'uvx') {
    if (!which('uvx')) throw fail(`${entry.name} runs through uv, which is not installed. Install uv (https://docs.astral.sh/uv/), then add it again.`);
    return { command: 'uvx', args: [how.version ? `${how.name}==${how.version}` : how.name, ...how.args], from: { kind: 'uvx', package: how.name, version: how.version } };
  }
  // Already installed by the user: use theirs, and leave updating it to them.
  if (which(binaryName(how.cmd))) return { command: binaryName(how.cmd), args: how.args };
  const version = how.version || 'current';
  await installBinary(path.join(home, version), how);
  return { command: binaryCommand(version, how.cmd), args: how.args, from: { kind: 'binary', version } };
}

/** Add an agent from the registry: install what it needs, then write its file. */
export async function addFromRegistry(root, registryId) {
  const entry = (await fetchRegistry()).find((e) => e.id === registryId);
  const how = entry && plan(entry);
  if (!how) throw fail('That agent is not in the list any more, or cannot run on this computer.', 404);
  if (list(root).some((a) => a.from?.registry === registryId)) throw fail(`${entry.name} is already added.`);
  const id = freeId(root, entry.id);
  const home = path.join(AGENTS_DIR, id);
  const agent = {
    name: entry.name, about: description(entry) || undefined, link: homepage(entry) || undefined,
  };
  try { Object.assign(agent, await installFor(entry, how, home)); }
  catch (error) { fs.rmSync(home, { recursive: true, force: true }); throw error; }
  if (Object.keys(how.env).length) agent.env = how.env;
  agent.from = { registry: entry.id, ...agent.from };
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  if (https(entry.icon)) agent.icon = await fetchIcon(entry.icon, path.join(AGENTS_DIR, `${id}.svg`)) || undefined;
  writeJSON(path.join(AGENTS_DIR, `${id}.json`), agent, 0o644);
  forget();
  return id;
}

/** Split a typed command line into a program and its arguments, honouring quotes. No shell runs it. */
function words(line) {
  const out = [];
  for (const m of String(line).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Start a program and see whether it speaks ACP. Returns the name it gives itself. */
async function probe(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FIRESIDE_CONNECTION: 'acp' }, detached: process.platform !== 'win32' });
  let output = '', started = null;
  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-1500); });
  const exited = new Promise((resolve) => child.on('error', (error) => { started = error; resolve(); }).on('close', resolve));
  try {
    const connection = new ClientSideConnection(() => ({
      sessionUpdate: () => {}, requestPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
    const info = await Promise.race([
      connection.initialize({ protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'fireside', version: '0.1.0' } }),
      exited.then(() => { throw new Error('it exited before answering'); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('it did not answer within 20 seconds')), 20000)),
    ]);
    if (info?.protocolVersion !== 1) throw new Error('it answered with a protocol version Fireside does not speak');
    return info.agentInfo?.title || info.agentInfo?.name || null;
  } catch (error) {
    if (started) throw fail(`Couldn't start ${command}: ${started.code === 'ENOENT' ? 'there is no such program on PATH' : started.message}.`, 400);
    const said = output.trim().split('\n').slice(-4).join('\n');
    throw fail(`${command} started but didn't complete the ACP handshake: ${error.message}. Check the command and its arguments.${said ? `\n\n${said}` : ''}`, 400);
  } finally {
    // The whole group: a wrapper like npx leaves the real agent running otherwise.
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {}
  }
}

/** Add an agent the user typed the command for. Saved only once it has answered. */
export async function addCommand(root, line) {
  const [command, ...args] = words(line);
  if (!command) throw fail('Type the command that starts the agent.', 400);
  const name = await probe(command, args, root);
  const id = freeId(root, name || path.basename(command));
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  writeJSON(path.join(AGENTS_DIR, `${id}.json`), { name: name || path.basename(command), command, args }, 0o644);
  forget();
  return id;
}

/** Remove an agent the user added: its file, its icon, and anything installed for it. */
export function remove(root, id) {
  const agent = get(root, id);
  if (!agent) throw fail('That agent is already gone.', 404);
  if (agent.layer !== 'user') throw fail(agent.layer === 'built-in' ? `${agent.name} comes with Fireside and can't be removed.` : `${agent.name} belongs to this project; remove it from .fireside/agents.`);
  fs.rmSync(agent.file, { force: true });
  if (agent.icon && path.basename(agent.icon) === agent.icon) fs.rmSync(path.join(AGENTS_DIR, agent.icon), { force: true });
  fs.rmSync(agent.home, { recursive: true, force: true });
  forget();
}

/** Rewrite an added agent's file in place, keeping fields Fireside does not know about. */
export function rewrite(agent, changes) {
  writeJSON(agent.file, { ...agent.raw, ...changes }, 0o644);
  forget();
}
