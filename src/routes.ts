import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeskState, Panel } from './contracts.ts';
import { errorInfo } from './errors.ts';
import { launch, runToEnd, runCommand, validCommand } from './launchers.mjs';
import { nodeBin } from './process.mjs';
import { body, rawBody, json, guard, projectFile } from './http.ts';
import { packComponent, stageComponent } from './components.ts';
import { serveFile } from './app-assets.ts';
import { createChatRoutes } from './chat-routes.ts';
import { list as listDesks, stop as stopDesk, start as startDesk, forget as forgetDesk } from './desks.mjs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PKG_ROOT, firesideDir } from './paths.ts';
import { windowFolder, listSkins, bundledURL } from './catalog.ts';
import { readState, mutate, upsertPanel, savePanelData } from './state.mjs';
import * as updates from './updates.mjs';
import { firstRun, markToured } from './first-run.mjs';
import type { RouteContext } from './route-context.ts';

// Each window's commands, queued: a chain per window id, and the command name
// that is waiting to start (with its promise) so a repeat can join it.
const commandChains = new Map<string, { tail: Promise<unknown>; waiting: Map<string, Promise<unknown>> }>();
function windowCommand(root: string, id: string, name: string, cmd: string[]) {
  const chain = commandChains.get(id) || { tail: Promise.resolve(), waiting: new Map() };
  commandChains.set(id, chain);
  if (chain.waiting.has(name)) return chain.waiting.get(name)!;
  const run = chain.tail.catch(() => {}).then(() => { chain.waiting.delete(name); return runToEnd(cmd, root); });
  chain.waiting.set(name, run);
  chain.tail = run;
  run.catch(() => {}).finally(() => { if (chain.tail === run) commandChains.delete(id); });
  return run;
}

// The parts of .fireside a page may read: panel files, fetched skin art, app icons.
// Folders inside .fireside that windows may show: panel files, skin and icon images,
// `fireside shot` pictures, and media the CLI copied in from outside the project.
const SHARED = ['panels', 'skins/assets', 'icons', 'shots', 'media'];

