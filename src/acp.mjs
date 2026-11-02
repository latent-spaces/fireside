import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { PKG_ROOT } from './paths.ts';
import { installing } from './updates.mjs';
import * as agents from './agents.mjs';
import { fail } from './errors.ts';
import { saveImage, imageBlock, imageNote } from './chat-images.mjs';
import { agentEvent, errorSignal, activeTurns, startTurn, endTurn } from './agent-diagnostics.mjs';

/** Statuses mid-operation: a chat in one is busy, and another operation must wait. */
export const BUSY = ['working', 'connecting', 'resetting', 'authenticating', 'configuring'];
export const deadline = (promise, ms, message) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
};
// The agent is started by Fireside, so nothing else tells it where it is. Claude
// takes this as a system prompt addition; other agents have no such hook, so it
// rides ahead of the first message and is hidden from the chat window.
const CONTEXT = `You are running inside Fireside, a browser desktop for this project. The user is talking to you through its Chat window, connected over the Agent Client Protocol; your replies already appear there.
Before creating or changing Fireside panels, or answering what the user can do here, read the Fireside skill at ${path.join(PKG_ROOT, 'SKILL.md')} and follow it. The desk is already running, so do not run \`fireside start\`. Use the \`fireside\` CLI on PATH to keep panels current while you work.
A sentence you write just before a tool call can reach the user reworded and without its links or codes. When the user must see or act on something before you continue (a link to open, a code to check, a choice), give it to them in a reply that ends your turn, or ask with your question tool if you have one. Do not follow it with a tool call that waits.`;
// ACP's `authRequired` error. An agent can send it from any call, not only session
// setup, and it means the call did nothing.
const AUTH_REQUIRED = -32000;
// The adapters ask their CLI who is signed in, and give that up after five seconds.
const AUTH_STATUS_WAIT = 6000;
/** End a process and everything it started. */
async function stop(child) {
  // One that already exited has no close event left to wait for.
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const kill = signal => { try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
  kill('SIGTERM');
  try { await deadline(new Promise(resolve => child.once('close', resolve)), 2000, 'timeout'); } catch { kill('SIGKILL'); }
}
const PRIMER = /\s*<fireside-(context|images)>[\s\S]*?<\/fireside-\1>\s*/g;

// The page gets plain fields to draw, never the agent's raw schema, and what
// comes back is checked against those same fields before the agent sees it.
const CODEX_OTHER = 'None of the above';
function formFields(schema) {
  const required = new Set(schema?.required || []);
  const options = list => list.map(o => typeof o === 'string' ? { value: o, title: o }
    : { value: String(o.const), title: o.title || String(o.const), description: o.description || '' });
  const fields = Object.entries(schema?.properties || {}).flatMap(([key, p]) => {
    // Codex puts the question in the title and its short label in the
    // description; everything else here expects them the other way round.
    const codex = p?._meta?.codex;
    const base = { key, title: (codex ? p.description : p?.title) || '', description: (codex ? p.title : p?.description) || '', required: required.has(key),
      ...(codex?.isSecret === true && { secret: true }), ...(codex?.role === 'user_note' && { note: codex.questionId }) };
    const picks = p?.type === 'array' ? p.items?.anyOf || p.items?.oneOf || p.items?.enum : p?.oneOf || p?.enum;
    if (p?.type === 'array') return Array.isArray(picks) ? [{ ...base, kind: 'multi', options: options(picks), value: Array.isArray(p.default) ? p.default : [] }] : [];
    if (p?.type === 'string') return Array.isArray(picks) ? [{ ...base, kind: 'choice', options: options(picks), value: p.default ?? null }] : [{ ...base, kind: 'text', value: p.default ?? '' }];
    if (p?.type === 'number' || p?.type === 'integer') return [{ ...base, kind: 'number', integer: p.type === 'integer', value: p.default ?? null }];
    if (p?.type === 'boolean') return [{ ...base, kind: 'boolean', value: p.default === true }];
    return [];
  });
  // Both agents send a question's free-text answer as a field of its own.
  // It is that question's "Other", not another question. Codex also adds a
  // stand-in option to pick when the answer is typed; the page needs neither.
  return fields.filter(f => {
    const of = f.note || (f.key.endsWith('_custom') ? f.key.slice(0, -'_custom'.length) : null);
    const owner = f.kind === 'text' && of && fields.find(o => o.options && o.key === of);
    if (!owner) return true;
    owner.other = f.key;
    if (f.note && owner.options.some(o => o.value === CODEX_OTHER)) { owner.otherValue = CODEX_OTHER; owner.options = owner.options.filter(o => o.value !== CODEX_OTHER); }
    return false;
  });
}
function formContent(fields, input) {
  const content = {};
  for (const f of fields) {
    const v = input?.[f.key];
    if (f.kind === 'choice' && f.options.some(o => o.value === v)) content[f.key] = v;
    if (f.kind === 'multi' && Array.isArray(v)) { const picked = f.options.map(o => o.value).filter(o => v.includes(o)); if (picked.length) content[f.key] = picked; }
    if (f.kind === 'text' && typeof v === 'string' && v.trim()) content[f.key] = v.slice(0, 8000);
    if (f.kind === 'number' && Number.isFinite(v)) content[f.key] = f.integer ? Math.round(v) : v;
    if (f.kind === 'boolean') content[f.key] = v === true;
    if (f.other && typeof input?.[f.other] === 'string' && input[f.other].trim()) content[f.other] = input[f.other].slice(0, 8000);
    if (f.otherValue && f.other in content && !(f.key in content)) content[f.key] = f.otherValue;
    if (f.required && !(f.key in content)) throw fail(`${f.title || 'One answer'} is required`, 400);
  }
  return content;
}

export class AcpChat {
  /** @param {import("./contracts.ts").ChatOptions} options */
  constructor({ root, id = 'chat', store, onChange = () => {}, onActivity = () => {}, spawnAgent, pending = [], includeContext = true } = {}) {
    this.root = root;
    // Which tab this chat belongs to. Saved conversations belong to the desk, not
    // to one chat, so the list and this tab's last conversation live in the store
    // every tab shares (src/chats.mjs) instead of in a file each would overwrite.
    this.id = id;
    this.store = store;
    this.onChange = onChange;
    // The activity window's feed: onActivity(entry) records a row, onActivity(entry, row) updates it.
    this.onActivity = onActivity;
    this.toolActivity = new Map();
    this.spawnAgent = spawnAgent;
    this.includeContext = includeContext;
    // Pending work is durable and independent of the bounded display history. A
    // message that was on its way when the server stopped counts as sent: it is
    // never sent twice by itself, and the user can see whether it needs sending again.
    const waiting = pending.filter(row => row.state !== 'delivered' && !row.deliveryUnknown);
    this.pending = waiting.map(row => ({ ...row, state: 'queued' }));
    if (waiting.length < pending.length) this.error = 'The last reply was cut off. Send your message again if it didn’t finish.';
    // It stays in the thread, since neither the transcript nor the agent is sure to have it.
    const cutOff = pending.filter(row => !waiting.includes(row)).map(row => ({ ...row, state: 'interrupted' }));
    this.rows = [...cutOff, ...this.pending];
    this.permissions = new Map();
    this.questions = new Map();
    this.requests = new Map();
    for (const row of this.pending) this.requests.set(row.id, row.text);
    this.commands = [];
    this.status = 'disconnected';
    this.agent = this.pending[0]?.agent || null;
    this.sessionId = this.pending[0]?.sessionId || null;
    this.generation = 0;
    this.configOptions = []; this.usage = null;
    this.attachPending();
  }
  diagnostic(event, fields = {}) {
    agentEvent(this.root, event, { tabId: this.id, agent: this.agent, sessionId: this.sessionId,
      agentPid: this.child?.pid ?? null, ...fields });
  }
  get history() { return this.store.sessions; }
  set history(value) { this.store.sessions = value; }
  get preferred() { return this.store.preferred(this.id); }
  set preferred(value) { this.store.setPreferred(this.id, value); }
  view() {
    if (this.held) return { ...this.held.view, sessions: this.history, waking: true };
    return { tabId: this.id, agent: this.agent, sessionId: this.sessionId, status: this.status, error: this.error || null,
      signIn: !!this.signIn,
      commands: this.commands, agents: agents.view(this.root), sessions: this.history, model: this.model(), effort: this.effort(), settings: this.settings(),
      authMethods: this.authMethods(),
      preferred: this.preferred,
      canLoad: !!this.info?.agentCapabilities?.loadSession,
      images: !!this.info?.agentCapabilities?.promptCapabilities?.image,
      permissions: [...this.permissions].map(([id, p]) => ({ id, ...p.view })),
      questions: [...this.questions].map(([id, q]) => ({ id, ...q.view })) };
  }
  // Sign-in the agent can do when asked, or as a program of its own (a terminal
  // method). One carrying _meta wants client-side setup (an API key field, a
  // gateway) Fireside doesn't do.
  authMethods() {
    if (!this.connection || this.connection.signal.aborted) return [];
    return (this.info?.authMethods || []).filter(m => (!m.type || m.type === 'agent' || m.type === 'terminal') && !m._meta && typeof m.id === 'string')
      .map(m => ({ id: m.id, name: String(m.name || m.id), description: m.description || '' }));
  }
  get name() { return agents.get(this.root, this.agent)?.name || this.agent || 'your agent'; }
  changed() { this.touched = Date.now(); this.onChange(); }
  save() { this.store.save(); }
  /** Save after something went wrong; what to add to that message if the save fails too. */
  saveNote() {
    try { this.save(); return ''; }
    catch (error) { return ` Recovery could not be saved: ${error.message}`; }
  }
  // The thread as the page draws it. Tool output stays out: it can run to megabytes.
  // While a sleeping chat wakes, its agent replays the conversation from the top;
  // the saved thread stays on screen until that replay is whole.
  get shown() {
    const rows = this.held ? [...this.held.rows.filter(row => !this.pending.includes(row)), ...this.pending] : this.rows;
    return rows.map(({ content, rawInput, rawOutput, locations, ...row }) => row); }
  /** Save what the chat window needs to show this conversation with no agent running. */
  remember() {
    if (!this.agent || !this.sessionId || !this.store.remember) return;
    const queued = new Set(this.pending.map(row => row.id));
    try {
      this.store.remember(this.id, { agent: this.agent, sessionId: this.sessionId, canLoad: !!this.info?.agentCapabilities?.loadSession,
        rows: this.shown.filter(row => !queued.has(row.id)),
        configOptions: this.configOptions, commands: this.commands, usage: this.contextUsage() });
    } catch (error) { console.error(`Cannot save the transcript of chat ${this.id}: ${error.message}`); }
  }
  requireEmptyQueue() {
    if (this.pending.length) throw fail('Finish or remove the queued messages before leaving this conversation. Stop an active reply first.');
  }
  checkQueueSession(agent, sessionId) {
    if (this.pending.some(row => row.agent !== agent || row.sessionId !== sessionId)) this.requireEmptyQueue();
  }
  attachPending() {
    const ids = new Set(this.pending.map(row => row.id));
    this.rows = this.rows.filter(row => !ids.has(row.id));
    this.rows.push(...this.pending);
  }
  /** @returns {import("./contracts.ts").Picker | null} */
  model() {
    return this.selectOption(o => o.category === 'model' || o.id === 'model');
  }
  /** @returns {import("./contracts.ts").Picker | null} */
  effort() {
    return this.selectOption(o => o.category === 'thought_level' || o.id === 'reasoning_effort');
  }
  // Everything else the adapter lets a user choose: permission mode, plan mode,
  // fast mode, and whatever a later adapter adds. Nothing here names one.
  settings() {
    const shown = [this.model()?.id, this.effort()?.id];
    return this.configOptions.filter(o => o.type === 'select' && !shown.includes(o.id)).map(o => this.selectOption(c => c === o));
  }
  selectOption(matches) {
    const option = this.configOptions.find(o => o.type === 'select' && matches(o));
    if (!option) return null;
    return { id: option.id, name: option.name, description: option.description, current: option.currentValue,
      options: option.options.flatMap(o => o.options || [o]).map(o => ({ value: o.value, name: o.name, description: o.description })) };
  }
  // The chat's token badge: the adapter's last usage_update, named after the chosen model.
  usageView() {
    if (this.held) return this.held.usage;
    const usage = this.contextUsage();
    if (!usage) return null;
    const model = this.model();
    const name = model?.options.find(o => o.value === model.current)?.name || model?.current || this.name;
    return { ...usage, model: name };
  }
  // A reconnect clears usage, and the agent only reports it again after its next
  // reply. The same conversation's last count stands until then.
  contextUsage() {
    return this.usage || (this.sessionId && this.lastUsage?.sessionId === this.sessionId ? this.lastUsage.usage : null);
  }
  // Every failure ends here. A chat with a conversation stays on it, asleep, with
  // the error beside it: sending or Try again picks it up. Only a chat with nothing
  // to keep goes back to the agent picker.
  halt(error, signIn = false) {
    const thread = (this.held?.rows || this.rows).some(row => row.role === 'user' && !this.pending.includes(row));
    // An agent only keeps a conversation that got a message; there's none to go back to.
    if (!thread && !this.history.some(s => s.id === this.sessionId)) {
      this.sessionId = null;
      for (const row of this.pending) row.sessionId = null;
    }
    this.status = this.sessionId ? 'asleep' : 'error';
    this.error = error; this.signIn = signIn; this.changed();
  }
  needSignIn(note = '') { this.halt(`Sign in to ${this.name} to continue.${note}`, true); }
  // `_auth/status_update`, which Claude and Codex push once they know who is signed
  // in. "none" is known to be signed out; silence is not.
  authUpdate(status) { this.authStatus = status?.kind; this.authReported(); }
  async setModel(value, sessionId) {
    return this.setSelectOption(this.model(), value, sessionId, 'model');
  }
  async setEffort(value, sessionId) {
    return this.setSelectOption(this.effort(), value, sessionId, 'effort level');
  }
  async setSetting(id, value, sessionId) {
    return this.setSelectOption(this.settings().find(o => o.id === id), value, sessionId, 'setting');
  }
  async setSelectOption(option, value, sessionId, label) {
    if (!sessionId || sessionId !== this.sessionId) throw fail('The conversation changed');
    if (this.status !== 'ready') throw fail('Wait for the current operation to finish');
    if (!option?.options.some(o => o.value === value)) throw fail(`This ${label} is not available`, 400);
    const generation = this.generation;
    this.status = 'configuring'; this.error = null; this.changed();
    try {
      const result = await deadline(this.connection.setSessionConfigOption({ sessionId, configId: option.id, value }), 25000, `${option.name || label} change timed out. Reconnect to check the current setting.`);
      if (generation !== this.generation) return;
      this.configOptions = result.configOptions;
    } catch (error) {
      if (generation === this.generation && error.code === AUTH_REQUIRED) return this.needSignIn();
      if (generation === this.generation) this.error = error.message;
    } finally { if (generation === this.generation && this.status === 'configuring') { this.status = 'ready'; this.changed(); } }
  }
  // The last conversation, if it can be loaded. One that never got a message was never saved by the agent.
  saved(agent = this.agent) {
    const id = this.preferred?.agent === agent ? this.preferred.sessionId : null;
    return this.history.some(s => s.id === id && s.agent === agent) || this.pending.some(r => r.sessionId === id && r.agent === agent) ? id : null;
  }
  /**
   * Asleep: the conversation shows from its saved transcript and no agent runs
   * until the next message. A chat with queued work, or whose agent cannot
   * resume a session, is not put to sleep: waking it would lose its place.
   * @param {any} saved what remember() wrote, if anything
   * @param {boolean} blank sleep even with no saved transcript to show
   */
  rest(saved, blank) {
    const previous = this.preferred;
    if (!previous || !agents.get(this.root, previous.agent) || this.pending.length) return false;
    const match = saved?.agent === previous.agent && saved.sessionId === previous.sessionId;
    if (match ? saved.canLoad === false : !blank) return false;
    this.agent = previous.agent;
    this.sessionId = match ? saved.sessionId : this.saved(previous.agent);
    if (match) Object.assign(this, { rows: [...saved.rows || [], ...this.rows.filter(row => row.state === 'interrupted')], configOptions: saved.configOptions || [], commands: saved.commands || [], lastUsage: saved.usage ? { sessionId: saved.sessionId, usage: saved.usage } : null });
    this.attachPending();
    this.status = 'asleep';
    return true;
  }
  /** Stop an idle chat's agent and keep showing its conversation. False when it is not idle. */
  async sleep() {
    if (this.status !== 'ready' || this.waking || this.pending.length || this.permissions.size || this.questions.size) return false;
    if (!this.info?.agentCapabilities?.loadSession) return false;
    this.remember();
    const kept = { agent: this.agent, sessionId: this.sessionId, rows: this.rows, configOptions: this.configOptions, commands: this.commands, usage: this.usage };
    await this.close();
    Object.assign(this, kept);
    this.status = 'asleep'; this.changed();
    return true;
  }
  /** Start a sleeping chat's agent on the conversation it shows. One wake at a time. */
  wake() {
    if (this.waking || this.status !== 'asleep') return this.waking || Promise.resolve();
    // Reconnecting clears the session and its settings on the way. The page goes on
    // showing the chat as it was, so a wake is invisible unless it fails.
    const { rows, configOptions, commands } = this;
    this.held = { view: this.view(), usage: this.usageView(), rows };
    this.waking = this.connect(this.agent, this.sessionId, { restoring: true }).then(() => {
      // A wake that failed keeps the thread on screen beside its error.
      if (!['ready', 'working'].includes(this.status)) { Object.assign(this, { rows, configOptions, commands }); this.attachPending(); }
      // An agent that can't resume starts over, but the thread is still the user's.
      else if (!this.info?.agentCapabilities?.loadSession) { this.rows = rows; this.attachPending(); }
      // The agent's replay may not have a turn that died, and the user may want to send it again.
      else this.rows.push(...rows.filter(row => row.state === 'interrupted' && row.role === 'user' && !this.rows.some(r => r.role === 'user' && r.text === row.text)));
    }).finally(() => { this.waking = null; this.held = null; this.changed(); });
    return this.waking;
  }
  async restore() {
    const previous = this.preferred;
    if (!previous || !agents.get(this.root, previous.agent)) return;
    await this.connect(previous.agent, this.saved(previous.agent), { restoring: true });
  }
  async disconnect() {
    this.requireEmptyQueue();
    this.preferred = null; this.save();
    await this.close(); this.agent = null; this.changed();
  }
  /** @param {string} agent
   * @param {string | null} resume */
  async connect(agent, resume = null, { restoring = false } = {}) {
    const spec = agents.get(this.root, agent);
    if (!spec) throw fail('Unknown agent', 400);
    if (BUSY.includes(this.status)) throw fail('A session operation is already in progress');
    this.checkQueueSession(agent, resume);
    if (resume && resume !== this.preferred?.sessionId && !this.history.some(s => s.id === resume && s.agent === agent) && !this.pending.some(r => r.sessionId === resume && r.agent === agent)) throw fail('Unknown saved session', 400);
    if (this.preferred?.agent !== agent || this.preferred?.sessionId !== resume) this.requests.clear();
    await this.close();
    const generation = ++this.generation;
    this.agent = agent; this.rows = []; this.sessionId = resume; this.attachPending();
    this.status = 'connecting'; this.error = null; this.signIn = false; this.changed();
    this.authStatus = null;
    this.authKnown = new Promise(resolve => { this.authReported = resolve; });
    let unstarted = null;
    try {
      // Every desk shares one node_modules, so another desk may be installing
      // into it right now. Spawning from a half-written tree fails in ways that
      // look like agent bugs, so wait for the tree to be whole instead.
      if (installing()) throw new Error('Fireside is updating its agent. Try again in a moment.');
      const program = agents.launch(spec);
      this.child = this.spawnAgent ? this.spawnAgent() : spawn(program.command, program.args, { cwd: this.root, env: this.agentEnv(spec), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      const child = this.child;
      this.diagnostic('agent_started');
      const childAgent = this.agent;
      child.once('exit', (code, signal) => this.diagnostic('agent_exit', { agent: childAgent, sessionId: null, agentPid: child.pid, exitCode: code, signal }));
      // Adapter logs can contain account details. Never broadcast raw stderr.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      // A child that never started only shows up as a closed connection otherwise.
      child.on('error', (error) => { unstarted = `Could not start the agent: ${error.message}`; });
      this.connection = new ClientSideConnection(() => ({
        sessionUpdate: params => { if (generation === this.generation) this.update(params); },
        requestPermission: params => generation === this.generation ? this.permission(params) : { outcome: { outcome: 'cancelled' } },
        createElicitation: params => generation === this.generation ? this.question(params) : { action: 'cancel' },
        extNotification: (method, params) => { if (generation === this.generation && method === '_auth/status_update') this.authUpdate(params?.authStatus); },
      }), ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
      this.connection.closed.then(() => {
        if (generation !== this.generation) return;
        this.diagnostic('agent_disconnected');
        this.cancelPermissions(); this.halt('Agent disconnected. Reconnect to continue.');
      });
      const info = await deadline(this.connection.initialize({ protocolVersion: 1, clientCapabilities: { elicitation: { form: {} }, auth: { terminal: true } }, clientInfo: { name: 'fireside', version: '0.1.0' } }), 20000, 'Agent startup timed out');
      if (generation !== this.generation) return;
      this.info = info;
      this.diagnostic('agent_initialized', { agentVersion: info.agentInfo?.version ?? null });
      if (this.info.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
      await this.newSession(restoring && !this.info.agentCapabilities?.loadSession ? null : resume);
    } catch (error) {
      if (generation !== this.generation) return;
      this.diagnostic('agent_connect_error', errorSignal(error));
      if (error.code === AUTH_REQUIRED) return this.needSignIn();
      this.halt(unstarted || error.data?.details || error.message);
    }
  }
  agentEnv(spec) {
    const env = { ...process.env, ...spec.env, FIRESIDE_PROJECT: this.root, FIRESIDE_CONNECTION: 'acp',
      // Lets `fireside stop` tell the desk this chat runs in from any other.
      FIRESIDE_SERVER_PID: String(process.pid),
      PATH: path.join(PKG_ROOT, 'bin') + path.delimiter + (process.env.PATH || '') };
    delete env.CLAUDECODE; delete env.CLAUDE_CODE_SESSION_ID;
    // Claude Code applies "Chrome on by default" to terminal sessions only, and
    // an adapter session is not one. Ask for it, unless the user already chose.
    if (spec.id === 'claude') env.CLAUDE_CODE_ENABLE_CFC ??= '1';
    return env;
  }
  async newSession(resume = null) {
    this.checkQueueSession(this.agent, resume);
    const generation = this.generation;
    const previous = { rows: this.rows, sessionId: this.sessionId, commands: this.commands, configOptions: this.configOptions, usage: this.usage };
    if (resume && !this.info?.agentCapabilities?.loadSession) throw fail('This agent cannot resume saved sessions');
    this.configOptions = [];
    this.rows = []; this.commands = []; this.sessionId = resume; this.message = null; this.usage = null;
    try {
      const params = { cwd: this.root, mcpServers: [], ...(this.includeContext && this.agent === 'claude' && { _meta: { systemPrompt: { append: CONTEXT } } }) };
      const result = await deadline(resume ? this.connection.loadSession({ ...params, sessionId: resume }) : this.connection.newSession(params), 25000, 'Session setup timed out. Reconnect to try again.');
      if (generation !== this.generation) return;
      // A session doesn't prove a login: Claude opens one signed out and only
      // refuses the first message. So don't call the chat ready before it says who
      // it is, which it usually has by now.
      if (this.info?.agentCapabilities?._meta?.authStatus) await deadline(this.authKnown, AUTH_STATUS_WAIT, 'No auth status').catch(() => {});
      if (generation !== this.generation) return;
      if (this.authStatus === 'none') throw Object.assign(new Error('Authentication required'), { code: AUTH_REQUIRED });
      this.configOptions = result.configOptions || this.configOptions;
      this.sessionId = resume || result.sessionId;
      if (!this.sessionId) throw new Error('Agent returned no session ID');
      this.status = 'ready'; this.error = null;
      this.diagnostic('session_ready', { resumed: !!resume });
      if (!resume) this.requests.clear();
      for (const row of this.pending) this.requests.set(row.id, row.text);
      this.attachPending();
      this.preferred = { agent: this.agent, sessionId: this.sessionId }; this.save();
      this.remember();
      this.changed();
      // A message sent to a sleeping chat goes out once its session is back, even
      // if that took a reconnect after a failed wake.
      if (this.sendOnReady) { this.sendOnReady = false; this.next(); }
    } catch (error) {
      // The agent no longer has it, so stop offering it.
      if (resume && /not found/i.test(error.message)) {
        this.history = this.history.filter(s => !(s.id === resume && s.agent === this.agent)); this.save();
        error.message = 'That conversation is no longer available. Choose another or start a new one.';
      }
      if (generation === this.generation) Object.assign(this, previous);
      throw error;
    }
  }
  async authenticate(methodId) {
    const methods = this.authMethods();
    const method = methods.find(m => m.id === methodId) || (methods.length === 1 && !methodId ? methods[0] : null);
    if (!method || (this.status !== 'error' && !this.signIn)) throw fail('Sign in with the agent CLI, then reconnect');
    const generation = this.generation, own = this.info.authMethods.find(m => m.id === method.id);
    this.status = 'authenticating'; this.error = null; this.signIn = false; this.changed();
    try {
      if (own.type === 'terminal') {
        const finished = await this.login(own);
        if (generation !== this.generation) return;
        if (!finished) return this.needSignIn();
        // An agent that started signed out stays that way, so start it over.
        this.status = this.sessionId ? 'asleep' : 'error';
        return await (this.sessionId ? this.wake() : this.connect(this.agent, this.saved()));
      }
      await deadline(this.connection.authenticate({ methodId: method.id }), 180000, 'Sign-in timed out. Reconnect to try again.');
      this.authStatus = null;
      if (generation === this.generation) await this.newSession(this.info?.agentCapabilities?.loadSession ? this.saved() : null);
    } catch (error) {
      if (generation !== this.generation) return;
      if (error.code === AUTH_REQUIRED) return this.needSignIn();
      this.halt(error.data?.details || error.message);
    }
  }
  // A terminal method: the agent's own login, run as a program. There is no
  // terminal to give it, so it has to finish in the browser. True if it did.
  async login(method) {
    const spec = agents.get(this.root, this.agent), program = agents.launch(spec);
    const child = this.loginChild = spawn(program.command, [...program.args, ...method.args || []], { cwd: this.root, env: { ...this.agentEnv(spec), ...method.env }, stdio: 'ignore', detached: process.platform !== 'win32' });
    const exited = new Promise(resolve => { child.once('exit', code => resolve(code === 0)); child.once('error', () => resolve(false)); });
    try { return await deadline(exited, 180000, 'Sign-in timed out. Reconnect to try again.'); }
    finally { await stop(child); this.loginChild = null; }
  }
  /** @param {{ prompt: string, id: string, sessionId: string, images?: { data: string, mimeType: string }[] }} message */
  send({ prompt, id, sessionId, images = [] }) {
    if (sessionId !== this.sessionId) throw fail('The conversation changed. Review your draft and send again.');
    if (typeof id !== 'string' || !id || id.length > 100) throw fail('Missing message ID', 400);
    if (this.requests.has(id)) {
      if (this.requests.get(id) !== prompt) throw fail('Message ID already used', 400);
      return;
    }
    const asleep = this.status === 'asleep' || !!this.waking;
    if (!['ready', 'working'].includes(this.status) && !asleep) throw fail('Wait for the agent to connect');
    // A sleeping agent hasn't said yet; it is asked again on delivery.
    if (images.length && this.info && !this.info.agentCapabilities?.promptCapabilities?.image) throw fail(`${this.name} does not accept images`, 400);
    const row = { id, role: 'user', text: prompt, at: Date.now(), state: 'queued', agent: this.agent, sessionId,
      ...images.length && { images: images.map(image => saveImage(this.root, image)) } };
    this.pending.push(row);
    this.requests.set(id, prompt);
    try { this.save(); }
    catch (error) { this.pending.pop(); this.requests.delete(id); throw error; }
    if (this.requests.size > 1000) {
      const old = [...this.requests.keys()].find(key => !this.pending.some(r => r.id === key));
      if (old) this.requests.delete(old);
    }
    this.rows.push(row);
    this.diagnostic('prompt_queued', { promptId: id, pending: this.pending.length, chatStatus: this.status });
    this.changed();
    if (this.status === 'ready') this.next();
    else if (asleep) { this.sendOnReady = true; void this.wake(); }
  }
  // Start the oldest queued message. Called when a turn ends, or on send if the agent is idle.
  next() {
    const row = this.pending.find(r => r.state === 'queued');
    if (!row) return;
    if (this.status !== 'ready') return;
    const { id, text: prompt, images = [] } = row;
    // Queued while the agent slept, so only now is it known that it can't see them.
    if (images.length && !this.info?.agentCapabilities?.promptCapabilities?.image) {
      this.pending.splice(this.pending.indexOf(row), 1);
      row.state = 'dropped';
      this.error = `${this.name} does not accept images, so a message with images was not sent.${this.saveNote()}`;
      this.changed();
      return this.next();
    }
    const sessionId = this.sessionId;
    // It was added mid-reply, so move it after the output it waited for.
    const index = this.rows.indexOf(row);
    if (index !== -1) this.rows.splice(index, 1);
    this.rows.push(row);
    row.state = 'delivered'; row.at = Date.now();
    // Agents save a conversation once it has a message, so only then is it worth resuming.
    const first = !this.history.some(s => s.id === sessionId && s.agent === this.agent);
    if (first) {
      this.history = [{ id: sessionId, agent: this.agent, at: Date.now(), title: prompt.slice(0, 80) || 'Image' }, ...this.history].slice(0, 50);
    }
    // Journal intent before invoking the agent. Recovery treats this as uncertain,
    // never as permission to execute the same instruction twice.
    try { this.save(); }
    catch (error) { row.state = 'queued'; this.error = `Message remains queued: ${error.message}`; this.changed(); return; }
    this.onActivity({ type: 'prompt', label: prompt.slice(0, 200) || `${images.length} image${images.length === 1 ? '' : 's'}` });
    this.message = null; this.status = 'working'; this.error = null; this.signIn = false; this.changed();
    const generation = this.generation;
    // A resumed conversation replays its earlier user turns, so it was primed already.
    const primed = !this.includeContext || this.agent === 'claude' || this.rows.some(r => r.role === 'user' && r.id !== id && r.state !== 'queued');
    const blocks = [...primed ? [] : [{ type: 'text', text: `<fireside-context>\n${CONTEXT}\n</fireside-context>\n\n` }], ...prompt ? [{ type: 'text', text: prompt }] : []];
    let stopped = false, failed = false, outcome = 'transport_error';
    const diagnostics = { key: randomUUID(), promptId: id, sessionId, agent: this.agent, agentPid: this.child?.pid ?? null, started: Date.now(), signals: new Set(), errors: new Set(), firstUpdate: false };
    this.diagnosticTurn = diagnostics;
    startTurn(this.root, this.agent, diagnostics.key);
    this.diagnostic('prompt_started', { promptId: id, model: this.model()?.current ?? null,
      activeTurns: activeTurns(this.root), activeAgentTurns: activeTurns(this.root, this.agent), pending: this.pending.length });
    this.turn = Promise.resolve().then(() => {
      if (generation !== this.generation) throw fail('The conversation changed before delivery');
      blocks.push(...images.map(name => imageBlock(this.root, name)), ...images.length ? [imageNote(images)] : []);
      return this.connection.prompt({ sessionId, prompt: blocks });
    }).then(result => {
      if (generation !== this.generation) return;
      diagnostics.stopReason = result.stopReason;
      stopped = result.stopReason === 'cancelled';
      outcome = stopped ? 'cancelled' : diagnostics.errors.size ? 'agent_error' : 'completed';
      const index = this.pending.indexOf(row);
      this.pending.splice(index, 1);
      try { this.save(); }
      catch (error) { this.pending.splice(index, 0, row); throw error; }
      row.state = stopped ? 'interrupted' : 'answered';
    }).catch(error => {
      // Refused, not lost: it goes out by itself once the chat is signed in again.
      if (error.code === AUTH_REQUIRED && generation === this.generation) {
        outcome = 'auth_required'; row.state = 'queued'; this.sendOnReady = true;
        if (first) this.history = this.history.filter(s => s.id !== sessionId);
        return this.needSignIn(this.saveNote());
      }
      outcome = 'transport_error';
      this.diagnostic('prompt_transport_error', { promptId: id, sessionId, agent: diagnostics.agent, agentPid: diagnostics.agentPid, ...errorSignal(error) });
      if (generation === this.generation) {
        // It counts as sent. Whatever came back is in the thread, and the user decides
        // whether to send it again; nothing queued behind it goes out until then.
        failed = true; row.state = 'interrupted';
        this.pending.splice(this.pending.indexOf(row), 1);
        // The SDK reports an agent's thrown error as "Internal error", with the words in `data`.
        if (!this.connection.signal.aborted) this.error = error.data?.details || error.message;
        const note = this.saveNote();
        if (note) this.error = `${this.error || ''}${note}`.trim();
      }
    }).finally(() => {
      endTurn(diagnostics.key);
      this.diagnostic('prompt_finished', { promptId: id, sessionId, agent: diagnostics.agent, agentPid: diagnostics.agentPid, outcome, stopReason: diagnostics.stopReason ?? null, durationMs: Date.now() - diagnostics.started, errors: diagnostics.errors.size });
      if (this.diagnosticTurn === diagnostics) this.diagnosticTurn = null;
      if (generation !== this.generation) return;
      this.cancelPermissions();
      if (this.status === 'working' && !this.connection.signal.aborted) this.status = 'ready';
      this.message = null; this.remember(); this.changed();
      // Stop already handed the queue back; anything left waits for the next send.
      if (this.status === 'ready' && !stopped && !failed) this.next();
    });
  }
  unqueue(id, sessionId) {
    if (sessionId !== this.sessionId) throw fail('The conversation changed');
    const index = this.pending.findIndex(r => r.id === id && r.state === 'queued');
    if (index === -1) throw fail('This message was already sent');
    const [row] = this.pending.splice(index, 1);
    try { this.save(); }
    catch (error) { this.pending.splice(index, 0, row); throw error; }
    this.rows = this.rows.filter(r => r.id !== id);
    this.changed();
  }
  // Stop hands the waiting messages back to be edited and sent again, as Claude Code
  // and Codex do, rather than leaving them stuck behind a reply that will not come.
  release() {
    if (this.status !== 'working') return [];
    const released = this.pending.filter(r => r.state === 'queued');
    if (!released.length) return [];
    const kept = this.pending;
    this.pending = kept.filter(r => !released.includes(r));
    try { this.save(); }
    catch (error) { this.pending = kept; throw error; }
    this.rows = this.rows.filter(r => !released.includes(r));
    this.changed();
    return released.map(r => r.text);
  }
  async stop() {
    this.diagnostic('stop_requested', { promptId: this.diagnosticTurn?.promptId ?? null });
    this.cancelPermissions();
    if (!this.turn || this.status !== 'working') return;
    const sessionId = this.sessionId, generation = this.generation, turn = this.turn;
    try {
      // Bound cancellation itself as well as the prompt: an adapter can hang at
      // either point. Stop authorizes ending the process if it will not cancel.
      await deadline(Promise.resolve().then(() => this.connection.cancel({ sessionId })).then(() => turn),
        10000, 'The agent did not stop in time');
    } catch (error) {
      if (generation !== this.generation) return;
      await this.close();
      this.sessionId = sessionId;
      this.pending = this.pending.filter(row => { if (row.state !== 'delivered') return true; row.state = 'interrupted'; return false; });
      this.halt(`${error.message}. The agent connection was closed. Reconnect to continue.${this.saveNote()}`);
    }
  }
  async clear(sessionId) {
    if (!sessionId || sessionId !== this.sessionId) throw fail('The conversation changed. Try again.');
    // A chat whose agent won't come back can still start over.
    if (this.status === 'asleep') { this.requireEmptyQueue(); return this.connect(this.agent); }
    if (!['ready', 'working'].includes(this.status)) throw fail('Connect to an agent first');
    await this.stop();
    this.requireEmptyQueue();
    this.status = 'resetting'; this.changed();
    try { await this.newSession(); }
    catch (error) {
      if (error.code === AUTH_REQUIRED) return this.needSignIn();
      this.halt(error.data?.details || error.message);
    }
  }
  update({ sessionId, update: u }) {
    if (this.sessionId && sessionId !== this.sessionId) return;
    const turn = this.diagnosticTurn;
    if (turn && !turn.firstUpdate) {
      turn.firstUpdate = true;
      this.diagnostic('prompt_first_update', { promptId: turn.promptId, durationMs: Date.now() - turn.started, updateType: u.sessionUpdate });
    }
    const providerError = u._meta?.codex?.error;
    const failure = u._meta?.jetbrains?.air?.sessionFailure;
    if (providerError || failure) {
      const error = providerError || { message: failure.title };
      const signal = errorSignal(error);
      const retrying = providerError?.willRetry === true || failure?.severity === 'warning';
      const key = failure?.id || `${providerError?.turnId || ''}:${signal.errorFingerprint}:${!!providerError?.willRetry}`;
      if (!turn || !turn.signals.has(key)) {
        turn?.signals.add(key);
        if (!retrying) turn?.errors.add(key);
        this.diagnostic(retrying ? 'agent_retry' : 'agent_error', { promptId: turn?.promptId ?? null,
          source: 'acp_metadata', providerTurnId: typeof providerError?.turnId === 'string' ? providerError.turnId : null, willRetry: typeof providerError?.willRetry === 'boolean' ? providerError.willRetry : null,
          ...signal });
      }
    }
    if (u.sessionUpdate === 'config_option_update') this.configOptions = u.configOptions || [];
    else if (u.sessionUpdate === 'available_commands_update') this.commands = u.availableCommands || [];
    else if (u.sessionUpdate === 'usage_update') {
      this.usage = { context: u.used || 0, size: u.size || null, at: Date.now() };
      this.lastUsage = { sessionId: this.sessionId, usage: this.usage };
    }
    // A sentence the agent writes just before a tool call sometimes arrives as a
    // thought instead of a message. Dropping thoughts would lose it, so the few
    // that carry text are shown, as thoughts.
    else if (['agent_message_chunk', 'user_message_chunk', 'agent_thought_chunk'].includes(u.sessionUpdate) && (u.content?.type === 'text' && u.content.text || u.content?.type === 'image' && u.content.data)) {
      const role = u.sessionUpdate === 'user_message_chunk' ? 'user' : u.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'assistant';
      const key = u.messageId || role;
      if (!this.message || this.message.key !== key || this.message.role !== role) {
        this.message = { id: randomUUID(), key, role, text: '', at: Date.now() }; this.rows.push(this.message);
      }
      // A replayed conversation brings back the images sent in it.
      if (u.content.type === 'image') {
        try { this.message.images = [...this.message.images || [], saveImage(this.root, u.content)]; }
        catch (error) { this.message.text += `\n\n[An image here could not be kept: ${error.message}]`; }
      } else this.message.text += u.content.text;
      // Codex's adapter sends a terminal transport error as plain assistant text.
      // Match only a whole error message; never log arbitrary assistant content.
      if (turn && role === 'assistant' && /^exceeded retry limit, last status:\s*[45]\d{2}(?:[ \t]+[^\r\n]+)?$/i.test(this.message.text.trim()) && !turn.errors.has(this.message.id)) {
        turn.errors.add(this.message.id);
        this.diagnostic('agent_error', { promptId: turn.promptId, source: 'assistant_transport_error', ...errorSignal(this.message.text) });
      }
      // A replayed turn carries the primer; hide it once its closing tag arrives.
      if (role === 'user') this.message.text = this.message.text.replace(PRIMER, '');
    } else if (['tool_call', 'tool_call_update'].includes(u.sessionUpdate)) {
      this.message = null;
      let row = this.rows.find(r => r.id === u.toolCallId);
      if (!row) { row = { id: u.toolCallId, role: 'tool', at: Date.now() }; this.rows.push(row); }
      if (u.title) row.text = u.title;
      if (u.status) row.state = u.status;
      row.tool = u.kind || row.tool || 'tool';
      // ACP updates are partial. Omitted fields retain the last result; an
      // explicit empty array replaces it, as required by the protocol.
      for (const key of ['content', 'rawInput', 'rawOutput', 'locations']) {
        if (Object.hasOwn(u, key)) row[key] = u[key];
      }
      const done = ['completed', 'failed'].includes(row.state);
      const activityState = row.state === 'failed' ? 'failed' : done ? 'done' : 'start';
      const logged = this.toolActivity.get(row.id);
      if (!logged) this.toolActivity.set(row.id, this.onActivity({ type: 'tool', tool: row.tool, label: row.text || row.tool, state: activityState }));
      else if (logged.state !== activityState || (row.text && logged.label !== row.text)) {
        this.onActivity(Object.assign(logged, { label: row.text || logged.label, state: activityState }), logged);
      }
      if (done) this.toolActivity.delete(row.id);
    }
    const pending = new Set(this.pending);
    let remove = this.rows.filter(row => !pending.has(row)).length - 400;
    this.rows = this.rows.filter(row => pending.has(row) || remove-- <= 0);
    this.changed();
  }
  permission(params) {
    if (params.sessionId !== this.sessionId || this.status !== 'working') return { outcome: { outcome: 'cancelled' } };
    const id = randomUUID();
    return new Promise(resolve => {
      this.permissions.set(id, { resolve, view: { title: params.toolCall.title || 'Tool permission', toolCall: params.toolCall, options: params.options } });
      this.onActivity({ type: 'notice', label: `permission: ${params.toolCall.title || 'tool'}` });
      this.changed();
    });
  }
  approve(id, optionId, sessionId) {
    if (sessionId !== this.sessionId) throw fail('The conversation changed');
    const pending = this.permissions.get(id);
    if (!pending) throw fail('This permission request has expired');
    if (!pending.view.options.some(o => o.optionId === optionId)) throw fail('Unknown permission option', 400);
    this.permissions.delete(id); pending.resolve({ outcome: { outcome: 'selected', optionId } }); this.changed();
  }
  // A form the agent wants filled in mid-turn: Claude asking the user a
  // question, or an MCP server asking for input.
  question(params) {
    if (params.mode !== 'form' || params.sessionId !== this.sessionId || this.status !== 'working') return { action: 'cancel' };
    const id = randomUUID();
    return new Promise(resolve => {
      const fields = formFields(params.requestedSchema);
      // Codex's own questions come with a stock message; the fields say it all.
      const stock = Object.values(params.requestedSchema?.properties || {}).some(p => p?._meta?.codex);
      const message = stock ? '' : params.message || '';
      this.questions.set(id, { resolve, view: { message, fields } });
      this.onActivity({ type: 'notice', label: `question: ${(message || fields[0]?.description || 'the agent asked something').slice(0, 80)}` });
      this.changed();
    });
  }
  answer(id, content, sessionId) {
    if (sessionId !== this.sessionId) throw fail('The conversation changed');
    const pending = this.questions.get(id);
    if (!pending) throw fail('This question has expired');
    // No content means the user skipped: the agent is told so and carries on.
    const response = content ? { action: 'accept', content: formContent(pending.view.fields, content) } : { action: 'decline' };
    this.questions.delete(id); pending.resolve(response); this.changed();
  }
  cancelPermissions() {
    for (const p of this.permissions.values()) p.resolve({ outcome: { outcome: 'cancelled' } });
    this.permissions.clear();
    for (const q of this.questions.values()) q.resolve({ action: 'cancel' });
    this.questions.clear();
  }
  async close() {
    if (this.child) this.diagnostic('agent_close_requested');
    ++this.generation; this.cancelPermissions();
    await Promise.all([stop(this.child), stop(this.loginChild)]);
    this.child = null; this.connection = null; this.info = null; this.turn = null;
    this.sessionId = null; this.status = 'disconnected'; this.commands = []; this.configOptions = []; this.error = null; this.signIn = false; this.usage = null;
  }
}
