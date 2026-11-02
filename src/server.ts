import { createChatController, runProviderWake } from './chat-controller.ts';
import { initializeDesktop } from './starter.mjs';
import { createRoutes } from './routes.ts';
import { createAppAssets } from './app-assets.ts';
import { watchDesk } from './watch.ts';
import { createFeeds } from './feeds.ts';
import { createSkinAssets } from './skin-assets.ts';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Activity, Panel } from './contracts.ts';
import { errorInfo } from './errors.ts';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { nodeBin } from './process.mjs';
import { randomUUID } from 'node:crypto';
import { acquireLock } from './lock.mjs';
import { json } from './http.ts';
import { writeJSON } from './storage.mjs';
import { createLayout } from './layout.mjs';
import { createSubscriptions } from './subscriptions.mjs';
import { rememberAgent } from './first-run.mjs';
import { register as registerDesk, unregister as unregisterDesk, list as listDesks } from './desks.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PKG_ROOT, projectDir, firesideDir, statePath, serverPath, ensureDirs, deskAddress } from './paths.ts';
import { listWindows } from './catalog.ts';
import { readState, withData, mutate } from './state.mjs';
import { serverCodeId, shellCodeId } from './version.ts';
import * as updates from './updates.mjs';
import { stampConsole, lastCrash, markStart, markStop } from './log.mjs';

const ROOT = projectDir();
ensureDirs(ROOT);
const releaseLock = acquireLock(path.join(firesideDir(ROOT), 'server.lock'), 0);
process.on('exit', releaseLock);
// Read how the last run ended before this one writes anything, then mark the start.
stampConsole();
const previousCrash = lastCrash(path.join(firesideDir(ROOT), 'server.log'));
markStart();
initializeDesktop(ROOT);
const layout = createLayout(ROOT);
const TOKEN = randomUUID();
const clients = new Set<ServerResponse>();
const activity: Activity[] = [];         // recent tool events, newest last
const MAX_ACTIVITY = 200;
const deskList = () => listDesks().map((desk) => ({ ...desk, url: desk.url && deskAddress(desk.url), current: desk.dir === ROOT }));
const subscriptions = createSubscriptions((view: unknown) => broadcast('subscriptions', view), { wakeProvider: (provider: string) => runProviderWake(ROOT, provider) });
const CODE_ID = serverCodeId();                        // what `fireside start` checks for staleness
let SHELL_ID = shellCodeId();                          // a page that loaded other shell code reloads
let codeStale = false;                                 // src/ changed since this server started
let restarting = false;
let brokenCode = '';                                    // a code id that failed to load, not retried
let seenCode = CODE_ID, codeChangedAt = 0;             // the last code on disk, and when it last changed

let componentRevision = Date.now();
let skinRevision: string | number = CODE_ID;
const windowRevisions = new Map<string, number>();
const windowRevision = (kind: string) => windowRevisions.get(kind) || CODE_ID;
function broadcast(type: string, data: unknown) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    if (res.destroyed) { clients.delete(res); continue; }
    if (res.writableLength > 2_000_000) { clients.delete(res); res.destroy(); continue; }
    res.write(frame);
  }
}

function snapshot() {
  return {
    project: ROOT, stateError,
    state: { ...currentState, ...(runtimeStatus ? { status: runtimeStatus } : {}) }, activity, ...chatView(), git: git.info, subscriptions: subscriptions.view(), componentRevision,
    buffers: Object.fromEntries(buffers), layout: layout.value, updates: updates.view(), shell: SHELL_ID,
  };
}

let stateError: string | null = null;
let runtimeStatus: { text: string; tone: string } | null = null;
// Panel data files are read in here, so a snapshot never touches the disk.
let currentState = withData(readState(ROOT), ROOT);
function refreshState() {
  try {
    if (!fs.existsSync(statePath(ROOT))) return currentState;
    const next = withData(readState(ROOT), ROOT);
    if (JSON.stringify(next.status) !== JSON.stringify(currentState.status)) runtimeStatus = null;
    currentState = next; stateError = null;
  }
  catch (error) { stateError = errorInfo(error).message; console.error(stateError); }
  return currentState;
}

