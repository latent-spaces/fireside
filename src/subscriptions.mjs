import { writeJSON } from './storage.mjs';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { USER_DIR } from './paths.ts';
import { nodeBin } from './process.mjs';
import { fail } from './errors.ts';
import { acquireLock } from './lock.mjs';

// Usage reads start no model turns. Only an explicit wake-up does.
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const label = value => value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
const duration = mins => mins >= 1440 ? `${mins / 1440} day` : mins >= 60 ? `${mins / 60} hour` : `${mins} min`;
const limit = (name, used, reset, durationMins = null, extra = {}) => ({
  name, used, resetsAt: Number.isFinite(reset) ? reset : null,
  durationMins: Number.isFinite(durationMins) ? durationMins : null, ...extra,
});
const dollars = n => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
// Claude's usage keys past five_hour and seven_day* are internal codenames
// (iguana_necktie, nimbus_quill…) with no display name. Name them by what they hold:
// a dollar limit is a credit grant, and its date is when it expires, not a reset.
function claudeLimit(key, v) {
  const reset = Date.parse(v.resets_at);
  if (Number.isFinite(v.limit_dollars)) {
    return limit(`Credits · ${dollars(v.used_dollars || 0)} of ${dollars(v.limit_dollars)}`, v.utilization, reset, null, { expires: true });
  }
  const name = /^(five_hour|seven_day)/.test(key) ? label(key) : 'Other limit';
  return limit(name, v.utilization, reset, key === 'five_hour' ? 300 : null);
}
// Anthropic's usage endpoint rate-limits hard, so read rarely and honour retry-after,
// which can be 0. Its budget is the account's, shared with every Claude Code
// session on it, so one read per five minutes can still draw a 429: each 429 in
// a row doubles the wait, from five minutes up to an hour.
const AUTO_REFRESH = 5 * 60_000;
const MANUAL_GAP = 60_000;
const MIN_BACKOFF = 5 * 60_000;
const MAX_BACKOFF = 60 * 60_000;
// Anthropic's usage endpoint can trail the model response by a few seconds.
const CONFIRM_DELAYS = [3000];
// A wake note is news for a minute or two, then it is just stale text on screen.
const RESULTS_TTL = 2 * 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const refuse = message => fail(message);

// Every desk on this machine reads the same account, and the provider counts
// per account, not per process. One shared file turns ten desks into one read:
// whoever reads publishes, everyone else adopts the numbers and the backoff.
const CACHE = path.join(USER_DIR, 'usage.json');
// Held while one desk reads, so two desks falling due together make one read.
const LOCK = path.join(USER_DIR, 'usage.lock');
// Rows are cached already named, so a desk still running older code would
// spread its names to every desk. Bump when naming changes; other formats are ignored.
const FORMAT = 2;

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; }
}

// Last writer wins per provider. Two desks racing can drop one another's row;
// the loser simply reads again when it is due.
function writeCache(name, row) {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    writeJSON(CACHE, { ...readCache(), [name]: { ...row, format: FORMAT } });
  } catch (error) { console.error(`Cannot write ${CACHE}: ${error.message}`); }
}

// Someone else's fresher read counts as ours: it is the same account.
function adopt(row, cache = readCache()) {
  const shared = cache[row.name];
  return shared?.format === FORMAT && (shared.checked || 0) > (row.checked || 0) ? { ...shared, name: row.name } : row;
}

function retryAt(header, strikes, now = Date.now()) {
  const seconds = header ? Number(header) : NaN;
  const date = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(header || '');
  const backoff = Math.min(MIN_BACKOFF * 2 ** (strikes - 1), MAX_BACKOFF);
  return Math.max(Number.isFinite(date) ? date : 0, now + backoff);
}

