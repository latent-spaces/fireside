import path from 'node:path';
import { execFile } from 'node:child_process';
import { LineReader } from './lines.mjs';
import type { DeskState, Panel, GitInfo } from './contracts.ts';

export function createFeeds(ROOT: string, broadcast: (event: string, data: unknown) => void, follows: (panel: Panel, feed: string) => boolean, subscriptions: {refresh: () => unknown}) {
  const MAX_BUFFER = 500;
  const buffers = new Map<string, string[]>();
  type Tail = { file: string; reader: LineReader };
  const tails = new Map<string, Tail>();
  const git: { info: GitInfo | null; reading: boolean; dir: string } = { info: null, reading: false, dir: ROOT };
  let timer: NodeJS.Timeout | undefined;
  let gitEnabled = false, subscriptionsEnabled = false, nextGit = 0, nextSubscriptions = 0;
  // --- log tailing -----------------------------------------------------------
  // A `stream` panel with a `source` gets its file polled; new bytes are pushed
  // to the browser as lines. Panels fed by `fireside push` use buffers instead.

  function sync(state: DeskState) {
    const streams = state.panels.filter((p) => follows(p, 'lines'));
    const wanted = new Map(streams.filter((p) => p.source).map((p) => [p.id, path.resolve(ROOT, p.source!)]));
    const streamIds = new Set(streams.map((panel) => panel.id));
    for (const id of buffers.keys()) if (!streamIds.has(id)) buffers.delete(id);
    for (const [id, t] of tails) {
      if (wanted.get(id) !== t.file) { tails.delete(id); buffers.delete(id); }
    }
    for (const [id, file] of wanted) if (!tails.has(id)) tails.set(id, { file, reader: new LineReader(file) });
    const gitPanel = state.panels.find((panel) => follows(panel, 'git'));
    const wantsGit = !!gitPanel;
    const gitDir = path.resolve(ROOT, String(gitPanel?.source || '.'));
    const nextDir = gitDir === ROOT || gitDir.startsWith(ROOT + path.sep) ? gitDir : ROOT;
    if (nextDir !== git.dir) { git.dir = nextDir; nextGit = 0; }
    const wantsSubscriptions = state.panels.some((panel) => follows(panel, 'subscriptions'));
    if (!gitEnabled && wantsGit) nextGit = 0;
    if (!subscriptionsEnabled && wantsSubscriptions) nextSubscriptions = 0;
    gitEnabled = wantsGit; subscriptionsEnabled = wantsSubscriptions;
    if (!gitEnabled) git.info = null;
    if (tails.size || gitEnabled || subscriptionsEnabled) {
      if (!timer) timer = setInterval(poll, 400);
      poll();
    } else { clearInterval(timer); timer = undefined; }
  }

  function poll() {
    for (const [id, tail] of tails) readTail(id, tail);
    const now = Date.now();
    if (gitEnabled && now >= nextGit) { nextGit = now + 2500; void readGit(); }
    if (subscriptionsEnabled && now >= nextSubscriptions) { nextSubscriptions = now + 60000; subscriptions.refresh(); }
  }

  function readTail(id: string, tail: Tail) {
    const lines = tail.reader.read().filter(Boolean);
    if (lines.length) appendBuffer(id, lines);
  }

  function appendBuffer(id: string, lines: string[]) {
    const b = buffers.get(id) || [];
    lines = lines.slice(-MAX_BUFFER).map((line) => String(line).slice(0, 16000));
    b.push(...lines);
    if (b.length > MAX_BUFFER) b.splice(0, b.length - MAX_BUFFER);
    buffers.set(id, b);
    broadcast('lines', { id, lines });
  }

  // --- git -------------------------------------------------------------------
  // Polled only while a `git` window exists, and broadcast only when something
  // actually changed, so an idle repo costs one cheap process about every three seconds.
  // A `git` panel's `source` names a repository below the project, for a desk
  // whose project folder only holds the checkout.

  const runGit = (args: string[]) => new Promise<string | null>((resolve) => {
    execFile('git', args, { cwd: git.dir, timeout: 4000, maxBuffer: 4e6 }, (err, stdout) => resolve(err ? null : stdout));
  });

  const CODE: Record<string, string> = {
    M: 'modified', A: 'added', D: 'deleted', R: 'renamed',
    C: 'copied', U: 'conflict', '?': 'untracked', '!': 'ignored',
  };

  function parseStatus(out: string) {
    const info: GitInfo & { staged: NonNullable<GitInfo["staged"]>; unstaged: NonNullable<GitInfo["unstaged"]>; untracked: NonNullable<GitInfo["untracked"]> } = { repo: true, branch: '', upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };
    for (const line of out.split('\n')) {
      if (!line) continue;
      if (line.startsWith('## ')) {
        const head = line.slice(3);
        const m = head.match(/^(?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?:\s\[(.+)\])?$/);
        if (m) {
          info.branch = m[1] === 'HEAD (no branch)' ? 'detached HEAD' : m[1];
          info.upstream = m[2] || null;
          const track = m[3] || '';
          info.ahead = +(track.match(/ahead (\d+)/)?.[1] || 0);
          info.behind = +(track.match(/behind (\d+)/)?.[1] || 0);
        }
        if (head.startsWith('No commits yet')) info.fresh = true;
        continue;
      }
      const x = line[0], y = line[1];
      const path = line.slice(3).replace(/^"|"$/g, '');
      if (x === '?') { info.untracked.push({ path }); continue; }
      if (x !== ' ' && x !== '?') info.staged.push({ path, code: x, label: CODE[x] || x });
      if (y !== ' ' && y !== '?') info.unstaged.push({ path, code: y, label: CODE[y] || y });
    }
    return info;
  }

  async function readGit() {
    if (git.reading) return;
    git.reading = true;
    try {
      const status = await runGit(['status', '--porcelain', '-b']);
      if (status === null) return setGit({ repo: false });
      const info = parseStatus(status);
      const log = await runGit(['log', '-3', '--format=%h\x1f%s\x1f%cr']);
      info.commits = (log || '').split('\n').filter(Boolean).map((l) => {
        const [hash, subject, when] = l.split('\x1f');
        return { hash, subject, when };
      });
      setGit(info);
    } finally { git.reading = false; }
  }

  function setGit(info: GitInfo) {
    if (!gitEnabled) return;
    const next = JSON.stringify(info);
    if (next === JSON.stringify(git.info)) return;   // nothing changed; stay quiet
    git.info = info;
    broadcast('git', info);
  }

  return { buffers, git, sync, appendBuffer, close() { clearInterval(timer); } };
}
