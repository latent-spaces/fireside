import { installComponent, exportComponent, importComponent } from './components.ts';
// The fireside CLI. Everything Claude does to the UI goes through here.
// State mutations write .fireside/state.json directly (the server watches it),
// so they work whether or not the server is up. Only ephemeral things — log
// lines, log streams — need a live server.

import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { projectDir, ensureDirs, readServer, serverPath, panelsDir, firesideDir, SHARED } from './paths.ts';
import { readState, mutate, upsertPanel, savePanelData } from './state.mjs';
import { listWindows, listSkins, KIND } from './catalog.ts';
import { stop as stopDesk } from './desks.mjs';
import { appIcon, commandArgs } from './launchers.mjs';
import { serverCodeId } from './version.ts';
import { launch } from './launch.mjs';
import { shoot } from './shot.mjs';

const ROOT = projectDir();
const argv = process.argv.slice(2);
const cmd = argv.shift();

// --- tiny arg parser: --flag value, --flag=value, --bool, positionals -------
function parse(args) {
  const flags = {}, rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let val = eq === -1 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true) : a.slice(eq + 1);
      if (flags[key] === undefined) flags[key] = val;
      else flags[key] = [].concat(flags[key], val);
    } else rest.push(a);
  }
  return { flags, rest };
}

/** A value that may be inline, `@file`, or `-` for stdin. */
function resolveValue(v) {
  if (typeof v !== 'string') return v;
  if (v === '-') return fs.readFileSync(0, 'utf8');
  if (v.startsWith('@')) return fs.readFileSync(path.resolve(ROOT, v.slice(1)), 'utf8');
  return v;
}
const asJSON = (v) => { try { return JSON.parse(resolveValue(v)); } catch (error) { die(`Invalid JSON: ${error.message}`); } };

/** A picture or video a window will show, as a path the desk can serve. The desk
 *  serves only the project, so a file from elsewhere (a screenshot in /tmp, a
 *  download) is copied into .fireside/media; one inside it given whole is made
 *  relative. A file that isn't there, or that sits in a private part of .fireside,
 *  is reported now rather than left to break. */