export function createRoutes(context: RouteContext) {
  const { ROOT, TOKEN, url, snapshot, clients, layout, record, deskList, busyChat, tabs, pushAcp, pushState, subscriptions, follows, refreshState, appendBuffer, findSkin, cachedAsset, cacheAsset, appAssets, getState, windowList, revision, skinRevision, codeId } = context;
  const routes: Record<string, (input: Awaited<ReturnType<typeof body>>, res: ServerResponse, u: URL) => unknown> = {
    ...createChatRoutes(context),
    'GET /api/stream': async (input, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
      res.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    },
    'GET /api/state': async (input, res) => {
      return json(res, snapshot());
    },
    'POST /api/layout': async (input, res) => {
      const { changes } = input;
      layout.update(changes);
      return json(res, { ok: true });
    },
    'POST /api/icon': async (input, res) => {
      const { id } = input;
      if (typeof id !== 'string') return json(res, { error: 'Expected an id' }, 400);
      const icon = readState(ROOT).icons.find((item) => item.id === id);
      if (!icon || icon.kind !== 'exec') return json(res, { error: 'Unknown app launcher' }, 404);
      await launch(icon.cmd, ROOT);
      record({ type: 'icon', label: `Launched ${icon.label || icon.id}` });
      return json(res, { ok: true });
    },
    // A window may own commands that have no icon on the desk: `commands` in its
    // window.json names each one. Like an icon launch, the browser sends ids only
    // (the window and the command's name) and the command itself comes from disk.
    // One window's commands run one at a time, in order, and a request for one
    // already waiting shares that run; the answer comes once the command exits.
    'POST /api/window/command': async (input, res) => {
      const { id, command, ...rest } = input;
      if (typeof id !== 'string' || typeof command !== 'string' || Object.keys(rest).length) {
        return json(res, { error: 'Expected only a window id and a command name' }, 400);
      }
      const panel = readState(ROOT).panels.find((item) => item.id === id);
      if (!panel) return json(res, { error: 'Unknown window' }, 404);
      const commands = windowList().find((w) => w.kind === panel.kind)?.commands as Record<string, unknown> | undefined;
      const cmd = commands && typeof commands === 'object' && Object.hasOwn(commands, command) ? commands[command] : null;
      if (!validCommand(cmd)) return json(res, { error: `This window has no command "${command}"` }, 404);
      try {
        await windowCommand(ROOT, id, command, cmd as string[]);
        return json(res, { ok: true });
      } catch (error) {
        return json(res, { error: `${command}: ${errorInfo(error).message}` }, 500);
      }
    },
    // Any command at all, from a window: windows are trusted local code. `cwd` is
    // relative to the project, or absolute. Answers with the exit code and output.
    'POST /api/exec': async (input, res) => {
      const { cmd, cwd, timeout } = input;
      if (!validCommand(cmd)) return json(res, { error: 'Expected cmd as a list of strings' }, 400);
      const dir = path.resolve(ROOT, typeof cwd === 'string' ? cwd : '.');
      const limit = Number.isFinite(timeout) ? Math.min(Math.max(Number(timeout), 1000), 10 * 60 * 1000) : 25000;
      try { return json(res, await runCommand(cmd, dir, limit)); }
      catch (error) { return json(res, { error: errorInfo(error).message }, 500); }
    },
    'POST /api/panel/delete': async (input, res) => {
      const { id } = input;
      if (typeof id !== 'string') return json(res, { error: 'Expected an id' }, 400);
      let removed: Panel | undefined;
      mutate((state) => {
        removed = state.panels.find((panel) => panel.id === id);
        if (!removed) throw Object.assign(new Error('Unknown window'), { status: 404 });
        state.panels = state.panels.filter((panel) => panel !== removed);
        for (const icon of state.icons || []) {
          if (icon.kind === 'window' && icon.panel === id) icon.restore = removed;
        }
        return state;
      }, ROOT);
      layout.remove(id);
      record({ type: 'deleted', label: `you deleted ${removed!.title || removed!.id}` });
      return json(res, { ok: true });
    },
    // Sharing: a window or skin leaves as a ZIP of its code and assets, never the
    // project's content. One that arrives is only staged here; the chat agent
    // looks it over, asks the user, and installs it with `fireside import`.
    'GET /api/component/export': async (input, res, query) => {
      const type = query.searchParams.get('type'), id = query.searchParams.get('id') || '';
      if (type !== 'window' && type !== 'skin') return json(res, { error: 'Expected type window or skin' }, 400);
      const zip = packComponent(type, id, ROOT);
      res.writeHead(200, {
        'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="fireside-${type}-${id}.zip"`,
      }).end(Buffer.from(zip));
    },
    'POST /api/component/stage': async (input, res) => {
      return json(res, stageComponent(input.data as Uint8Array, ROOT));
    },
    'POST /api/panel/add': async (input, res) => {
      if (typeof input.kind !== 'string' || Object.keys(input).length !== 1) return json(res, { error: 'Expected only a kind' }, 400);
      const manifest = windowList().find((w) => w.kind === input.kind);
      // Only catalogue kinds: the rest are frames the agent fills, and would open empty.
      if (!manifest?.catalogue) return json(res, { error: `"${input.kind}" is not a window you can add yourself` }, 404);
      const taken = new Set(readState(ROOT).panels.map((panel) => panel.id));
      let id = manifest.kind;
      for (let n = 2; taken.has(id); n++) id = `${manifest.kind}-${n}`;
      const title = manifest.title || manifest.kind;
      mutate((state) => upsertPanel(state, { id, kind: manifest.kind, title }), ROOT);
      record({ type: 'panel', label: `you added ${title}` });
      return json(res, { id });
    },
    'POST /api/icon/restore': async (input, res) => {
      const { id } = input;
      if (typeof id !== 'string') return json(res, { error: 'Expected an id' }, 400);
      mutate((state) => {
        const icon = (state.icons || []).find((i) => i.id === id);
        if (!icon || icon.kind !== 'window') throw Object.assign(new Error('Unknown icon'), { status: 404 });
        if (!state.panels.some((panel) => panel.id === icon.panel)) {
          if (!icon.restore) throw Object.assign(new Error('That window is gone'), { status: 404 });
          state.panels.push({ ...icon.restore, id: icon.panel! });
        }
        delete icon.restore;
        return state;
      }, ROOT);
      record({ type: 'icon', label: `you brought back ${id}` });
      return json(res, { ok: true });
    },
    'GET /api/desks': async (input, res) => {
      return json(res, { desks: deskList(), home: homedir() });
    },
    'POST /api/desks/stop': async (input, res) => {
      const { dir } = input;
      if (typeof dir !== 'string' || !dir) return json(res, { error: 'Which desk?' }, 400);
      // A desk closing itself would take this page down with it, so it must be
      // stopped from its own window — or from the CLI.
      if (path.resolve(dir) === ROOT) return json(res, { error: 'This is the desk you are on' }, 409);
      if (!listDesks().some(desk => desk.running && desk.dir === path.resolve(dir))) return json(res, { error: 'That desk is not running' }, 404);
      try { await stopDesk(dir); } catch (error) { return json(res, { error: errorInfo(error).message }, 409); }
      return json(res, { ok: true, desks: deskList(), home: homedir() });
    },
    // Only a desk already on the list can be started from here, so a page can
    // never have a server started in a folder of its choosing.
    'POST /api/desks/start': async (input, res) => {
      const { dir } = input;
      if (typeof dir !== 'string' || !dir) return json(res, { error: 'Which desk?' }, 400);
      try {
        const info = await startDesk(dir);
        return json(res, { ok: true, url: info.url });
      } catch (error) { return json(res, { error: errorInfo(error).message }, 409); }
    },
    'POST /api/desks/forget': async (input, res) => {
      const { dir } = input;
      if (typeof dir !== 'string' || !dir) return json(res, { error: 'Which desk?' }, 400);
      forgetDesk(dir);
      return json(res, { ok: true, desks: deskList(), home: homedir() });
    },
    'GET /api/updates': async (input, res, query) => {
      if (query.searchParams.get('refresh') === '1') { try { await updates.check({ force: true }); } catch {} }
      return json(res, { updates: updates.view(), installing: updates.installing() });
    },
    'POST /api/updates/apply': async (input, res) => {
      const { names } = input;
      if (!Array.isArray(names) || !names.length || !names.every((n) => typeof n === 'string')) return json(res, { error: 'Which package?' }, 400);
      // Replacing the agent under a live reply would lose it. Queued work is the
      // user's to finish, so say so rather than deciding for them.
      if (busyChat()) return json(res, { error: 'A chat is still working. Let it finish, then update.' }, 409);
      const queued = tabs.tabs.find((tab) => tab.acp.pending.length);
      if (queued) return json(res, { error: 'A chat has queued messages. Send or remove them, then update.' }, 409);
      if (updates.installing()) return json(res, { error: 'Another desk is already updating.' }, 409);

      const lines: string[] = [];
      try {
        const done = await updates.apply(names, { log: (line) => { lines.push(line); if (lines.length > 200) lines.shift(); } });
        // The desks keep running: only the agent child is respawned, and only for
        // chats that had one running. A sleeping chat starts the new one when it wakes.
        const reconnected = [];
        for (const tab of tabs.tabs) {
          const previous = tab.acp.preferred;
          if (!previous?.agent || tab.acp.status === 'asleep') continue;
          try { await tab.acp.connect(previous.agent, tab.acp.saved(previous.agent), { restoring: true }); reconnected.push(tab.id); }
          catch (error) { lines.push(`Reconnect failed for ${tab.id}: ${errorInfo(error).message}`); }
        }
        pushAcp(); pushState();
        return json(res, { ok: true, updated: done, reconnected, log: lines });
      } catch (error) {
        pushState();
        return json(res, { error: errorInfo(error).message, log: lines }, errorInfo(error).status || 500);
      }
    },
    'POST /api/subscriptions/refresh': async (input, res) => {
      subscriptions.refresh({ manual: true });
      return json(res, { ok: true });
    },
    'POST /api/subscriptions/wake': async (input, res) => {
      // A wake outlasts the browser's patience, so answer as soon as it starts;
      // refusals still throw here, and the result reaches the page over SSE.
      subscriptions.wake().catch(() => {});
      return json(res, { ok: true }, 202);
    },
    'POST /api/panel/data': async (input, res) => {
      const { id, data, ...rest } = input;
      if (typeof id !== 'string' || !data || typeof data !== 'object' || Array.isArray(data) || Object.keys(rest).length) {
        return json(res, { error: 'Expected only an id and a data object' }, 400);
      }
      savePanelData(id, data, ROOT);
      refreshState(); pushState();
      return json(res, { ok: true });
    },
    'POST /api/push': async (input, res) => {
      const { id, lines } = input;
      // A stream panel created a moment ago may not have reached the watcher yet.
      const isStream = (state: DeskState) => state.panels.some((panel) => panel.id === id && follows(panel, 'lines'));
      if (!isStream(getState()) && !isStream(refreshState())) return json(res, { error: 'Unknown stream panel' }, 400);
      appendBuffer(id, (Array.isArray(lines) ? lines : [lines]).map(String));
      return json(res, { ok: true });
    },
    'POST /api/skin/fetch': async (input, res) => {
      const { id } = input;
      const skin = findSkin(id);
      if (!skin) return json(res, { ok: false, error: 'unknown skin' }, 404);
      const out: Record<string, string | null> = {};
      await Promise.all((skin.assets || []).filter((asset) => asset.url && !bundledURL(skin, asset)).map(async (asset) => {
        try { out[asset.id] = await cacheAsset(skin.id, asset); }
        catch (error) { console.error(`Skin ${skin.id}: ${errorInfo(error).message}`); out[asset.id] = null; }
      }));
      return json(res, { ok: true, assets: out });
    },
    'POST /api/frame-check': async (input, res) => {
      const { url: target } = input;
      let u;
      try { u = new URL(target); } catch { return json(res, { ok: false, error: 'bad url' }, 400); }
      if (!/^https?:$/.test(u.protocol)) return json(res, { ok: false, error: 'only http(s)' }, 400);
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 Fireside' } });
        r.body?.cancel().catch(() => {});
        const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
        const ancestors = /frame-ancestors([^;]*)/i.exec(r.headers.get('content-security-policy') || '')?.[1].trim().toLowerCase();
        let reason = null;
        if (xfo.includes('deny') || xfo.includes('sameorigin')) reason = `X-Frame-Options: ${xfo}`;
        else if (ancestors != null && !ancestors.split(/\s+/).includes('*')) reason = `frame-ancestors ${ancestors || "'none'"}`;
        return json(res, { ok: true, framable: !reason, reason, finalUrl: r.url, status: r.status });
      } catch (error) {
        return json(res, { ok: true, framable: null, reason: errorInfo(error).message });
      }
    },
    'GET /api/skins': async (input, res) => {
      const skins = listSkins(ROOT).map((skin) => {
        const { folder: _folder, ...view } = skin;
        return { ...view, cached: Object.fromEntries((skin.assets || []).map((a) => [a.id, bundledURL(skin, a, skinRevision()) || cachedAsset(skin.id, a)])) };
      });
      return json(res, { skins });
    },
    'POST /api/skin': async (input, res) => {
      const { id } = input;
      if (!findSkin(id)) return json(res, { error: 'unknown skin' }, 400);
      mutate((state) => { state.theme = { ...state.theme, skin: id }; }, ROOT);
      return json(res, { ok: true });
    },
    'POST /api/toured': async (input, res) => {
      markToured();
      return json(res, { ok: true });
    },
    'GET /api/first-run': async (_req, res) => json(res, firstRun(ROOT)),
    'GET /api/ping': async (_req, res) => json(res, { ok: true, root: ROOT, pid: process.pid, code: codeId, busy: !!busyChat() }),
    'GET /api/windows': async (_req, res) => json(res, { windows: windowList(), revision: revision() }),
  };
  return async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    guard(req, url(), TOKEN);
    const u = new URL(req.url || '/', url());
    const p = u.pathname;
    const route = p.startsWith('/api/agent/') ? '/api/agent/*' : p;
    const handle = routes[`${req.method} ${route}`];
    const upload = route === '/api/component/stage';
    if (handle) return handle(req.method !== 'POST' ? {} : upload ? { data: await rawBody(req, 64 * 1024 * 1024) } : await body(req), res, u);
    if (p.startsWith('/api/')) return json(res, { error: 'Unknown route or method' }, Object.keys(routes).some(key => key.endsWith(' ' + route)) ? 405 : 404);
    // Project files, for galleries and previews. Confined to the project dir
    // plus .fireside, so a stray path can't read the rest of the disk.
    if (p.startsWith('/files/')) {
      const rel = decodeURIComponent(p.slice('/files/'.length));
      // An absolute path is taken as one when it lies in the project, and otherwise as
      // a path from the project's top, which is what a leading slash used to mean.
      const fromTop = path.relative(ROOT, rel);
      const inside = !fromTop.startsWith('..') && !path.isAbsolute(fromTop);
      const local = !path.isAbsolute(rel) ? rel : inside ? fromTop : rel.replace(/^[\\/]+/, '');
      const abs = projectFile(ROOT, local);
      // Judged on the real path, so neither `a/../.fireside` nor `.FIRESIDE` gets past.
      const own = fs.existsSync(firesideDir(ROOT)) ? fs.realpathSync.native(firesideDir(ROOT)) + path.sep : null;
      if (own && abs.startsWith(own) && !SHARED.some((shared) => abs.startsWith(path.join(own, shared) + path.sep))) return json(res, { error: 'Private Fireside file' }, 403);
      return serveFile(res, abs, { download: u.searchParams.has('download'), range: req.headers.range });
    }

    // Windows: the list the page loads first, then each window's files from the
    // layer its kind comes from. A skin folder serves the images it bundles.
    const [top, name, ...rest] = decodeURIComponent(p).split('/').slice(1);
    if (top === 'windows' || top === 'skins') {
      const folder = top === 'windows' ? windowFolder(name, ROOT) : findSkin(name)?.folder;
      if (!folder) return json(res, { error: `Unknown ${top === 'windows' ? 'window' : 'skin'}` }, 404);
      if (/^~[a-z0-9]+$/.test(rest[0] || '')) rest.shift();
      return serveFile(res, projectFile(folder, rest.join('/')), { app: top === 'windows' });
    }

    await appAssets.handle(req, res, p);
  };
}
