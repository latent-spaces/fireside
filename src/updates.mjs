import { writeJSON } from './storage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { USER_DIR } from './paths.ts';
import { acquireLock } from './lock.mjs';
import { alive } from './process.mjs';
import * as agents from './agents.mjs';
import { fail } from './errors.ts';

// Fireside does not run the `claude` on your PATH. It spawns the adapter in this
// checkout's node_modules, and that adapter bundles its own Claude Code binary
// through an exact dependency pin. So a model released today stays invisible
// until this package is bumped, however current the CLI is -- `claude update`
// cannot reach it. Watching the pin catches that, and every other adapter fix,
// without reading Claude Code's private model catalog.
//
// Codex is the same story with one more link: its adapter depends on a range of
// `@openai/codex`, so Fireside does not pin that package itself. Moving the
// adapter moves the Codex under it, and src/subscriptions.mjs resolves Codex
// through the adapter so the usage reader runs that same copy.
//
// Every agent Fireside installed is watched the same way: the two built in, and
// any the user added from the ACP registry (src/agents.mjs). An npm agent moves
// its pin in the package.json beside it; a uvx agent moves the version in its
// command; a downloaded binary is fetched again at the registry's newer version.
// Agents the user installed themselves (a command on PATH) are theirs to update.
// Nothing below names a package.
function watched() {
  return agents.managed().flatMap((agent) => {
    const row = { label: agent.layer === 'built-in' ? `${agent.name} agent` : agent.name, what: agent.about, agent };
    if (agent.npm) return [{ ...row, kind: 'npm', name: agent.npm, root: agent.home }];
    if (agent.from?.kind === 'uvx' && typeof agent.from.package === 'string') return [{ ...row, kind: 'uvx', name: agent.from.package }];
    if (agent.from?.kind === 'binary' && typeof agent.from.registry === 'string') return [{ ...row, kind: 'binary', name: agent.from.registry }];
    return [];
  });
}
// The cache key. npm rows keep the bare package name the cache has always used.
const key = (row) => row.kind === 'npm' ? row.name : `${row.kind}:${row.name}`;

const FILE = path.join(USER_DIR, 'updates.json');
const LOCK = path.join(USER_DIR, 'updates.lock');
const STALE = 24 * 60 * 60 * 1000;
const REGISTRY = 'https://registry.npmjs.org';

/** The version actually on disk, resolved the way src/agents.mjs resolves what it
 *  spawns, so this can never disagree with what really runs. */
function installed(row) {
  if (row.kind !== 'npm') return typeof row.agent.from?.version === 'string' ? row.agent.from.version : null;
  try { return agents.installedPackage(row.root, row.name).pkg.version || null; } catch { return null; }
}

/** The newest release: npm's `latest` dist-tag (which excludes prereleases),
 *  PyPI's current version, or the version the ACP registry now lists. */
