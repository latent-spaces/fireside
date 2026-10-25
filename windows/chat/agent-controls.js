import { appendDraft } from './drafts.js';
// A selected provider or saved session is not yet a usable conversation. A
// sleeping one is: its agent starts when the next message is sent.
export const hasAgentSession = state => state?.status === 'asleep' || !!state?.sessionId
  && ['ready', 'working', 'resetting', 'configuring'].includes(state?.status);

const mounts = new Set();
let current;
// Which agents exist is the server's to say (src/agents.mjs): the two built in,
// plus any the user added from the ACP registry or by command.
export const agentName = state => state?.agents?.find(a => a.id === state.agent)?.name || null;
const SIGN_IN = { claude: 'claude auth login', codex: 'codex login' };
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; };
const button = (text, action, cls) => { const b = node('button', text, cls); b.type = 'button'; b.onclick = action; return b; };
const option = (value, name) => { const o = node('option', name); o.value = value; return o; };
const details = (title, cls) => { const d = node('details', '', cls); d.append(node('summary', title)); return d; };
const link = (text, href) => Object.assign(node('a', text), { href, target: '_blank', rel: 'noopener' });
// A select of the agent's choices for one setting, or its default when it offers none.
const choices = (select, setting) => select.replaceChildren(...(setting?.options?.length ? setting.options.map(o => option(o.value, o.name)) : [option('', 'Agent default')]));
// Updates arrive many times a second while a reply streams, so each part is
// rebuilt only when what it shows has changed.
const changed = (el, value) => {
  const sig = JSON.stringify(value ?? null);
  if (el.dataset.signature === sig) return false;
  el.dataset.signature = sig; return true;
};

