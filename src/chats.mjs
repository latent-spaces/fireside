import { writeJSON } from './storage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AcpChat } from './acp.mjs';
import { firesideDir } from './paths.ts';
import { fail } from './errors.ts';

// An agent left idle this long is stopped; its chat wakes on the next message.
// Claude's prompt cache lives an hour, so a wake after that pays nothing extra.
const IDLE = 60 * 60 * 1000;


/**
 * The desk holds several chats at once, one per tab, so Claude and Codex can be
 * open side by side. Each tab owns an AcpChat: its own agent process, its own
 * conversation, its own transcript. One tab is active — the one the chat window
 * shows, and whose token count the chat shows. The others keep working in the background.
 *
 * Saved conversations belong to the desk rather than to any one tab, so the list
 * lives here and is written once; a tab remembers only which conversation to
 * reopen. Every AcpChat reads and writes that through this object, so two chats
 * saving at the same moment never lose each other's history.
 *
 * Each tab's transcript is saved apart from that, one file per tab, so a desk
 * can show a conversation before -- or without -- starting its agent.
 */
export class ChatTabs {
  /** @param {{root: string, onChange?: (tab: import("./contracts.ts").ChatTab) => void, onActivity?: (entry: import("./contracts.ts").Activity, row?: import("./contracts.ts").Activity) => void, spawnAgent?: typeof import("node:child_process").spawn}} options */
  constructor({ root, onChange = () => {}, onActivity = () => {}, spawnAgent } = {}) {
    this.root = root; this.onChange = onChange; this.onActivity = onActivity; this.spawnAgent = spawnAgent;
    this.file = path.join(firesideDir(root), 'acp.json');
    this.transcripts = path.join(firesideDir(root), 'chats');
    this.sessions = [];
    this.reopen = new Map();   // tab id -> the conversation that tab last had
    /** @type {import("./contracts.ts").ChatTab[]} */
    this.tabs = [];
    this.sequence = 0;
    let saved = [];
    let active = null;
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.sessions = stored.sessions || [];
      // A desk written before tabs kept a single `preferred` conversation.
      saved = Array.isArray(stored.tabs) && stored.tabs.length ? stored.tabs
        : stored.preferred ? [{ id: randomUUID(), preferred: stored.preferred }] : [];
      active = stored.active || null;
    } catch {}
    for (const tab of saved) {
      if (!tab?.id || this.reopen.has(tab.id)) continue;
      this.reopen.set(tab.id, tab.preferred || null);
      this.open(tab.id, tab);
    }
    if (!this.tabs.length) this.open();
    this.activeId = this.get(active) ? active : this.tabs[0].id;
    // The tab on screen never sleeps: it may be running something its agent
    // does not report, like a loop or a background command.
    this.napping = setInterval(() => {
      for (const tab of this.tabs) {
        if (tab.id === this.activeId || tab.operation || tab.closing || Date.now() - (tab.acp.touched || 0) < IDLE) continue;
        tab.acp.sleep().catch(() => {});
      }
    }, 60 * 1000);
    this.napping.unref?.();
  }
  // --- the store every chat shares ------------------------------------------
  preferred(id) { return this.reopen.get(id) || null; }
  setPreferred(id, value) { this.reopen.set(id, value); }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tabs = this.tabs.map((tab) => ({ id: tab.id, preferred: this.preferred(tab.id),
      pending: tab.acp.pending }));
    writeJSON(this.file, { sessions: this.sessions, tabs, active: this.activeId || tabs[0]?.id || null });
  }
  transcript(id) { return path.join(this.transcripts, `${id}.json`); }
  remember(id, value) {
    fs.mkdirSync(this.transcripts, { recursive: true });
    writeJSON(this.transcript(id), value);
  }
  recall(id) {
    try { return JSON.parse(fs.readFileSync(this.transcript(id), 'utf8')); } catch { return null; }
  }
  forget(id) { try { fs.unlinkSync(this.transcript(id)); } catch {} }

  // --- the tabs --------------------------------------------------------------
  get(id) { return this.tabs.find((tab) => tab.id === id) || null; }
  get active() { return this.get(this.activeId) || this.tabs[0]; }
  /** True once any tab has an agent: the desk is driven from the browser, not from a terminal. */
  get live() { return this.tabs.some((tab) => tab.acp.agent); }
  /** The conversation the desk belongs to: the active one, or any other that has one. */
  get sessionId() { return this.active.acp.sessionId || this.tabs.find((tab) => tab.acp.sessionId)?.acp.sessionId || null; }

  open(id = randomUUID(), saved = {}) {
    const tab = { id, unread: false, operation: 0, seen: 0 };
    tab.acp = new AcpChat({
      root: this.root, id, store: this, spawnAgent: this.spawnAgent,
      pending: saved.pending,
      onActivity: (entry, row) => this.onActivity(entry, row, tab),
      onChange: () => this.changed(tab),
    });
    this.tabs.push(tab);
    return tab;
  }
  add() {
    const tab = this.open();
    this.select(tab.id);
    return tab;
  }
  select(id) {
    const tab = this.get(id);
    if (!tab) throw fail('That chat is no longer open', 400);
    this.activeId = id;
    tab.unread = false; tab.seen = tab.acp.rows.length;
    this.save();
    // A sleeping tab with nothing saved to show loads its conversation once looked at.
    if (tab.acp.status === 'asleep' && tab.acp.sessionId && !tab.acp.rows.length) void tab.acp.wake();
    return tab;
  }
  /** Close a tab and its agent. The conversation itself stays resumable. */
  async close(id, { force = false } = {}) {
    const tab = this.get(id);
    if (!tab) throw fail('That chat is no longer open', 400);
    if (!force) tab.acp.requireEmptyQueue();
    if (tab.closing) throw fail('This chat is already closing');
    tab.closing = true;
    try {
      // Fence pending callbacks before removing the tab, including crashed sessions.
      await tab.acp.close();
      const previousTabs = [...this.tabs], previousActive = this.activeId, preferred = this.preferred(id);
      const index = this.tabs.indexOf(tab);
      this.tabs.splice(index, 1);
      this.reopen.delete(id);
      this.forget(id);
      // A desk with no chat at all has nowhere to type, so one always remains.
      if (!this.tabs.length) this.open();
      if (this.activeId === id) this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)].id;
      try { this.save(); }
      catch (error) {
        this.tabs = previousTabs; this.activeId = previousActive; this.reopen.set(id, preferred);
        throw error;
      }
      return tab;
    } finally { tab.closing = false; }
  }
  /**
   * Bring back the conversation each saved tab last had. Every chat that can
   * comes back asleep, showing its saved transcript, so a desk with a dozen tabs
   * starts no agents at all. The tab on screen still connects when it has no
   * transcript to show yet.
   */
  async restore() {
    await Promise.all(this.tabs.map(async (tab) => {
      if (!this.preferred(tab.id)) return;
      if (tab.acp.rest(this.recall(tab.id), tab.id !== this.activeId)) return tab.acp.changed();
      const operation = this.begin(tab);
      try { await tab.acp.restore(); } finally { this.end(tab, operation); }
    }));
  }
  async closeAll() {
    clearInterval(this.napping);
    for (const tab of this.tabs) tab.acp.remember();
    await Promise.all(this.tabs.map((tab) => tab.acp.close()));
  }

  // One session operation at a time per tab; a later one supersedes its errors.
  begin(tab) { return (tab.operation = ++this.sequence); }
  end(tab, operation) { if (tab.operation === operation) tab.operation = 0; }

  changed(tab) {
    // A background chat that has said something new wears a dot until it is read.
    if (tab.id !== this.activeId && tab.acp.rows.length !== tab.seen) tab.unread = true;
    tab.seen = tab.acp.rows.length;
    this.onChange(tab);
  }
  /** What the tab strip shows: enough to name each chat and say how it is doing. */
  view() {
    const rows = this.tabs.map((tab) => {
      const { agent, sessionId, status, error } = tab.acp.held?.view || tab.acp;
      return {
        id: tab.id, agent: agent || null, name: agent ? tab.acp.name : 'New chat',
        title: this.sessions.find((s) => s.id === sessionId)?.title || null,
        status, pending: tab.acp.pending.length, error: !!error, unread: tab.unread && tab.id !== this.activeId,
      };
    });
    // Two chats with the same agent need more than its name to tell them apart.
    const seen = rows.map((row) => row.agent);
    for (const [index, row] of rows.entries()) {
      if (!row.agent || seen.indexOf(row.agent) === seen.lastIndexOf(row.agent)) continue;
      const words = row.title ? row.title.split(/\s+/).slice(0, 3).join(' ') : '';
      row.name = words ? `${row.name} · ${words}` : `${row.name} ${seen.slice(0, index + 1).filter((a) => a === row.agent).length}`;
    }
    return { active: this.activeId, tabs: rows };
  }
}