const pushState = () => broadcast('state', snapshot());

// Which feeds each window kind follows, per its window.json. Read again each time
// the page loads the window list, which it does after any window file changes.
const feedsByKind = () => Object.fromEntries(listWindows(ROOT).map((w) => [w.kind, w.feeds || []]));
let FEEDS = feedsByKind();
const follows = (panel: Panel, feed: string) => !!FEEDS[panel.kind]?.includes(feed);

const { buffers, git, sync: syncFeeds, appendBuffer, close: closeFeeds } = createFeeds(ROOT, broadcast, follows, subscriptions);
const { findSkin, cachedAsset, cacheAsset } = createSkinAssets(ROOT, record);

const { tabs, view: chatView, busyChat, pushAcp, agentStatus } = createChatController(ROOT, broadcast, record, connected, setStatus);

function record(entry: Activity) {
  const row = { id: randomUUID(), at: Date.now(), ...entry };
  activity.push(row);
  if (activity.length > MAX_ACTIVITY) activity.splice(0, activity.length - MAX_ACTIVITY);
  broadcast('activity', row);   // the stored row, so live items carry a timestamp
  return row;
}

// A project whose fire has been lit doesn't need the intro again.
function connected(agent: string) {
  rememberAgent(agent);
  if (currentState.lit) return;
  mutate((state) => { state.lit = new Date().toISOString(); return state; }, ROOT);
  refreshState();   // every streamed token lands here; read the write back at once
}

function setStatus(text: string, tone: string) {
  if (runtimeStatus?.text === text && runtimeStatus?.tone === tone) return;
  runtimeStatus = { text, tone };
  broadcast('status', runtimeStatus);
}

// --- http ------------------------------------------------------------------

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    const { message, status, code } = errorInfo(error);
    // A refused or missing request is the client's to hear about, not the log's.
    const fault = !(status && status < 500) && code !== 'ENOENT';
    if (fault) console.error(error instanceof Error && error.stack || message);
    if (res.headersSent) return res.destroy();
    json(res, { ok: false, error: message }, status || (code === 'ENOENT' ? 404 : 500));
  });
});

const appAssets = await createAppAssets();
const handleRequest = createRoutes({
  ROOT, TOKEN, url, snapshot, clients, layout, record, deskList, busyChat, tabs,
  pushAcp, pushState, subscriptions, agentStatus, follows, refreshState,
  appendBuffer, findSkin, cachedAsset, cacheAsset, appAssets,
  getState: () => currentState,
  windowList: () => listWindows(ROOT).map((window) => ({ ...window, revision: windowRevision(window.kind) })),
  revision: () => componentRevision, skinRevision: () => skinRevision, codeId: CODE_ID,
});
let closeWatch: (() => void) | undefined;

// --- lifecycle -------------------------------------------------------------

function url() { const a = server.address() as AddressInfo; return `http://127.0.0.1:${a.port}`; }

async function listen(port: number) {
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolve(); };
        server.once('error', fail);
        server.once('listening', ready);
        server.listen(port + attempt, '127.0.0.1');
      });
      break;
    } catch (error) { if (errorInfo(error).code !== 'EADDRINUSE' || attempt >= 20) throw error; }
  }
  const descriptor = { url: url(), port: (server.address() as AddressInfo).port, pid: process.pid, dir: ROOT, token: TOKEN };
  writeJSON(serverPath(ROOT), descriptor);
  registerDesk(descriptor);
  syncFeeds(refreshState());
  closeWatch = watchDesk(ROOT, () => {
    syncFeeds(refreshState()); pushState();
  }, (changes) => {
    FEEDS = feedsByKind();
    syncFeeds(refreshState());
    componentRevision = Date.now();
    if (changes.skins) skinRevision = componentRevision;
    for (const kind of changes.windows) windowRevisions.set(kind, componentRevision);
    pushState();
  }, checkCode, (css) => {
    if (css) broadcast('shell-css', Date.now());
    else { SHELL_ID = shellCodeId(); pushState(); }
  });
  console.log(url());
}