async function readClaude() {
  let token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
    let credentials;
    try { credentials = await readFile(path.join(dir, '.credentials.json'), 'utf8'); } catch {}
    if (!credentials && process.platform === 'darwin' && !process.env.CLAUDE_CONFIG_DIR) {
      credentials = (await exec('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 })).stdout;
    }
    token = credentials && JSON.parse(credentials).claudeAiOauth?.accessToken;
  }
  if (!token) return { windows: [], message: 'No subscription login found.' };
  const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  if (response.status === 429) throw Object.assign(new Error('Rate limited'), { retryAfter: response.headers.get('retry-after') });
  if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Usage unavailable'), { login: true });
  if (!response.ok) throw new Error('Usage unavailable');
  return { windows: Object.entries(await response.json())
    .filter(([key, v]) => Number.isFinite(v?.utilization) && (key !== 'extra_usage' || v.is_enabled))
    // Unused limits with no reset are placeholders, often under internal codenames.
    .filter(([key, v]) => key === 'five_hour' || v.utilization > 0 || v.resets_at)
    .map(([key, v]) => claudeLimit(key, v)) };
}

// Codex's app server handles its own credentials; this starts no thread or model turn.
async function readCodex() {
  // The adapter owns the Codex version, so read usage with the copy it runs.
  const codex = createRequire(require.resolve('@agentclientprotocol/codex-acp/package.json')).resolve('@openai/codex/bin/codex.js');
  const child = spawn(nodeBin(), [codex, 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let id = 0;
  const abort = () => { for (const { reject } of pending.values()) reject(new Error('Usage unavailable')); pending.clear(); };
  child.on('error', abort); child.on('exit', abort); child.stdin.on('error', abort);
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error('Usage unavailable'));
    else request.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const timer = setTimeout(() => { abort(); child.kill('SIGKILL'); }, 15000);
  try {
    await request('initialize', { clientInfo: { name: 'fireside_usage', version: '0.1.0' } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const data = await request('account/rateLimits/read');
    const buckets = Object.entries(data.rateLimitsByLimitId || {});
    if (!buckets.length && data.rateLimits) buckets.push(['codex', data.rateLimits]);
    return { windows: buckets.flatMap(([bucketId, bucket]) => Object.entries(bucket || {})
      .filter(([, v]) => Number.isFinite(v?.usedPercent))
      .map(([key, v]) => limit(`${bucket.limitName || label(bucketId)} · ${v.windowDurationMins ? duration(v.windowDurationMins) : label(key)}`,
        v.usedPercent, Number.isFinite(v.resetsAt) ? v.resetsAt * 1000 : null, v.windowDurationMins))) };
  } finally {
    clearTimeout(timer); lines.close(); child.stdin.destroy(); child.kill('SIGKILL');
  }
}

const READERS = { Claude: readClaude, Codex: readCodex };

// A failed read keeps the last numbers. `checked` is the last attempt, `at` the last success.
// Only these normalized rows reach the browser; credentials and raw errors never do.
export function createSubscriptions(onChange, { wakeProvider } = {}) {
  let rows = Object.keys(READERS).map(name => ({ name, windows: [], message: 'Loading usage…' }));
  let reading = false;
  let waking = false;
  let results = [];            // what the last wake did, one row per provider
  let resultsTimer = null;
  let refreshDone = Promise.resolve();
  // Results speak for themselves for a couple of minutes, then clear themselves.
  const report = next => {
    results = next;
    clearTimeout(resultsTimer);
    if (!results.length) return;
    resultsTimer = setTimeout(() => { results = []; onChange(view()); }, RESULTS_TTL);
    resultsTimer.unref?.();
  };
  const fiveHour = provider => rows.find(row => row.name === provider)?.windows
    .find(window => window.durationMins === 300 || /\b5 hour\b/i.test(window.name));
  const isActive = provider => fiveHour(provider)?.resetsAt > Date.now();
  // Worth waking: usage was read, and the five-hour window has expired unused.
  const idle = (provider) => {
    const row = rows.find(item => item.name === provider);
    if (!row?.at || row.message) return false;
    const window = fiveHour(provider);
    return !!window && (!window.resetsAt || window.resetsAt <= Date.now()) && window.used === 0;
  };
  const targets = () => rows.filter(row => idle(row.name)).map(row => row.name);
  const view = () => ({
    providers: rows, reading,
    wake: { available: !!wakeProvider && !!targets().length, working: waking, results },
  });
  const due = (row, gap) => row.retryAt ? Date.now() >= row.retryAt : !row.checked || Date.now() - row.checked >= gap;

  // One provider's turn, then the re-reads that confirm the clock really started.
  async function wakeOne(provider) {
    const { model } = await wakeProvider(provider);
    for (const delay of [0, ...CONFIRM_DELAYS]) {
      if (delay) await sleep(delay);
      await api.refresh({ force: true, provider });
      if (isActive(provider)) return `Five-hour clock running. Woken with ${model}.`;
    }
    return `${model} replied. The usage clock is not confirmed yet; refresh to check.`;
  }

  const api = {
    view,
    async refresh({ manual = false, force = false, provider = null } = {}) {
      if (reading) {
        await refreshDone;
        if (force) return api.refresh({ manual, force, provider });
        return;
      }
      const pick = () => {
        const shared = readCache();
        const adopted = rows.map(row => adopt(row, shared));
        const changed = adopted.some((row, i) => row !== rows[i]);
        rows = adopted;
        return { changed, names: new Set(rows
          .filter(row => (!provider || row.name === provider) && (force && !row.retryAt || due(row, manual ? MANUAL_GAP : AUTO_REFRESH)))
          .map(row => row.name)) };
      };
      let { changed, names } = pick();
      let release = null;
      if (names.size) {
        // Another desk is reading right now: its numbers land in the cache for everyone.
        try { fs.mkdirSync(USER_DIR, { recursive: true }); release = acquireLock(LOCK, 0); } catch { names = new Set(); }
        // It may have just finished, too.
        if (release) ({ names } = pick());
      }
      // Another desk's numbers are news too, even when nothing is due here.
      if (!names.size) { release?.(); if (manual || changed) onChange(view()); return; }
      reading = true;
      let finish;
      refreshDone = new Promise(resolve => { finish = resolve; });
      onChange(view());
      try {
        rows = await Promise.all(rows.map(async row => {
          if (!names.has(row.name)) return row;
          const checked = Date.now();
          const publish = next => { writeCache(row.name, next); return next; };
          try { return publish({ name: row.name, ...await READERS[row.name](), at: checked, checked }); }
          catch (error) {
            const last = { name: row.name, windows: row.windows, at: row.at, checked };
            if (error?.retryAfter !== undefined) {
              const strikes = (row.strikes || 0) + 1;
              return publish({ ...last, strikes, retryAt: retryAt(error.retryAfter, strikes), message: 'Rate-limited by the provider.' });
            }
            if (error?.login) return publish({ ...last, message: 'Usage unavailable. Check the provider’s CLI login.' });
            return publish({ ...last, message: row.at ? 'Couldn’t update; showing the last numbers.' : 'Usage unavailable right now.' });
          }
        }));
      } finally {
        release();
        reading = false;
        finish();
        onChange(view());
      }
    },
    // Refuses synchronously, so the route can answer before the run — which takes
    // up to a minute per provider — finishes. Its outcome rides the broadcast.
    wake() {
      if (!wakeProvider) throw refuse('Wake-up is unavailable');
      if (waking) throw refuse('A wake-up is already running');
      const idlers = targets();
      if (!idlers.length) throw refuse('Every five-hour window is already active or unavailable');
      waking = true; report([]); onChange(view());
      return (async () => {
        for (const provider of idlers) {
          // One provider failing must not cost the other its turn.
          try { report([...results, { name: provider, ok: true, message: await wakeOne(provider) }]); }
          catch (error) { report([...results, { name: provider, ok: false, message: error.message || 'Could not start the usage window.' }]); }
          onChange(view());
        }
      })().finally(() => { waking = false; onChange(view()); });
    },
  };
  return api;
}