function mediaPath(src) {
  if (typeof src !== 'string' || /^(https?:|data:|blob:)/.test(src)) return src;
  const [, file, tail] = /^([^?#]*)(.*)$/s.exec(src);
  const full = path.resolve(ROOT, file.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    console.error(`fireside: ${src} not found${path.isAbsolute(file) ? '' : ' (paths are read from the project folder)'}`);
    return src;
  }
  const fromTop = path.relative(ROOT, full);
  if (!fromTop.startsWith('..') && !path.isAbsolute(fromTop)) {
    const own = path.relative(firesideDir(ROOT), full);
    if (!own.startsWith('..') && !SHARED.some((shared) => own.startsWith(path.join(shared) + path.sep))) console.error(`fireside: ${fromTop} is in a private folder and won't show. Windows can show ${SHARED.map((shared) => `.fireside/${shared}`).join(', ')} and the rest of the project.`);
    return fromTop.split(path.sep).join('/') + tail;
  }
  const dir = path.join(firesideDir(ROOT), 'media');
  fs.mkdirSync(dir, { recursive: true });
  const bytes = fs.readFileSync(full);
  const name = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 8) + '-' + path.basename(full);
  if (!fs.existsSync(path.join(dir, name))) fs.writeFileSync(path.join(dir, name), bytes);
  return `.fireside/media/${name}${tail}`;
}

/** "Label|hint|prompt" — hint optional: "Label||prompt" or "Label|prompt". The
 *  prompt keeps its trailing space: a suggestion that trails off is finished by
 *  the user in the composer. */
const asSuggestions = (v) => [].concat(v).map((s) => {
  const parts = String(s).split('|');
  const prompt = (parts.length >= 3 ? parts.slice(2).join('|') : parts[1] || '').replace(/^\s+/, '');
  return parts.length >= 3
    ? { label: parts[0].trim(), hint: parts[1].trim(), prompt }
    : { label: parts[0].trim(), prompt };
});
const die = (m) => { console.error(m); process.exit(1); };
const num = (v) => (v == null || v === true ? undefined : Number(v));

/** POST to the running server: null on success, otherwise what went wrong. */
async function post(route, payload) {
  const s = readServer(ROOT);
  if (!s) return 'server not running';
  try {
    const response = await fetch(s.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    if (response.ok) return null;
    return (await response.json().catch(() => ({}))).error || `HTTP ${response.status}`;
  } catch (error) { return error.message; }
}

async function ping(s) {
  try { return await fetch(`${s.url}/api/ping`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()); } catch { return null; }
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.error(`Open ${url} in your browser (${error.message})`));
  child.unref();
}

// ---------------------------------------------------------------------------

const COMMANDS = {
  export(flags, rest) {
    const [type, id] = rest;
    if (!['window', 'skin'].includes(type) || !id) die('fireside export window|skin <id> [--out component.zip]');
    console.log(exportComponent(type, id, path.resolve(flags.out || `${id}.zip`), ROOT));
  },
  import(flags, rest) {
    if (!rest[0]) die('fireside import <component.zip> [--as <name>] [--project] [--replace]');
    const result = importComponent(path.resolve(rest[0]), ROOT, { project: flags.project === true, replace: flags.replace === true, as: typeof flags.as === 'string' ? flags.as : '' });
    console.log(`Imported ${result.type} ${result.id} into ${result.folder}`);
  },
  async start(flags) {
    let s = readServer(ROOT);
    if (s) {
      const info = await ping(s);
      if (!info || info.root !== ROOT) {
        // A server.json left behind by a server that is gone (or isn't ours).
        try { fs.unlinkSync(serverPath(ROOT)); } catch {}
        s = null;
      } else if (info.code !== serverCodeId()) {
        if (process.env.FIRESIDE_CONNECTION === 'acp') die('The Fireside server is running older code. It restarts by itself once no chat is replying, so finish this turn.');
        // Running code from before the last change to src/. Reusing it keeps
        // whatever it used to do — including not knowing how to hand over a desk.
        await stopDesk(ROOT);
        console.error('fireside: the server was running older code, so it was restarted.');
        s = null;
      }
    }
    if (!s) {
      try { s = await launch(ROOT, { port: flags.port }); }
      catch (error) { die(`fireside: server failed to start — ${error.message}`); }
    }
    if (flags.open !== false && flags.open !== 'false') openBrowser(s.url);
    console.log(s.url);
  },

  async stop() {
    const s = readServer(ROOT);
    if (!s) { console.log('not running'); return; }
    // The chat runs under this server, so stopping it would end the chat mid-turn.
    if (Number(process.env.FIRESIDE_SERVER_PID) === s.pid) die(`fireside: not stopping ${s.url}: this chat runs in that desk. Stop it from a terminal instead. To use a throwaway desk, run every command with FIRESIDE_PROJECT=<its folder>.`);
    await stopDesk(ROOT);
    console.log('stopped');
  },

  status() {
    const s = readServer(ROOT);
    const st = readState(ROOT);
    console.log(JSON.stringify({
      running: !!s, url: s?.url || null, project: ROOT,
      panels: st.panels.map((p) => ({ id: p.id, kind: p.kind, title: p.title, span: p.span })),
    }, null, 2));
  },

  url() { const s = readServer(ROOT); console.log(s ? s.url : ''); },
  open() { const s = readServer(ROOT); if (s) openBrowser(s.url); else die('fireside: not running'); },
  state() { console.log(JSON.stringify(readState(ROOT), null, 2)); },

  /** Windows worth offering this user, beside the built-in kinds in the ＋ catalogue.
   *  In "Label|hint|prompt" shape; each one drafts a prompt, never a panel. */
  catalogue(flags) {
    mutate((st) => {
      if (flags.clear) st.suggestions = [];
      if (flags.json) st.suggestions = asJSON(flags.json);
      if (flags.suggest) st.suggestions = asSuggestions(flags.suggest);
      return st;
    }, ROOT);
  },

  panel(flags, rest) {
    const id = rest[0] || flags.id;
    if (!id) die('fireside panel <id> --kind <kind> [...]');
    const p = { id };
    for (const key of ['kind', 'title', 'tag', 'note', 'url', 'src', 'source', 'file']) {
      if (flags[key] !== undefined) p[key] = flags[key];
    }
    for (const key of ['span', 'order', 'height', 'value', 'max']) {
      if (flags[key] !== undefined) p[key] = num(flags[key]);
    }
    for (const key of ['body', 'html']) {
      if (flags[key] !== undefined) p[key] = resolveValue(flags[key]);
    }
    for (const key of ['items', 'steps']) {
      if (flags[key] !== undefined) p[key] = asJSON(flags[key]);
    }
    if (flags.collapsed !== undefined) p.collapsed = flags.collapsed !== 'false';
    if (flags.json) Object.assign(p, asJSON(flags.json));
    if (p.src) p.src = mediaPath(p.src);
    if (Array.isArray(p.items)) p.items = p.items.map((it) => it && typeof it === 'object' && 'src' in it ? { ...it, src: mediaPath(it.src), ...(it.poster ? { poster: mediaPath(it.poster) } : {}) } : it);

    const existing = readState(ROOT).panels.find((x) => x.id === id);
    if (!existing && !p.kind) p.kind = 'markdown';
    mutate((st) => upsertPanel(st, p), ROOT);
  },

  /** Switch skin, or list what is available. */
  async skin(flags, rest) {
    if (rest[0] === 'install') {
      const src = rest[1] && path.resolve(rest[1]);
      const file = src && (src.endsWith('.json') ? src : path.join(src, 'skin.json'));
      if (!file || !fs.existsSync(file)) die('fireside skin install <folder with skin.json | skin .json file> [--project]');
      const id = asJSON(`@${file}`).id || path.basename(src, '.json');
      installComponent(src, 'skins', ROOT, flags);
      console.log(`installed skin "${id}". Apply it with: fireside skin ${id}`);
      return;
    }
    const skins = listSkins(ROOT);
    const id = rest[0];
    if (!id || flags.list) {
      const active = readState(ROOT).theme?.skin || 'fireside';
      for (const sk of skins) console.log(`${sk.id === active ? '*' : ' '} ${sk.id.padEnd(12)} ${sk.name}${sk.note ? ' — ' + sk.note : ''}`);
      return;
    }
    if (!skins.some((sk) => sk.id === id)) {
      die(`fireside: no skin "${id}". Try: ${skins.map((sk) => sk.id).join(', ')}`);
    }
    mutate((st) => { st.theme = { ...st.theme, skin: id }; return st; }, ROOT);
  },

  /** Desktop icons: things that live on the wallpaper, behind the windows. */
  icon(flags, rest) {
    const id = rest[0] || flags.id;
    if (!id) die('fireside icon <id> --label T [--prompt text|--url URL|--window id]');
    if (flags.rm) {
      mutate((st) => { st.icons = (st.icons || []).filter((i) => i.id !== id); return st; }, ROOT);
      return;
    }
    const icon = { id };
    if (flags.label) icon.label = flags.label;
    if (flags.glyph) icon.glyph = flags.glyph;
    if (flags.color) icon.color = flags.color;
    if (typeof flags.image === 'string') icon.image = flags.image;
    if (flags.app) {
      if (process.platform !== 'darwin' || typeof flags.app !== 'string') die('--app requires a macOS app path');
      icon.kind = 'exec';
      icon.cmd = ['open', '-a', flags.app];
      icon.label ||= path.basename(flags.app, '.app');
      try { icon.image = appIcon(ROOT, flags.app, id); }
      catch (error) { console.error(`fireside: could not extract app icon: ${error.message}`); }
    }
    if (flags.exec) { icon.kind = 'exec'; icon.cmd = commandArgs(String(flags.exec)); }
    if (flags.cmd) { icon.kind = 'exec'; icon.cmd = asJSON(flags.cmd); }
    if (flags.prompt) { icon.kind = 'prompt'; icon.prompt = resolveValue(flags.prompt); }
    if (flags.url) { icon.kind = 'url'; icon.url = flags.url; }
    if (flags.window) { icon.kind = 'window'; icon.panel = flags.window; }
    if (flags.json) Object.assign(icon, asJSON(flags.json));

    mutate((st) => {
      st.icons = st.icons || [];
      const i = st.icons.findIndex((x) => x.id === id);
      if (i === -1) st.icons.push({ kind: 'prompt', ...icon });
      else st.icons[i] = { ...st.icons[i], ...icon };
      return st;
    }, ROOT);
  },

  /** Window kinds the desk can show, and where each one comes from. */
  windows() {
    for (const w of listWindows(ROOT)) console.log(`${w.icon || '🪟'} ${w.kind.padEnd(12)} ${w.from.padEnd(10)} ${(w.catalogue ? 'catalogue' : '').padEnd(10)} ${(w.feeds || []).join(', ')}`);
  },

  window(flags, rest) {
    const src = rest[0] === 'install' && rest[1] && path.resolve(rest[1]);
    if (!src || !fs.existsSync(path.join(src, 'window.json')) || !fs.existsSync(path.join(src, 'window.js'))) {
      die('fireside window install <folder with window.json and window.js> [--project]');
    }
    const kind = path.basename(src);
    if (!KIND.test(kind)) die(`fireside: a window folder is named after its kind (lowercase letters, digits, dashes), not "${kind}"`);
    installComponent(src, 'windows', ROOT, flags);
    console.log(`installed window "${kind}". Reload the desk, then: fireside panel <id> --kind ${kind}`);
  },

  rm(flags, rest) {
    const ids = new Set(rest);
    mutate((st) => {
      st.panels = st.panels.filter((p) => !ids.has(p.id));
      return st;
    }, ROOT);
  },

  clear() {
    // The chat and activity windows are session furniture, not work product.
    mutate((st) => { st.panels = st.panels.filter((p) => p.kind === 'activity' || p.kind === 'chat'); return st; }, ROOT);
  },

  /** CSS variables over whichever skin is on: --accent, any set with --vars, or --reset. */
  theme(flags) {
    if (flags.mode) die('Use fireside skin to choose light or dark appearance');
    mutate((st) => {
      const vars = flags.reset ? {} : { ...st.theme.vars };
      if (flags.accent) vars['--accent'] = flags.accent;
      if (flags.vars) Object.assign(vars, asJSON(flags.vars));
      st.theme = { ...st.theme, vars };
      if (flags.title) st.title = flags.title;
      return st;
    }, ROOT);
  },

  say(flags, rest) {
    const text = rest.join(' ') || flags.text;
    mutate((st) => { st.status = { text, tone: flags.tone || 'idle' }; return st; }, ROOT);
  },

  async push(flags, rest) {
    const id = rest.shift();
    if (!id) die('fireside push <panel-id> [line...]   (or pipe stdin)');
    let lines = rest;
    if (!lines.length) lines = fs.readFileSync(0, 'utf8').split('\n').filter((l) => l.length);
    const failed = await post('/api/push', { id, lines });
    if (failed) die(`fireside: ${failed}`);
  },

  /** Write a panel's data file in .fireside/data (its own name, else <id>.json) and point the panel at it. */
  data(flags, rest) {
    const [id, source] = rest;
    if (!id || !source) die('fireside data <panel-id> @file.json | -');
    const name = savePanelData(id, asJSON(source), ROOT);
    console.log(path.join('.fireside/data', name));
  },

  write(flags, rest) {
    // fireside write <name.html> --html @file  -> .fireside/panels/<name.html>
    const name = rest[0];
    if (!name) die('fireside write <name.html> --html @src');
    ensureDirs(ROOT);
    if (path.basename(name) !== name) die('Panel files need a filename, without directories');
    fs.writeFileSync(path.join(panelsDir(ROOT), name), resolveValue(flags.html ?? '-'));
    console.log(path.join('.fireside/panels', name));
  },

  async shot(flags, rest) {
    // fireside shot <id> [--out file.png]  -> a picture of that window, to look at
    const id = rest[0];
    if (!id) die('fireside shot <panel-id> [--out file.png]');
    const s = readServer(ROOT);
    if (!s) die('fireside: not running');
    if (!readState(ROOT).panels.some((p) => p.id === id)) die(`fireside: no window "${id}" on the desk`);
    const out = path.resolve(ROOT, flags.out || path.join('.fireside', 'shots', `${id}.png`));
    const result = await shoot({ url: s.url, id, out });
    console.log(`${result.out} (${result.size})`);
    for (const problem of result.problems) console.log(`  ${problem}`);
  },

  help() { console.log(HELP); },
};

const HELP = `fireside — a desktop for your coding agents

  [start] [--port N] [--open false] start the server and open the page (bare \`fireside\` does this)
  stop | status | url | open | state


  panel <id> --kind K --title T [--span 1-12] [--order N] [--tag T] [--note T]
        markdown  --body "text" | @file | -   or --source README.md (follows the file)
        html      --html "<div>" | @file | -   or --file name.html
        gallery   --items '[{"src":"out/a.png","caption":"..."}]'
        video     --src out/demo.mp4 | --items '[{"src":"out/a.mp4","caption":"..."}]'
        files     --items '[{"path":"src/x.ts","note":"..."}]'
        stream    --source path/to.log  [--height 300]
        git       [--source sub/repo]   (default: the project folder)
        activity  [--height 300]
        iframe    --url http://localhost:3000 [--height 500]
        progress  --steps '[{"label":"...","state":"done|active|todo"}]'
        stat      --items '[{"label":"Tests","value":"42","delta":"+3"}]'
        actions   --items '[{"label":"...","hint":"...","prompt":"...","tone":"primary","window":"tokens"}]'
        chat      (no options - the desk's chats, one per tab)
        tokens    (no options - last observed context size and model)

  icon <id> --label T [--glyph G] [--color C] [--image path] [--app /Applications/App.app]
            --exec "code ." | --cmd '["code","."]'
            --prompt text | --url URL | --window panel-id
            --rm                 remove an icon
  skin [<id>] [--list]           switch skin, or list available skins
  export window|skin <id> [--out component.zip]   share reusable code and assets
  import <component.zip> [--as <name>] [--project] [--replace]  install a shared component (a taken name needs --as)
  skin install <path>            add a skin (file or folder) to ~/.fireside; --project for this project
  windows | window install <dir> list window kinds, or add one to ~/.fireside (--project)
  catalogue --suggest "Label|hint|prompt"   windows to offer in the desk's ＋ catalogue (--clear)
  rm <id...> | clear
  theme --accent C | --vars JSON | --reset   CSS variables over any skin; --title T
  say "building the parser" --tone busy|idle|attention
  push <panel-id> "log line"        append to a stream panel (or pipe stdin)
  data <panel-id> @file.json | -    write the panel's data to .fireside/data; its window redraws
  write <name.html> --html @src     save an HTML panel file
  shot <panel-id> [--out file.png]  picture one window in a headless browser, to check it looks right`;

const { flags, rest } = parse(argv);
const fn = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : null;
if (cmd === '--help' || cmd === '-h') { console.log(HELP); process.exit(0); }
// Bare `fireside` opens the desk; an agent inside Fireside gets the help instead.
if (!cmd) { if (process.env.FIRESIDE_CONNECTION === 'acp') { console.log(HELP); process.exit(0); } await COMMANDS.start({}); process.exit(0); }
if (!fn) die(`fireside: unknown command "${cmd}"\n\n${HELP}`);

try { await fn(flags, rest); } catch (error) { die(`fireside: ${error.message}`); }
