// `fireside shot <id>`: a picture of one window, taken in a headless browser of
// its own, so an agent can look at what it put on the desk before saying so.
// It opens a fresh page (not the user's tabs), so window positions are the
// default layout; what it checks is that the window loads and draws.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const CANDIDATES = {
  darwin: ['Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser']
    .map((app) => `/Applications/${app}.app/Contents/MacOS/${app}`),
  win32: ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']
    .flatMap((exe) => [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map((dir) => path.join(dir, exe))),
};
const ON_PATH = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

/** A Chromium-family browser to drive, or null. FIRESIDE_BROWSER overrides. */
export function findBrowser() {
  const chosen = process.env.FIRESIDE_BROWSER;
  if (chosen) return chosen;
  const found = (CANDIDATES[process.platform] || []).find((p) => fs.existsSync(p));
  if (found) return found;
  for (const name of ON_PATH) {
    const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
    if (where.status === 0) return where.stdout.split(/\r?\n/)[0].trim();
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEV_SOCKET = /vite|WebSocket closed without opened/i;

/** Screenshot window `id` of the desk at `url` into `out`. Returns what the
 *  page reported on the way: script errors and requests that failed. */
export async function shoot({ url, id, out, width = 1600, height = 1000, settle = 1500 }) {
  const browser = findBrowser();
  if (!browser) throw new Error('no Chrome, Chromium, or Edge found; set FIRESIDE_BROWSER to one');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fireside-shot-'));
  const child = spawn(browser, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) await sleep(100);
    if (!fs.existsSync(portFile)) throw new Error(`the browser did not start (${browser})`);
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const page = (await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json())).find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not reach the browser')); });

    // Every problem is tagged with the frame it happened in, so it can be traced
    // to the window that frame sits in. Framed windows may run in a process of
    // their own; auto-attach brings those in as sessions.
    let seq = 0;
    const pending = new Map(), problems = [], contexts = new Map(), requests = new Map(), sessions = [undefined];
    const send = (method, params = {}, sessionId) => new Promise((resolve) => {
      const i = ++seq; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    });
    const watch = (sessionId) => Promise.all([send('Runtime.enable', {}, sessionId), send('Network.enable', {}, sessionId),
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)]);
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
      const p = m.params, key = (ctx) => `${m.sessionId || ''}:${ctx}`;
      const add = (frameId, text) => problems.push({ frameId, text });
      if (m.method === 'Target.attachedToTarget') sessions.push(p.sessionId), watch(p.sessionId).then(() => send('Runtime.runIfWaitingForDebugger', {}, p.sessionId));
      if (m.method === 'Runtime.executionContextCreated') contexts.set(key(p.context.id), p.context.auxData?.frameId);
      if (m.method === 'Runtime.exceptionThrown') add(contexts.get(key(p.exceptionDetails.executionContextId)),
        `error: ${p.exceptionDetails.exception?.description?.split('\n')[0] || p.exceptionDetails.text}`);
      if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') add(contexts.get(key(p.executionContextId)),
        `console: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
      if (m.method === 'Network.requestWillBeSent') requests.set(p.requestId, { url: p.request.url, frameId: p.frameId });
      if (m.method === 'Network.responseReceived' && p.response.status >= 400) add(p.frameId, `HTTP ${p.response.status}: ${p.response.url}`);
      if (m.method === 'Network.loadingFailed' && !p.canceled) {
        const r = requests.get(p.requestId) || {};
        add(r.frameId, `failed: ${r.url || p.requestId} (${p.errorText})`);
      }
    };
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
    /** The window a frame sits in: its own id, "desk" for the page itself. */
    const windowOf = async (frameId) => {
      const owner = (await send('DOM.getFrameOwner', { frameId })).result;
      if (!owner) return 'desk';
      const node = (await send('DOM.resolveNode', { backendNodeId: owner.backendNodeId })).result?.object;
      if (!node) return 'desk';
      const found = await send('Runtime.callFunctionOn', { objectId: node.objectId, returnByValue: true,
        functionDeclaration: 'function () { return this.closest(".win")?.dataset.id || "desk"; }' });
      return found.result?.result?.value || 'desk';
    };

    await Promise.all([send('Page.enable'), send('DOM.enable'), watch()]);
    // A fresh desk would show the fire or the tour over the picture.
    const target = new URL(url);
    target.searchParams.set('notour', '');
    await send('Page.navigate', { url: target.href });
    // Bring the window forward on its own, so nothing overlaps it in the picture.
    const isolate = `(() => {
      const win = [...document.querySelectorAll('.win')].find((w) => w.dataset.id === ${JSON.stringify(id)});
      if (!win) return null;
      for (const other of document.querySelectorAll('.win')) if (other !== win) other.style.visibility = 'hidden';
      win.style.zIndex = 99999;
      win.scrollIntoView({ block: 'start' });
      const r = win.getBoundingClientRect();
      return r.width && r.height ? { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 } : null;
    })()`;
    let clip = null;
    for (let i = 0; i < 100 && !clip; i++) { await sleep(100); clip = await evaluate(isolate); }
    if (!clip) throw new Error(`window "${id}" did not appear on the desk`);
    await sleep(settle);   // frames, images, and fonts
    clip = await evaluate(isolate);
    // A capture can fail while the page is still settling (a frame swapping in);
    // one retry covers that, and a second failure says why instead of crashing.
    let shot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    if (!shot.result?.data) {
      await sleep(500);
      shot = await send('Page.captureScreenshot', { format: 'png', clip: await evaluate(isolate) || clip, captureBeyondViewport: true });
    }
    if (!shot.result?.data) throw new Error(`could not capture window "${id}": ${shot.error?.message || 'the browser returned no image'}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    // Media that did not load, frame by frame. A framed window's requests do not
    // always surface as network events, so look at the elements themselves.
    const BROKEN = `[...document.querySelectorAll('img, video, audio')]
      .filter((m) => (m.tagName === 'IMG' ? m.complete && !m.naturalWidth && m.getAttribute('src') : m.error))
      .map((m) => 'broken ' + m.tagName.toLowerCase() + ': ' + (m.currentSrc || m.src))`;
    for (const sessionId of sessions) {
      const frames = [], walk = (node) => { frames.push(node.frame); (node.childFrames || []).forEach(walk); };
      walk((await send('Page.getFrameTree', {}, sessionId)).result?.frameTree || { frame: {} });
      for (const frame of frames.filter((f) => f.id)) {
        const world = (await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'fireside-shot' }, sessionId)).result;
        if (!world) continue;
        const found = await send('Runtime.evaluate', { expression: BROKEN, contextId: world.executionContextId, returnByValue: true }, sessionId);
        for (const text of found.result?.result?.value || []) problems.push({ frameId: frame.id, text, media: true });
      }
    }
    // Keep what happened in this window. The desk's own page hosts every
    // window, so its media and requests count only when they are in this one.
    await send('DOM.getDocument', { depth: -1, pierce: true });
    const owners = new Map();
    for (const { frameId } of problems) if (frameId && !owners.has(frameId)) owners.set(frameId, await windowOf(frameId));
    const inWindow = new Set(await evaluate(`[...document.querySelector('.win[data-id="' + CSS.escape(${JSON.stringify(id)}) + '"]')
      .querySelectorAll('[src], [href]')].map((e) => e.src || e.href)`));
    const elsewhere = new Set(await evaluate(`[...document.querySelectorAll('.win')].filter((w) => w.dataset.id !== ${JSON.stringify(id)})
      .flatMap((w) => [...w.querySelectorAll('[src], [href]')].map((e) => e.src || e.href))`));
    const urlOf = (text) => text.match(/https?:\/\/\S+/)?.[0];
    const mine = [], said = new Set();
    for (const p of problems) {
      if (p.media && said.has(urlOf(p.text))) continue;   // already reported as a failed request
      said.add(urlOf(p.text));
      const owner = owners.get(p.frameId) || 'desk';
      if (owner === id) mine.push(p.text);
      else if (owner !== 'desk') continue;
      else if (inWindow.has(urlOf(p.text))) mine.push(p.text);
      else if (DEV_SOCKET.test(p.text)) continue;   // this browser can't reach the desk's live reload
      else if (!p.media && !elsewhere.has(urlOf(p.text))) mine.push(`desk ${p.text}`);
    }
    return { out, size: `${Math.round(clip.width)}×${Math.round(clip.height)}`, problems: [...new Set(mine)] };
  } finally {
    ws?.close();
    child.kill();
    await sleep(200);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