// The agent's question takes the composer's place until it is answered: one
// question at a time, picked with the keyboard or a click, the way Claude Code
// asks in a terminal.
function questionDock(q, run) {
  const root = node('section', '', 'agent-ask'); root.tabIndex = -1;
  const steps = q.fields;
  const answers = steps.map(f => ({ pick: f.kind === 'choice' ? f.value : null, picks: new Set(f.kind === 'multi' ? f.value : []), other: '', value: f.value }));
  const review = steps.length > 1;   // several questions end on a summary to confirm
  let at = 0, cursor = 0, rows = [];
  const content = () => Object.fromEntries(steps.flatMap((f, i) => {
    const a = answers[i], other = f.other && a.other.trim() ? [[f.other, a.other]] : [];
    if (f.kind === 'choice') return a.pick === null ? other : [[f.key, a.pick]];
    if (f.kind === 'multi') return [...(a.picks.size ? [[f.key, [...a.picks]]] : []), ...other];
    if (f.kind === 'number') return a.value === '' || a.value === null ? [] : [[f.key, Number(a.value)]];
    return [[f.key, a.value]];
  }));
  const said = i => {
    const f = steps[i], a = answers[i], title = v => f.options.find(o => o.value === v)?.title || v;
    if (f.kind === 'choice') return a.pick !== null ? title(a.pick) : a.other.trim();
    if (f.kind === 'multi') return [...[...a.picks].map(title), ...(a.other.trim() ? [a.other.trim()] : [])].join(', ');
    if (f.kind === 'boolean') return a.value ? 'Yes' : 'No';
    return a.value === null ? '' : f.secret && a.value ? '••••' : String(a.value).trim();
  };
  const submit = () => run('answer', { id: q.id, content: content() });
  const skip = () => run('answer', { id: q.id });
  const go = step => { at = Math.max(0, Math.min(step, steps.length - (review ? 0 : 1))); cursor = 0; draw(); };
  const advance = () => (at < steps.length - 1 || review ? go(at + 1) : submit());
  const typed = (value, placeholder, change, act) => ({ input: { value, placeholder, change }, act });
  const rowsFor = (f, a) => {
    const last = at === steps.length - 1 && !review ? 'Submit' : 'Next';
    const other = f.other ? [typed(a.other, 'Type something else…', v => { a.other = v; if (v.trim() && f.kind === 'choice') a.pick = null; },
      () => { if (f.kind === 'choice' && !a.other.trim()) return; advance(); })] : [];
    if (f.kind === 'choice') return [...f.options.map(o => ({ title: o.title, description: o.description, picked: a.pick === o.value,
      act: () => { a.pick = o.value; a.other = ''; advance(); } })), ...other];
    if (f.kind === 'multi') return [...f.options.map(o => ({ title: o.title, description: o.description, box: a.picks.has(o.value),
      act: () => { a.picks.has(o.value) ? a.picks.delete(o.value) : a.picks.add(o.value); draw(); } })), ...other, { title: last, act: advance }];
    if (f.kind === 'boolean') return [true, false].map(v => ({ title: v ? 'Yes' : 'No', picked: a.value === v, act: () => { a.value = v; advance(); } }));
    return [{ ...typed(a.value ?? '', 'Type your answer…', v => { a.value = v; }, advance), secret: f.secret }, { title: last, act: advance }];
  };
  function draw() {
    const f = steps[at], body = [];
    if (steps.length > 1) {
      const nav = node('div', '', 'agent-ask-steps');
      steps.forEach((step, i) => { const b = button(`${said(i) ? '✓ ' : ''}${step.title || `Question ${i + 1}`}`, () => go(i)); b.setAttribute('aria-current', String(i === at)); nav.append(b); });
      const b = button('Submit', () => go(steps.length)); b.setAttribute('aria-current', String(at === steps.length)); nav.append(b);
      body.push(nav);
    } else if (f.title) body.push(node('span', f.title, 'agent-ask-chip'));
    if (f) {
      body.push(node('p', steps.length > 1 ? f.description || f.title || q.message : q.message || f.description || f.title, 'agent-ask-question'));
      if (steps.length === 1 && q.message && f.description) body.push(node('p', f.description, 'agent-hint'));
      rows = rowsFor(f, answers[at]);
    } else {
      body.push(node('p', 'Review your answers', 'agent-ask-question'));
      const list = node('dl', '', 'agent-ask-review');
      steps.forEach((step, i) => list.append(node('dt', step.description || step.title || `Question ${i + 1}`), node('dd', said(i) || 'No answer')));
      body.push(list);
      rows = [{ title: 'Submit answers', act: submit }, { title: 'Skip', act: skip }];
    }
    cursor = Math.min(cursor, rows.length - 1);
    const list = node('div', '', 'agent-ask-rows');
    rows.forEach((row, i) => {
      const el = node(row.input ? 'label' : 'button', '', 'agent-ask-row');
      if (!row.input) el.type = 'button';
      el.dataset.active = String(i === cursor);
      if (row.picked) el.dataset.picked = 'true';
      el.append(node('span', 'box' in row ? (row.box ? '☑' : '☐') : `${i + 1}.`, 'agent-ask-n'));
      if (row.input) {
        const input = node('input'); input.type = row.secret ? 'password' : steps[at]?.kind === 'number' ? 'number' : 'text';
        input.value = row.input.value; input.placeholder = row.input.placeholder;
        input.oninput = () => row.input.change(input.value);
        input.onfocus = () => { if (cursor !== i) { cursor = i; draw(); } };
        el.append(input); row.el = input;
      } else {
        const text = node('span'); text.append(node('strong', row.title));
        if (row.description) text.append(node('small', row.description));
        el.append(text); el.onclick = () => { cursor = i; row.act(); };
      }
      list.append(el);
    });
    const hint = node('p', `Enter to select · ↑↓ to move${steps.length > 1 ? ' · Tab to change question' : ''} · Esc to skip`, 'agent-ask-hint');
    root.replaceChildren(...body, list, hint);
    if (root.isConnected) root.ask();
  }
  // Typing goes to the highlighted row when it is a text box, else to the list.
  root.ask = () => { const input = rows[cursor]?.el; (input || root).focus({ preventScroll: true }); if (input?.type === 'text') input.setSelectionRange(input.value.length, input.value.length); };
  root.onkeydown = event => {
    const typing = event.target.tagName === 'INPUT', done = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.key === 'Escape') { done(); return skip(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { done(); cursor = (cursor + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length; return draw(); }
    if (event.key === 'Tab' && steps.length > 1) { done(); return go(at + (event.shiftKey ? -1 : 1)); }
    if (event.key === 'Enter' || (!typing && event.key === ' ')) { done(); return rows[cursor]?.act(); }
    if (!typing && /^[1-9]$/.test(event.key) && rows[event.key - 1] && !event.metaKey && !event.ctrlKey && !event.altKey) { done(); cursor = event.key - 1; return rows[cursor].input ? draw() : rows[cursor].act(); }
  };
  draw();
  return root;
}

export function agentControls(request, input, note, otherChats, onDispose) {
  const host = node('div', '', 'agent-controls');
  const m = { host, input, note, otherChats, pending: false };
  const run = async (action, payload = {}) => {
    if (m.pending && action !== 'cancel') return;
    m.pending = true; m.localError = ''; updateAgentControls(current);
    // Every control acts on the chat it is showing: its tab, not just its session.
    try {
      const { released } = await request(`/api/agent/${action}`, { tab: current?.tabId ?? null, sessionId: current?.sessionId ?? null, ...payload });
      // Messages that were waiting behind a stopped reply come back to the input.
      if (released?.length) { const box = m.input(); appendDraft(box, released.join('\n\n')); box.focus(); }
    }
    catch (error) { m.localError = error.message; }
    finally { m.pending = false; updateAgentControls(current); }
  };
  const connect = agent => {
    m.picker.open = false;
    if (current?.agent === agent && current?.status === 'ready') return;
    return run('connect', { agent });
  };
  const card = node('section', '', 'agent-login');
  const brand = node('div', 'fireside', 'agent-wordmark');
  const heading = node('h2', 'Pick an agent to start chatting.');
  const intro = node('p', 'It can work on this project, and change this desk while you talk.', 'agent-intro');
  const providers = node('div', '', 'agent-providers');
  const providerList = node('div', '', 'agent-provider-list');
  const more = button('More agents…', () => sheet.open('list'), 'agent-provider agent-provider-more');
  const typed = button('Run a command…', () => sheet.open('command'), 'agent-text-button');
  providers.append(providerList, more, typed);
  const status = node('p', '', 'agent-status'); status.setAttribute('role', 'status');
  const error = node('p', '', 'agent-error'); error.setAttribute('role', 'alert');
  const recovery = node('div', '', 'agent-recovery');
  const login = node('div', '', 'agent-sign-in');
  const retry = button('Try again', () => {
    const resume = current.preferred?.agent === current.agent && current.sessions?.some(s => s.id === current.preferred.sessionId && s.agent === current.agent);
    return run('connect', { agent: current.agent, ...(resume ? { resume: current.preferred.sessionId } : {}) });
  });
  const fresh = button('Start a new conversation', () => run('connect', { agent: current.agent }), 'agent-text-button');
  recovery.append(login, retry, fresh);
  const cancel = button('Cancel', () => run('cancel'), 'agent-text-button');
  const reassurance = node('p', 'Already signed in on this computer? We’ll use that login.', 'agent-reassurance');
  const help = details('Need help signing in?', 'agent-help');
  for (const [id, command] of Object.entries(SIGN_IN)) {
    const section = node('div', '', 'agent-login-help'); section.dataset.agent = id;
    section.append(node('strong', id === 'claude' ? 'Claude' : 'Codex'), node('p', 'In your terminal, run:'), node('code', command), node('p', 'Finish signing in, then return here and continue.'));
    help.append(section);
  }
  // Any other agent signs in its own way; say so, and point to where it says how.
  const otherHelp = node('div', '', 'agent-login-help'); otherHelp.dataset.agent = '*';
  help.append(otherHelp);
  const api = details('Use an API key', 'agent-advanced');
  api.append(node('p', 'Start Fireside with ANTHROPIC_API_KEY for Claude or OPENAI_API_KEY for Codex set in its environment. Your agent manages credentials and billing.'));
  help.append(api);
  card.append(brand, heading, intro, providers, reassurance, help);

  const toolbar = node('div', '', 'agent-toolbar');
  const picker = details('Choose an agent', 'agent-picker');
  const summary = picker.querySelector('summary');
  const pickerBody = node('div', '', 'agent-picker-body');
  pickerBody.append(node('h3', 'Agent'));
  const switchList = node('div', '', 'agent-switch-list');
  const addAgent = button('Add an agent…', () => { picker.open = false; sheet.open('list'); }, 'agent-text-button');
  pickerBody.append(switchList, addAgent, node('p', 'Switching agents opens a new chat. This conversation stays open.', 'agent-hint'));
  const modelLabel = node('label', 'Model', 'agent-model-field');
  const model = node('select'); model.setAttribute('aria-label', 'Model');
  model.onchange = () => run('model', { value: model.value });
  const modelHint = node('p', '', 'agent-hint');
  modelLabel.append(model); pickerBody.append(modelLabel, modelHint);
  const effortLabel = node('label', 'Effort', 'agent-model-field agent-effort-field');
  const effort = node('select'); effort.setAttribute('aria-label', 'Effort level');
  effort.onchange = () => run('effort', { value: effort.value });
  const effortHint = node('p', '', 'agent-hint');
  effortLabel.append(effort); pickerBody.append(effortLabel, effortHint);
  // One picker per further setting the agent reports, drawn from its own list.
  const settings = node('div', '', 'agent-settings'); pickerBody.append(settings);
  const history = details('Previous conversations', 'agent-history');
  const sessions = node('select'); sessions.setAttribute('aria-label', 'Previous conversation');
  const resume = button('Resume conversation', () => {
    const saved = current?.sessions?.find(s => s.id === sessions.value);
    if (saved) { picker.open = false; return run('connect', { agent: saved.agent, resume: saved.id }); }
  });
  sessions.onchange = () => updateAgentControls(current);
  history.append(sessions, resume);
  const commands = details('Agent commands', 'agent-commands');
  const commandList = node('div', '', 'agent-command-list'); commands.append(commandList);
  const disconnect = button('Disconnect agent', () => { picker.open = false; return run('disconnect'); }, 'agent-text-button');
  pickerBody.append(history, commands, disconnect);
  const done = button('Done', () => { picker.open = false; summary.focus(); }, 'agent-picker-done'); pickerBody.append(done); picker.append(pickerBody);
  const clear = button('New chat', () => { picker.open = false; return run('clear'); });
  clear.title = 'Start a fresh conversation. Previous chats stay available.';
  const stop = button('Stop', () => run('stop'));
  toolbar.append(picker, clear, stop);
  const permissions = node('div', '', 'agent-permissions');
  const questions = node('div', '', 'agent-ask-dock');
  const sheet = addSheet(request, connect);
  host.append(card, toolbar, status, error, recovery, cancel, permissions, questions, sheet.root);
  Object.assign(m, { card, heading, intro, providers, providerList, providerButtons: [], more, typed, otherHelp, connect, request, switchList, addAgent, reassurance, help, toolbar, picker, summary, switches: [], model, modelLabel, modelHint, effort, effortLabel, effortHint, settings, status, error, recovery, login, retry, fresh, cancel, history, sessions, resume, commands, commandList, disconnect, clear, stop, permissions, questions, run });
  host.addEventListener('keydown', e => { if (e.key === 'Escape' && picker.open) { picker.open = false; summary.focus(); e.stopPropagation(); } });
  mounts.add(m);
  onDispose(() => mounts.delete(m));
  return host;
}

globalThis.document?.addEventListener('pointerdown', event => {
  for (const m of mounts) if (m.picker.open && !m.picker.contains(event.target)) m.picker.open = false;
});

// The agent buttons are redrawn only when the list itself changes. One the
// user added can be removed again with a right-click; the built-ins stay.
function drawAgents(m, state) {
  const list = state?.agents || [];
  if (!changed(m.providerList, list)) return;
  m.providerButtons = list.map(a => {
    const b = button('', () => m.connect(a.id), `agent-provider agent-provider-${SIGN_IN[a.id] ? a.id : 'other'}`);
    if (a.icon) { const img = node('img', '', 'agent-icon'); img.src = a.icon; img.alt = ''; b.append(img); b.classList.add('has-icon'); }
    b.append(node('span', `Continue with ${a.name}`));
    b.dataset.agent = a.id; removable(m, b, a); return b;
  });
  m.providerList.replaceChildren(...m.providerButtons);
  m.switches = list.map(a => { const b = button(a.name, () => m.connect(a.id), 'agent-switch'); b.dataset.agent = a.id; removable(m, b, a); return b; });
  m.switchList.replaceChildren(...m.switches);
}
function removable(m, b, a) {
  if (!a.removable) return;
  b.title = 'Right-click to remove';
  b.oncontextmenu = event => {
    event.preventDefault();
    m.host.querySelector('.agent-forget')?.remove();
    const box = node('div', '', 'agent-forget'); box.setAttribute('role', 'alert');
    const remove = button('Remove', async () => {
      remove.disabled = true;
      try { await m.request('/api/agents/remove', { id: a.id }); box.remove(); }
      catch (error) { remove.disabled = false; text.textContent = error.message; }
    }, 'agent-primary');
    const text = node('p', `Remove ${a.name}? Fireside deletes anything it downloaded for it.`);
    box.append(text, remove, button('Keep', () => box.remove(), 'agent-text-button'));
    b.after(box); remove.focus();
  };
}

// "More agents…" and "Run a command…": one sheet over the chat. The list is the
// ACP registry, read when the sheet opens; picking one says plainly what will
// be downloaded and run before anything is. A command the user types is tried
// first and kept only if it answers as an ACP agent.
function addSheet(request, connect) {
  const root = node('section', '', 'agent-add'); root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Add an agent');
  let step = 'list', entries = null, loadError = '', picked = null, working = '', error = '', filter = '', line = '';
  const close = () => { if (!working) root.hidden = true; };
  const open = which => { step = which; error = ''; picked = null; root.hidden = false; if (which === 'list' && !entries) load(); draw(); };
  async function load() {
    loadError = ''; entries = null; draw();
    try { entries = (await request('/api/agents/registry', {})).agents; } catch (e) { loadError = e.message; entries = []; }
    draw();
  }
  async function add(payload, doing) {
    working = doing; error = ''; draw();
    try {
      const { id } = await request('/api/agents/add', payload, { signal: AbortSignal.timeout(20 * 60 * 1000) });
      working = ''; entries = null; root.hidden = true; connect(id);
    } catch (e) { working = ''; error = e.message; draw(); }
  }
  const head = title => {
    const bar = node('div', '', 'agent-add-head');
    bar.append(node('h3', title), Object.assign(button('×', close, 'agent-add-close'), { title: 'Close', disabled: !!working }));
    return bar;
  };
  const actions = (...buttons) => { const row = node('div', '', 'agent-add-actions'); row.append(...buttons); return row; };
  const trust = 'It’s published by its authors, not by Fireside, so only add it if you trust them. Like any coding agent, it can read and change files in this project.';
  function draw() {
    const body = [];
    if (working) {
      body.push(head('Add an agent'), node('p', working, 'agent-status'));
    } else if (step === 'list') {
      body.push(head('Add an agent'), node('p', 'Agents from the ACP registry, a list the agent community keeps. Fireside doesn’t check or endorse them.', 'agent-hint'));
      if (!entries) body.push(node('p', 'Loading the agent list…', 'agent-status'));
      else if (loadError) body.push(node('p', loadError, 'agent-error'), button('Try again', load));
      else {
        const search = node('input', '', 'agent-add-search'); search.type = 'search'; search.placeholder = 'Filter'; search.value = filter;
        search.setAttribute('aria-label', 'Filter agents');
        const rows = node('div', '', 'agent-add-list');
        const fill = () => rows.replaceChildren(...entries.filter(e => !filter || `${e.name} ${e.description} ${e.authors}`.toLowerCase().includes(filter.toLowerCase())).map(e => {
          const row = button('', () => { picked = e; step = 'confirm'; draw(); }, 'agent-add-row');
          row.disabled = e.added;
          const img = node('img', '', 'agent-icon'); img.alt = ''; img.loading = 'lazy'; if (e.icon) img.src = e.icon; else img.hidden = true;
          img.onerror = () => { img.hidden = true; };
          const text = node('span'); text.append(node('strong', e.name), node('small', e.description));
          row.append(img, text, node('span', e.added ? 'Added' : 'Add', 'agent-add-tag'));
          return row;
        }));
        search.oninput = () => { filter = search.value; fill(); };
        fill();
        body.push(search, rows);
        queueMicrotask(() => search.focus({ preventScroll: true }));
      }
      body.push(button('Not listed? Run a command…', () => open('command'), 'agent-text-button'));
    } else if (step === 'confirm') {
      const e = picked;
      const what = e.installed ? `Fireside will run the ${e.name} already installed on this computer.`
        : `Fireside will download ${e.name}${e.version ? ` ${e.version}` : ''} from ${e.host}${e.kind === 'uvx' ? ' through uv' : ''} and run it on your computer.`;
      const meta = node('p', [e.authors && `Published by ${e.authors}`, e.license].filter(Boolean).join(' · '), 'agent-hint');
      if (e.link) meta.append(document.createTextNode(meta.textContent ? ' · ' : ''), link('repository', e.link));
      const go = button(e.installed ? 'Add' : 'Download and add', () => add({ registry: e.id }, e.installed ? `Adding ${e.name}…` : `Downloading and installing ${e.name}. This can take a minute.`), 'agent-primary');
      body.push(head(`Add ${e.name}?`), node('p', what), node('p', trust), meta);
      if (error) body.push(node('p', error, 'agent-error'));
      body.push(actions(go, button('Back', () => open('list'))));
      queueMicrotask(() => go.focus({ preventScroll: true }));
    } else {
      const form = node('form', '', 'agent-add-command');
      const input = node('input'); input.placeholder = 'opencode acp'; input.value = line; input.spellcheck = false;
      input.setAttribute('aria-label', 'Command that starts the agent');
      input.oninput = () => { line = input.value; };
      const label = node('label', 'Command that starts the agent'); label.append(input);
      form.append(label, node('p', 'Fireside will run this on your computer, without a shell, and keep it once it answers as an ACP agent. Like any coding agent, it can read and change files in this project, so only run commands you trust.', 'agent-hint'));
      if (error) form.append(node('pre', error, 'agent-error'));
      const go = button('Run and add', null, 'agent-primary'); go.type = 'submit';
      form.append(actions(go, button('Back', () => open('list'))));
      form.onsubmit = event => { event.preventDefault(); if (line.trim()) add({ command: line.trim() }, `Starting ${line.trim().split(/\s+/)[0]} to check it speaks ACP…`); };
      body.push(head('Run a command'), form);
      queueMicrotask(() => input.focus({ preventScroll: true }));
    }
    root.replaceChildren(...body);
  }
  root.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  return { root, open };
}

export function updateAgentControls(state) {
  current = state;
  for (const m of mounts) {
    const active = !!state?.agent;
    const busy = m.pending || ['connecting', 'resetting', 'authenticating', 'configuring'].includes(state?.status);
    const working = state?.status === 'working';
    const connected = hasAgentSession(state);
    const name = agentName(state) || 'your agent';
    const chat = m.host.closest('.chat');
    drawAgents(m, state);
    const mode = connected ? 'connected' : 'setup';
    m.host.dataset.mode = mode;
    chat?.setAttribute('data-connection', mode);
    m.card.hidden = connected; m.toolbar.hidden = !connected;
    m.providers.hidden = busy; m.reassurance.hidden = busy || !!state?.error;
    m.help.hidden = busy;
    // A tab opened beside a running chat is not a first sign-in.
    const another = !connected && m.otherChats();
    m.heading.textContent = state?.status === 'authenticating' ? 'Finish signing in.' : busy ? `Connecting to ${name}…` : state?.error ? 'Let’s reconnect.' : another ? 'Open another chat.' : 'Pick an agent to start chatting.';
    m.intro.textContent = state?.status === 'authenticating' ? 'Complete sign-in in your browser. Your chat will open here automatically.' : busy ? 'Your chat will open once the connection is ready.' : state?.error ? `We couldn’t connect to ${name}. Try again or choose another agent.` : another ? 'Choose the agent for this chat. It runs alongside the chats you already have open, on the same project.' : 'It can work on this project, and change this desk while you talk.';
    m.more.disabled = m.typed.disabled = m.addAgent.disabled = busy || working;
    for (const b of m.providerButtons) b.disabled = busy || working;
    for (const b of m.switches) { b.disabled = busy || working; b.setAttribute('aria-pressed', String(b.dataset.agent === state?.agent)); }
    const model = state?.model;
    const effort = state?.effort;
    const currentModel = model?.options?.find(o => o.value === model.current);
    const currentEffort = effort?.options?.find(o => o.value === effort.current);
    m.summary.textContent = connected ? [name, currentModel?.name || 'Agent default', currentEffort?.name].filter(Boolean).join(' · ') : 'Choose an agent';
    m.summary.title = m.summary.textContent;
    if (changed(m.model, model)) choices(m.model, model);
    m.model.value = model?.current || '';
    m.model.disabled = busy || working || !connected || !model?.options?.length;
    m.modelHint.textContent = model ? (working ? 'You can change models after this response.' : 'Applies to your next message.') : 'This agent manages its model automatically.';
    m.modelLabel.hidden = !active; m.modelHint.hidden = !active;
    if (changed(m.effort, effort)) choices(m.effort, effort);
    m.effort.value = effort?.current || '';
    m.effort.disabled = busy || working || !connected || !effort?.options?.length;
    m.effortHint.textContent = working ? 'You can change effort after this response.' : effort?.description || 'Applies to your next message.';
    m.effortLabel.hidden = !active || !effort; m.effortHint.hidden = !active || !effort;
    const extra = active ? state?.settings || [] : [];
    if (changed(m.settings, extra.map(o => [o.id, o.name, o.description, o.options]))) {
      m.settings.replaceChildren(...extra.flatMap(o => {
        const label = node('label', o.name, 'agent-model-field agent-effort-field');
        const select = node('select'); select.dataset.setting = o.id; select.setAttribute('aria-label', o.name);
        select.append(...o.options.map(c => option(c.value, c.name)));
        select.onchange = () => m.run('setting', { id: o.id, value: select.value });
        label.append(select);
        return [label, node('p', o.description || '', 'agent-hint')];
      }));
    }
    for (const select of m.settings.querySelectorAll('select')) {
      select.value = extra.find(o => o.id === select.dataset.setting)?.current ?? '';
      select.disabled = busy || working || !connected;
    }
    m.clear.hidden = !connected; m.clear.disabled = busy;
    m.stop.hidden = !working; m.stop.disabled = m.pending;
    const labels = { asleep: 'Asleep · wakes when you send', connecting: 'Connecting…', resetting: 'Starting a new conversation…', authenticating: 'Waiting for sign-in…', configuring: 'Changing settings…', working: 'Working…' };
    m.status.textContent = labels[state?.status] || ''; m.status.hidden = !m.status.textContent;
    // Once a chat is open, the status shares the line with its token usage.
    const usageBar = mode !== 'setup' && chat?.querySelector('[data-chat-usage]');
    if (usageBar) usageBar.dataset.status = state?.status || '';
    if (usageBar && m.status.parentNode !== usageBar) usageBar.prepend(m.status);
    else if (!usageBar && m.status.parentNode !== m.host) m.toolbar.after(m.status);
    const error = m.localError || state?.error || '';
    m.error.textContent = error; m.error.hidden = !error;
    m.recovery.hidden = !active || connected || !error || busy;
    const methods = state?.status === 'error' ? state?.authMethods || [] : [];
    if (changed(m.login, methods)) {
      m.login.replaceChildren(...methods.map(a => { const b = button(`Sign in with ${a.name}`, () => m.run('authenticate', { methodId: a.id }), 'agent-primary'); b.title = a.description; return b; }));
    }
    m.login.hidden = !methods.length;
    for (const b of m.login.children) b.disabled = busy;
    m.retry.disabled = busy; m.fresh.hidden = !state?.preferred || state.preferred.agent !== state.agent;
    m.cancel.hidden = !['connecting', 'authenticating'].includes(state?.status); m.cancel.disabled = m.pending;
    m.disconnect.hidden = !active; m.disconnect.disabled = busy || working;
    if (state?.error && state.agent === 'claude' && m.lastError !== state.error) m.help.open = true;
    m.lastError = state?.error;
    const own = state?.agent && !SIGN_IN[state.agent] ? state.agents?.find(a => a.id === state.agent) : null;
    if (changed(m.otherHelp, own)) m.otherHelp.replaceChildren(...own ? [node('strong', own.name), node('p', `${own.name} signs in its own way. Follow its instructions, then return here and try again.`),
      ...own.link ? [link('How to sign in', own.link)] : []] : []);
    for (const section of m.help.querySelectorAll('.agent-login-help')) {
      section.hidden = section.dataset.agent === '*' ? !own || !state?.error : !!state?.error && section.dataset.agent !== state.agent;
    }
    const saved = state?.sessions || [];
    m.history.hidden = !saved.length;
    if (changed(m.sessions, saved)) {
      const selected = m.sessions.value;
      m.sessions.replaceChildren(option('', 'Choose a conversation'), ...saved.map(s => option(s.id, [state.agents?.find(a => a.id === s.agent)?.name || s.agent, s.title, new Date(s.at).toLocaleString()].filter(Boolean).join(' · '))));
      if (saved.some(s => s.id === selected)) m.sessions.value = selected;
    }
    m.sessions.disabled = busy || working;
    m.resume.disabled = busy || working || !m.sessions.value;
    m.commands.hidden = !connected || !state?.commands?.length;
    if (changed(m.commandList, state?.commands)) {
      m.commandList.replaceChildren(...(state?.commands || []).map(c => {
        const b = button(`/${c.name}`, () => { const box = m.input(); box.value = `/${c.name} `; box.dispatchEvent(new Event('input', { bubbles: true })); m.picker.open = false; box.focus(); });
        b.title = c.description; return b;
      }));
    }
    if (changed(m.permissions, state?.permissions)) {
      m.permissions.replaceChildren(...(state?.permissions || []).map(p => {
        const section = node('section', '', 'agent-permission');
        section.append(node('strong', p.title));
        if (p.toolCall) section.append(node('pre', JSON.stringify(p.toolCall.rawInput || { content: p.toolCall.content, locations: p.toolCall.locations }, null, 2)));
        for (const o of p.options) section.append(button(o.name, () => m.run('permission', { id: p.id, optionId: o.optionId })));
        return section;
      }));
    }
    // One question at a time, docked where the composer is.
    const asked = state?.questions?.[0], bar = chat?.querySelector('.cbar');
    if (bar && m.questions.nextSibling !== bar) bar.before(m.questions);
    chat?.classList.toggle('asking', !!asked);
    if (changed(m.questions, asked)) {
      const dock = asked && questionDock(asked, m.run);
      m.questions.replaceChildren(...(dock ? [dock] : []));
      if (dock) dock.ask(); else if (chat?.contains(document.activeElement) || document.activeElement === document.body) bar?.querySelector('textarea')?.focus();
    }
    const box = chat?.querySelector('textarea');
    if (box) box.placeholder = active ? `Message ${name}…` : 'Reply to Claude…';
  }
}