/** Hand the desk to a fresh server running the current src/. `fireside start` sees
 *  this one is older, stops it, and starts the new one; chats reopen where they were. */
function restart() {
  const env: NodeJS.ProcessEnv = { ...process.env, FIRESIDE_PROJECT: ROOT };
  delete env.FIRESIDE_CONNECTION;
  spawn(nodeBin(), [path.join(PKG_ROOT, 'bin', 'fireside.mjs'), 'start', '--open', 'false', '--port', String((server.address() as AddressInfo).port)],
    { cwd: ROOT, env, detached: true, stdio: 'ignore' }).unref();
  record({ type: 'session', label: 'Fireside restarted to run its new code' });
}

// Node ends a crash with its own version line; the error is the last line that names one.
const errorLine = (stderr: string) => stderr.split('\n').filter((line) => /\w*Error\b/.test(line)).pop()?.trim();

/** Load the new code in a throwaway process first, so a typo cannot take the desk
 *  down. Null when it loads; otherwise the error it hit. */
function codeLoads(): Promise<string | null> {
  const dir = path.join(PKG_ROOT, 'src');
  const run = (args: string[]) => new Promise<string | null>((resolve) => {
    execFile(nodeBin(), args, { cwd: ROOT, timeout: 20000 }, (error, _out, stderr) =>
      resolve(error ? errorLine(String(stderr)) || error.message : null));
  });
  // Every module but the two entry points imports cleanly on its own; those two
  // start things when loaded, so they get a syntax check instead.
  const modules = fs.readdirSync(dir).filter((name) => /\.(ts|mjs)$/.test(name) && !['server.ts', 'cli.mjs'].includes(name))
    .map((name) => pathToFileURL(path.join(dir, name)).href);
  return run(['--input-type=module', '-e', `for (const m of ${JSON.stringify(modules)}) await import(m);`])
    .then((error) => error || run(['--check', path.join(dir, 'server.ts')]))
    .then((error) => error || run(['--check', path.join(dir, 'cli.mjs')]));
}

/** Run the new server for real, on a scratch project and home, and see it serve
 *  and stay up past startup -- restoring chats, the first update check -- where
 *  loading alone proves nothing. Null when it does; otherwise what went wrong. */
function codeStarts(): Promise<string | null> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fireside-trial-'));
  const env: NodeJS.ProcessEnv = { ...process.env, FIRESIDE_PROJECT: scratch, FIRESIDE_HOME: path.join(scratch, 'home'),
    FIRESIDE_PORT: String(40000 + Math.floor(Math.random() * 20000)) };
  delete env.FIRESIDE_CONNECTION;
  const child = spawn(nodeBin(), [path.join(PKG_ROOT, 'src', 'server.ts')], { cwd: scratch, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  return new Promise((resolve) => {
    let settled = false;
    const done = (error: string | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill('SIGKILL');
      fs.rmSync(scratch, { recursive: true, force: true });
      resolve(error);
    };
    child.on('exit', (code) => done(errorLine(stderr) || `it stopped on start (exit code ${code})`));
    const timer = setTimeout(async () => {
      try {
        const { url } = JSON.parse(fs.readFileSync(serverPath(scratch), 'utf8'));
        const answer = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(3000) });
        done(answer.ok ? null : `it answered ${answer.status}`);
      } catch { done(errorLine(stderr) || 'it did not start serving'); }
    }, 6000);
  });
}

/** Whether a chat on another desk is replying. An agent editing Fireside is one,
 *  and its edits are not finished until its turn is. */
