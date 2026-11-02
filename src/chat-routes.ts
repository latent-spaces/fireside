import type { ServerResponse } from 'node:http';
import type { RouteContext } from './route-context.ts';
import { body, json } from './http.ts';
import * as agents from './agents.mjs';
import { errorInfo } from './errors.ts';
import { imageFile } from './chat-images.mjs';
import { serveFile } from './app-assets.ts';

/** Agent connections are a host service; the chat UI is an ordinary component. */
/** Answer with an error's own message and status, or `status` when it has none. */
const failed = (res: ServerResponse, error: unknown, status: number) => json(res, { error: errorInfo(error).message }, errorInfo(error).status || status);

export function createChatRoutes({ ROOT, tabs, record, pushAcp, pushState, agentStatus }: RouteContext) {
  let adding = false;
  const routes: Record<string, (input: Awaited<ReturnType<typeof body>>, res: ServerResponse, u: URL) => unknown> = {
    // The ACP registry, read when the user opens "More agents…" and at no other time.
    'POST /api/agents/registry': async (input, res) => {
      try { return json(res, { agents: await agents.registry(ROOT) }); }
      catch (error) { return failed(res, error, 502); }
    },
    // Adding installs or probes, which can take a minute; one at a time is plenty.
    'POST /api/agents/add': async (input, res) => {
      if (adding) return json(res, { error: 'Another agent is being added. Try again when it finishes.' }, 409);
      const { registry, command } = input;
      if (typeof registry !== 'string' && typeof command !== 'string') return json(res, { error: 'Which agent?' }, 400);
      adding = true;
      try {
        const id = typeof registry === 'string' ? await agents.addFromRegistry(ROOT, registry) : await agents.addCommand(ROOT, command);
        record({ type: 'session', label: `you added ${agents.get(ROOT, id)?.name || id}` });
        pushAcp();
        return json(res, { ok: true, id });
      } catch (error) { return failed(res, error, 500); }
      finally { adding = false; }
    },
    'POST /api/agents/remove': async (input, res) => {
      const agent = typeof input.id === 'string' ? agents.get(ROOT, input.id) : null;
      if (!agent) return json(res, { error: 'That agent is already gone.' }, 404);
      if (tabs.tabs.some((tab) => tab.acp.agent === agent.id && tab.acp.status !== 'disconnected')) return json(res, { error: `Close the ${agent.name} chats first.` }, 409);
      try { agents.remove(ROOT, agent.id); }
      catch (error) { return failed(res, error, 500); }
      record({ type: 'session', label: `you removed ${agent.name}` });
      pushAcp();
      return json(res, { ok: true });
    },
    'POST /api/agent/*': async (input, res, query) => {
      const action = query.pathname.slice('/api/agent/'.length);

      // Opening, switching and closing chats belong to the strip, not to any one
      // conversation, so they run before a tab is resolved.
      if (action === 'open') {
        const opened = tabs.add();
        record({ type: 'session', label: 'you opened a new chat' });
        pushAcp(); pushState();
        return json(res, { ok: true, tab: opened.id });
      }
      if (action === 'select') {
        tabs.select(input.tab);
        agentStatus(); pushAcp(); pushState();
        return json(res, { ok: true });
      }

      // Everything else acts on one chat: the one named, or the one on screen.
      const found = input.tab ? tabs.get(input.tab) : tabs.active;
      if (!found) return json(res, { error: 'That chat is no longer open' }, 409);
      let tab = found, acp = tab.acp;

      if (action === 'permission') {
        acp.approve(input.id, input.optionId, input.sessionId);
        return json(res, { ok: true });
      }
      if (action === 'answer') {
        acp.answer(input.id, input.content, input.sessionId);
        return json(res, { ok: true });
      }
      // Typing in a sleeping chat starts its agent ahead of the message.
      if (action === 'wake') {
        void acp.wake();
        return json(res, { ok: true });
      }
      if (action === 'unqueue') {
        acp.unqueue(input.id, input.sessionId);
        return json(res, { ok: true });
      }
      if (tab.operation && !['cancel', 'close'].includes(action)) return json(res, { error: 'A session operation is already in progress' }, 409);
      if (!['connect', 'clear', 'stop', 'authenticate', 'disconnect', 'model', 'effort', 'setting', 'cancel', 'close'].includes(action)) return json(res, { error: 'Unknown agent action' }, 404);
      if (action === 'connect' && (typeof input.agent !== 'string' || !agents.get(ROOT, input.agent))) return json(res, { error: 'Unknown agent' }, 400);
      if (action !== 'close' && input.sessionId !== acp.sessionId) return json(res, { error: 'The conversation changed' }, 409);
      if (action === 'connect' && input.resume && !acp.history.some((s) => s.id === input.resume && s.agent === input.agent)) return json(res, { error: 'Unknown saved session' }, 400);
      const picker = action === 'model' ? { label: 'model', option: acp.model() } : action === 'effort' ? { label: 'effort level', option: acp.effort() }
        : action === 'setting' ? { label: 'setting', option: acp.settings().find((s) => s?.id === input.id) } : null;
      const asleep = acp.status === 'asleep' || !!acp.waking;
      if (picker && (!(acp.status === 'ready' || asleep) || !picker.option?.options.some((o: { value: unknown }) => o.value === input.value))) return json(res, { error: `This ${picker.label} is not available right now` }, 409);
      if (action === 'close' && input.force !== true) acp.requireEmptyQueue();
      // Switching agents in a chat that already has a conversation would swap it
      // out of sight. The other agent gets a chat of its own instead.
      if (action === 'connect' && !input.resume && acp.agent && acp.agent !== input.agent && acp.rows.some((row) => row.role === 'user')) {
        tab = tabs.add() as typeof found; acp = tab.acp;
        record({ type: 'session', label: 'you opened a new chat' });
        agentStatus(); pushAcp(); pushState();
      }
      const released = action === 'stop' ? acp.release() : [];
      const operation = tabs.begin(tab);
      // Session setup and browser sign-in outlive an HTTP request. Progress and
      // failures arrive through SSE and remain available on reconnect.
      (async () => {
        // A sleeping chat's settings belong to its agent: wake it, then apply them.
        let sessionId = input.sessionId;
        if (asleep && ['model', 'effort', 'setting'].includes(action)) { await acp.wake(); sessionId = acp.sessionId; }
        if (action === 'connect') {
          await acp.connect(input.agent, input.resume || null);
        } else if (action === 'close') {
          const name = acp.agent ? acp.name : 'new chat';
          await tabs.close(tab.id, { force: input.force === true });
          record({ type: 'session', label: `you closed the ${name} chat` });
          agentStatus(); pushAcp(); pushState();
        } else if (action === 'disconnect' || action === 'cancel') {
          await acp.disconnect();
          pushState();
        } else if (action === 'clear') await acp.clear(sessionId);
        else if (action === 'stop') await acp.stop();
        else if (action === 'model') await acp.setModel(input.value, sessionId);
        else if (action === 'effort') await acp.setEffort(input.value, sessionId);
        else if (action === 'setting') await acp.setSetting(input.id, input.value, sessionId);
        else await acp.authenticate(typeof input.methodId === 'string' ? input.methodId : undefined);
      })().catch((error) => { if (tab.operation === operation) { acp.error = errorInfo(error).message; acp.changed(); } })
        .finally(() => { tabs.end(tab, operation); });
      return json(res, { ok: true, released }, 202);
    },
    'POST /api/action': async (input, res) => {
      const { prompt, id, sessionId, images = [] } = input;
      if (!Array.isArray(images) || images.length > 8) return json(res, { ok: false, error: 'Send up to 8 images at a time' }, 400);
      if (typeof prompt !== 'string' || (!prompt.trim() && !images.length) || prompt.length > 100000) return json(res, { ok: false, error: 'empty prompt' }, 400);
      const tab = sessionId ? tabs.tabs.find((t) => t.acp.sessionId === sessionId) : tabs.active;
      if (!tab) return json(res, { error: 'The conversation changed. Review your draft and send again.' }, 409);
      if (!tab.acp.agent) return json(res, { error: 'Choose an agent for this chat first.' }, 409);
      if (tab.operation) return json(res, { error: 'Wait for the session operation to finish' }, 409);
      tab.acp.send({ prompt, id, sessionId, images });
      return json(res, { ok: true });
    },
    // An image a chat message carries, by the name its transcript keeps.
    'GET /api/chat-image': async (input, res, query) => {
      const file = imageFile(ROOT, query.searchParams.get('name'));
      if (!file) return json(res, { error: 'Unknown image' }, 404);
      return serveFile(res, file);
    },
  };
  return routes;
}