async function published(row) {
  if (row.kind === 'uvx') return usable((await getJSON(`https://pypi.org/pypi/${encodeURIComponent(row.name)}/json`, 'PyPI'))?.info?.version);
  if (row.kind === 'binary') {
    const how = await offered(row);
    if (how?.kind !== 'binary') throw new Error('No longer a download for this computer');
    return usable(how.version);
  }
  return usable((await getJSON(`${REGISTRY}/${row.name.replace('/', '%2F')}/latest`, 'Registry'))?.version);
}
async function getJSON(url, who) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${who} said ${response.status}`);
  return response.json();
}
/** How the ACP registry now says a downloaded agent installs here. */
const offered = async (row) => agents.plan((await agents.fetchRegistry({ fresh: true })).find((e) => e.id === row.name));
function usable(version) {
  if (typeof version !== 'string' || !/^\d+(\.\d+)*/.test(version)) throw new Error('Registry returned no usable version');
  return version;
}

/** Release ordering only: the `latest` tag never carries a prerelease, so the
 *  suffix a local build might have is compared as "older than the release". */
function behind(from, to) {
  if (!from || !to) return false;
  const parts = (v) => v.split('-')[0].split('.').map((n) => Number(n) || 0);
  const [a, b] = [parts(from), parts(to)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  }
  return from.includes('-') && !to.includes('-');
}

function read() {
  try {
    const value = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// Best effort, like the desk registry: a desk that cannot write this still runs.
function write(value) {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    writeJSON(FILE, value);
  } catch (error) { console.error(`Cannot write ${FILE}: ${error.message}`); }
}

/** What the menubar shows: cached answers only, never a fetch, never disk-bound
 *  work on the render path. Packages that are current are simply absent. */
export function view() {
  const cache = read();
  return watched().flatMap((row) => {
    const from = installed(row);
    const to = cache[key(row)]?.latest;
    if (!behind(from, to)) return [];
    return [{ name: row.name, label: row.label, what: row.what, from, to }];
  });
}

export function stale(at = Date.now()) {
  const cache = read();
  return watched().some((row) => !(at - (cache[key(row)]?.at || 0) < STALE));
}

/** Refresh the cache. Fails open in every direction: an unreachable registry
 *  leaves the last answer in place and simply shows nothing new. */
export async function check({ force = false } = {}) {
  const cache = read();
  const now = Date.now();
  let changed = false;
  for (const row of watched()) {
    const k = key(row);
    if (!force && now - (cache[k]?.at || 0) < STALE) continue;
    try {
      const latest = await published(row);
      cache[k] = { latest, at: now };
      changed = true;
    } catch {
      // Keep the previous answer; only push the next attempt out an hour so a
      // registry that is down does not get retried on every tick.
      if (cache[k]) { cache[k].at = now - STALE + 60 * 60 * 1000; changed = true; }
    }
  }
  if (changed) write(cache);
  return view();
}

/**
 * Install the named agents at their latest release.
 *
 * Every desk on this machine runs the same installs, so this changes the agent
 * under all of them at once -- hence the cross-process lock, which src/acp.mjs
 * checks before spawning so no desk can start an agent from a half-written
 * tree. Only agents move: the server's own client SDK stays as it is, so no
 * desk needs restarting, just a reconnect.
 */
/** @param {string[]} names
 * @param {{log?: (line: string) => void}} options */
export async function apply(names, { log = () => {} } = {}) {
  const wanted = watched().filter((row) => names.includes(row.name));
  if (!wanted.length) throw fail('Nothing to update', 400);
  const cache = read();
  const targets = wanted.map((row) => {
    const latest = cache[key(row)]?.latest;
    if (!behind(installed(row), latest)) throw fail(`${row.label} is already up to date`);
    return { ...row, latest };
  });

  fs.mkdirSync(USER_DIR, { recursive: true });
  const release = acquireLock(LOCK, 5000);
  try {
    // npm agents that share a folder (the two built in share Fireside's) move together.
    const roots = [...new Set(targets.filter((t) => t.kind === 'npm').map((t) => t.root))];
    for (const root of roots) await moveNpmPins(root, targets.filter((t) => t.kind === 'npm' && t.root === root), log);
    for (const row of targets.filter((t) => t.kind === 'uvx')) {
      log(`${row.label}: ${row.name}==${row.latest}`);
      const args = [...row.agent.args];
      const at = args.findIndex((arg) => arg === row.name || arg.startsWith(`${row.name}==`) || arg.startsWith(`${row.name}@`));
      if (at === -1) throw fail(`${row.label}'s command no longer names ${row.name}`);
      args[at] = `${row.name}==${row.latest}`;
      agents.rewrite(row.agent, { args, from: { ...row.agent.from, version: row.latest } });
    }
    for (const row of targets.filter((t) => t.kind === 'binary')) await moveBinary(row, log);
  } finally { release(); }

  // Re-read: a uvx or binary agent's version lives in the file just rewritten.
  const now = watched();
  const done = wanted.map((row) => ({ name: row.name, label: row.label, version: installed(now.find((r) => r.name === row.name && r.kind === row.kind) || row) }));
  for (const row of wanted) (cache[key(row)] ??= {}).at = 0; // re-check on the next tick
  write(cache);
  return done;
}

// `npm install <pkg>@<version>` would reformat the manifest and rewrite the
// pin as a caret range. A range is the wrong shape here: every dependency is
// pinned exactly so the agent can never drift on an unrelated install, which
// is the surprise this whole feature exists to catch. So edit the one version
// string and let a plain `npm install` reconcile the tree and the lockfile.
async function moveNpmPins(root, rows, log) {
  const manifest = path.join(root, 'package.json');
  const original = fs.readFileSync(manifest, 'utf8');
  let next = original;
  for (const row of rows) {
    const pattern = new RegExp(`("${row.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*")[^"]+(")`);
    if (!pattern.test(next)) throw fail(`${row.label} is not pinned in ${manifest}`);
    next = next.replace(pattern, `$1${row.latest}$2`);
  }
  fs.writeFileSync(manifest, next);
  log(`npm install (${rows.map((r) => `${r.name}@${r.latest}`).join(', ')})`);
  try {
    await agents.run('npm', ['install', '--no-audit', '--no-fund'], root, { log });
  } catch (error) {
    // A failed install leaves node_modules to npm, but the manifest is ours:
    // put it back so the next attempt starts from a known pin.
    fs.writeFileSync(manifest, original);
    throw error;
  }
}

// A downloaded agent gets its new version beside the old one, and only once it
// is unpacked and checked does the agent file point at it. Then the old goes.
async function moveBinary(row, log) {
  const how = await offered(row);
  if (how?.kind !== 'binary' || how.version !== row.latest) throw fail(`${row.label} ${row.latest} is no longer offered for this computer`);
  const { agent } = row;
  const target = path.join(agent.home, how.version);
  log(`${row.label}: downloading ${how.version} from ${how.host}`);
  fs.rmSync(target, { recursive: true, force: true });
  try { await agents.installBinary(target, how); }
  catch (error) { fs.rmSync(target, { recursive: true, force: true }); throw error; }
  agents.rewrite(agent, { command: agents.binaryCommand(how.version, how.cmd), args: how.args, from: { ...agent.from, version: how.version } });
  const old = typeof agent.from?.version === 'string' && path.join(agent.home, agent.from.version);
  if (old && old !== target && path.dirname(old) === agent.home) fs.rmSync(old, { recursive: true, force: true });
}

/** Held while another desk is installing, so no agent spawns mid-write. A lock
 *  whose owner died is not held: the same rule acquireLock uses to reclaim it. */
export function installing() {
  try {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    return Number.isInteger(pid) && pid > 1 && pid !== process.pid && alive(pid);
  } catch { return false; }
}