async function otherDeskBusy() {
  const answers = await Promise.all(listDesks().filter((desk) => desk.running && desk.dir !== ROOT).map((desk) =>
    fetch(`${desk.url}/api/ping`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).then((info) => info?.busy === true, () => false)));
  return answers.some(Boolean);
}

// Code still being edited is not tried: it waits for every desk's chats to
// finish their turn and for src/ to sit still, then has to start for real.
const SETTLE = 15000;
async function restartWhenReady() {
  const id = serverCodeId();
  if (restarting || busyChat() || id === brokenCode || Date.now() - codeChangedAt < SETTLE) return;
  restarting = true;
  let handedOver = false;
  try {
    if (await otherDeskBusy()) return;
    const error = await codeLoads() || await codeStarts();
    if (serverCodeId() !== id) return;   // edited again meanwhile: try that instead
    if (error) { brokenCode = id; setStatus(`Fireside's new code does not start: ${error}`, 'attention'); return; }
    restart(); handedOver = true;   // `restarting` stays set: this server is on its way out
  } finally { if (!handedOver) restarting = false; }
}

// Editing Fireside's server code takes effect by itself: the desk restarts as soon
// as no chat is mid-reply and the new code loads, so a turn is never cut off.
// Nothing asks the user to do it; the page reloads itself on reconnecting.
function checkCode() {
  const id = serverCodeId();
  if (id !== seenCode) { seenCode = id; codeChangedAt = Date.now(); }
  codeStale = id !== CODE_ID;
  if (codeStale) void restartWhenReady();
  else if (brokenCode) {
    // The broken edit was undone: the code on disk is what is running again.
    brokenCode = ''; runtimeStatus = null;
    agentStatus(); pushState();
  }
}
// A restart that waited for a busy chat goes ahead once the chat is done.
setInterval(() => { if (codeStale) void restartWhenReady(); }, 2000);
// Cleanup hangs off `exit`, which runs however the process gets there. Windows
// cannot deliver SIGTERM to a handler at all -- a kill there is abrupt -- so
// nothing may run; the descriptor and the lock are both written to be reclaimed
// by the next start, which pings the recorded pid and takes over if it is gone.
process.on('exit', () => { try { fs.unlinkSync(serverPath(ROOT)); } catch {} unregisterDesk(ROOT, process.pid); });
// A stray error in a timer or a promise must not take the desk, and every chat
// on it, down with it. It goes to .fireside/server.log and the status line.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (error) => {
    console.error(`fireside: ${event}:`, error);
    setStatus(`Fireside hit an error and kept running: ${errorInfo(error).message}`, 'attention');
  });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  closeWatch?.(); closeFeeds();
  for (const client of clients) client.end();
  server.close(); server.closeAllConnections();
  await appAssets.close(); await tabs.closeAll();
  markStop();
  process.exit(0);
});

// A desk can stay up for days, so checking at startup alone would go stale on
// exactly the long-running desks that need it. Tick hourly and let the cache's
// own age decide; the registry is only reached once a day. Never blocks a
// start, never fails a desk: an unreachable registry just shows nothing.
async function checkUpdates() {
  if (!updates.stale()) return;
  const before = JSON.stringify(updates.view());
  try { await updates.check(); } catch {}
  if (JSON.stringify(updates.view()) !== before) pushState();
}
setInterval(checkUpdates, 60 * 60 * 1000);

listen(Number(process.env.FIRESIDE_PORT) || 4830).then(async () => {
  await tabs.restore();
  if (previousCrash) {
    const when = new Date(previousCrash.at);
    const time = when.toDateString() === new Date().toDateString() ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : when.toLocaleString();
    const text = `Fireside stopped unexpectedly at ${time}${previousCrash.error ? `: ${previousCrash.error}` : ''}. Details are in .fireside/server.log`;
    record({ type: 'notice', label: text });
    setStatus(text, 'attention');
  }
  checkUpdates();
}).catch((error) => { console.error(errorInfo(error).message); process.exit(1); });
