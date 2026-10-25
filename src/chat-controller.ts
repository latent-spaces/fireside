import { AcpChat, BUSY, deadline } from './acp.mjs';
import { ChatTabs } from './chats.mjs';
import { randomUUID } from 'node:crypto';
import type { Activity } from './contracts.ts';

// Start an isolated, minimal turn so the account's five-hour window begins
// without changing the model or transcript of any chat the user has open.
export async function runProviderWake(ROOT: string, provider: string) {
  const store = { sessions: [], preferred: () => null, setPreferred: () => {}, save: () => {} };
  const wake = new AcpChat({ root: ROOT, id: 'usage-wake', store, includeContext: false });
  try {
    await wake.connect(provider.toLowerCase());
    if (wake.status !== 'ready') throw new Error(wake.error || `Could not connect to ${provider}`);
    const picker = wake.model();
    const cheap = picker?.options
      .map(option => {
        const name = `${option.value} ${option.name}`;
        return { ...option, rank: provider === 'Claude' ? (/haiku/i.test(name) ? 0 : 99) : /mini/i.test(name) ? 0 : /nano/i.test(name) ? 1 : /luna/i.test(name) ? 2 : 99 };
      })
      .sort((a, b) => a.rank - b.rank)[0];
    if (!cheap || cheap.rank === 99) throw new Error(`No low-cost ${provider} model is available for this account`);
    if (picker!.current !== cheap.value) {
      await wake.setModel(cheap.value, wake.sessionId);
      if (wake.model()?.current !== cheap.value) throw new Error(wake.error || `Could not select ${cheap.name}`);
    }
    wake.send({ prompt: 'Reply with exactly "Awake." Do not use tools.', id: randomUUID(), sessionId: wake.sessionId });
    await deadline(wake.turn, 60_000, `${provider} took too long to wake up. Refresh usage before retrying.`);
    if (wake.error) throw new Error(wake.error);
    return { model: cheap.name || cheap.value };
  } finally {
    await wake.close();
  }
}

export function createChatController(ROOT: string, broadcast: (event: string, data: unknown) => void, record: (entry: Activity) => unknown, connected: (agent: string) => void, setStatus: (text: string, tone: string) => void) {
  let timer: NodeJS.Timeout | undefined;
  let activeChanged = false;
  // Several chats share the desk; the active one is the chat the desktop shows.
  const tabs = new ChatTabs({
    root: ROOT,
    onActivity: (entry, row) => row ? broadcast('activity-update', row) : record(entry),
    onChange: (tab) => {
      agentStatus();
      if (tab.acp.status === 'ready' && tab.acp.sessionId) connected(tab.acp.agent);
      if (tab.id === tabs.activeId && !activeChanged) {
        clearTimeout(timer);
        activeChanged = true;
        timer = setTimeout(pushAcp, 40);
      } else if (!timer) {
        timer = setTimeout(() => { timer = undefined; broadcast('tabs', { tabs: tabs.view() }); }, 150);
      }
    },
  });
  const active = () => tabs.active.acp;   // the chat the desk is showing
  /** A chat mid-reply or mid-setup, which replacing its agent would cut off. */
  const busyChat = () => tabs.tabs.find((tab) => tab.operation || BUSY.includes(tab.acp.status));

  // The thread draws a tool call as its name, label and state. What the tool read
  // or printed stays on the server: megabytes of it would stall the stream on a tab switch.
  const view = () => ({ acp: active().view(), chat: active().shown, tabs: tabs.view(), usage: active().usageView() });
  function pushAcp() {
    clearTimeout(timer); timer = undefined; activeChanged = false;
    broadcast('acp', view());
  }
  /** The menu bar names the chat you are watching, and says who else is working. */
  function agentStatus() {
    if (!tabs.live) return;
    const chat = active();
    const elsewhere = tabs.tabs.filter((tab) => tab.id !== tabs.activeId && tab.acp.status === 'working').map((tab) => tab.acp.agent);
    const label = chat.agent ? `${chat.agent} · ${chat.status}` : 'new chat';
    const tone = chat.status === 'working' || elsewhere.length ? 'busy' : chat.error ? 'attention' : 'idle';
    setStatus(elsewhere.length ? `${label} · ${elsewhere.join(', ')} working` : label, tone);
  }

  return { tabs, view, busyChat, pushAcp, agentStatus };
}
