import { agentControls, updateAgentControls, agentName } from './agent-controls.js';
import { appendDraft } from './drafts.js';
import { requestError } from './request-error.js';
import { imageFiles, readImage, BUDGET } from './images.js';

let chat;
export default {
  setup(ctx) {
    chat = createChat(ctx);
    return chat;
  },
  render(panel, ctx) { return chat.render(panel, ctx); },
  beforeClose(root, panel, ctx) {
    const draft = root?.querySelector('textarea')?.value;
    if (draft) ctx.command('rescueDraft', draft);
  },
};

function createChat(ctx) {
  const { el, esc, md, store, request, notice: composerNote, onDrag } = ctx;
  const trayForm = el('form', 'composer');
  trayForm.id = 'composer';
  const trayInput = el('textarea');
  trayInput.id = 'input'; trayInput.rows = 1; trayInput.spellcheck = false;
  trayInput.placeholder = 'Ask Claude to do something, or rearrange this desktop…';
  trayInput.setAttribute('aria-label', 'Message agent');
  const traySend = el('button', 'send', '➜');
  traySend.id = 'send'; traySend.type = 'submit'; traySend.disabled = true;
  traySend.setAttribute('aria-label', 'Send');
  trayForm.append(attachStrip(), attachButton(() => trayInput), trayInput, traySend);
  ctx.slots.tray.append(trayForm);
  ctx.onDispose(() => trayForm.remove());
  const activeInput = () => document.querySelector('.chat textarea') || trayInput;
  const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(n || 0));
  function rememberDraft(box) {
    if (!ctx.recovery) return false;
    const id = box === trayInput ? 'tray' : box.dataset.draftKey;
    if (!id) return false;
    if (id !== 'tray') drafts.set(id, box.value);
    return box.value ? ctx.recovery.write(`draft:${id}`, box.value) : ctx.recovery.remove(`draft:${id}`);
  }

  /** The chats that have an agent of their own; `except` leaves one tab out. */
  const liveChats = (except = null) => (store.tabs?.tabs || []).filter((t) => t.agent && t.id !== except);
  /** A prompt lands in the chat on screen. Says why when that chat can't take it. */
  function canSend() {
    if (store.acp?.agent) return true;
    composerNote(liveChats().length
      ? 'This chat has no agent yet. Choose one above, or switch to a chat that is already connected.'
      : 'Connect Claude or Codex in the Chat window first.');
    return false;
  }

  function arm(prompt, { immediate = false, label } = {}) {
    if (immediate) return dispatch(prompt, label);
    const box = activeInput();
    const start = appendDraft(box, prompt);
    autosize(box);
    box.focus();
    box.setSelectionRange(start, box.value.length);
    if (start) composerNote('Added below your existing draft. Review both before sending.');
    const btn = sendButton(box);
    if (btn) { btn.classList.add('armed'); btn.disabled = false; }
  }

  // --- images --------------------------------------------------------------------
  // Each draft has its own images, kept by the same key as its text.
  const pictures = new Map();
  const keyOf = (box) => box === trayInput ? 'tray' : box.dataset.draftKey;
  const attached = (box) => pictures.get(keyOf(box)) || [];
  const sendButton = (box) => box === trayInput ? traySend : box.closest('form')?.querySelector('.send');
  const hasContent = (box) => !!box.value.trim() || attached(box).length > 0;
  function setAttached(box, list) {
    if (list.length) pictures.set(keyOf(box), list); else pictures.delete(keyOf(box));
    showAttached(box);
  }
  /** Draw a draft's images above its text, each with a × to take it out again. */
  // The chat window can be drawn again while a message sends, so every box on
  // this draft is redrawn, not only the one the send started from.
  function showAttached(from) {
    const key = keyOf(from);
    const boxes = new Set([from, ...[...document.querySelectorAll('.chat textarea, #input')].filter((b) => keyOf(b) === key)]);
    boxes.forEach(drawAttached);
  }
  function drawAttached(box) {
    const strip = box.closest('form')?.querySelector('.attached');
    if (!strip) return;
    const list = attached(box);
    strip.hidden = !list.length;
    strip.replaceChildren(...list.map((image) => {
      const item = el('span', 'attached-item');
      const img = el('img');
      img.src = image.url; img.alt = 'Image to send';
      const x = el('button', 'attached-remove', '×');
      x.type = 'button'; x.title = 'Remove this image'; x.setAttribute('aria-label', 'Remove this image');
      x.addEventListener('click', () => { setAttached(box, attached(box).filter((i) => i !== image)); box.focus(); });
      item.append(img, x);
      return item;
    }));
    const btn = sendButton(box);
    if (btn) btn.disabled = !hasContent(box);
  }
  async function attach(box, files) {
    files = imageFiles(files);
    if (!files.length) return;
    if (store.acp?.agent && store.acp.status === 'ready' && !store.acp.images) return composerNote(`${agentName(store.acp)} does not accept images.`);
    const key = keyOf(box);
    for (const file of files) {
      let image;
      try { image = await readImage(file); }
      catch (error) { composerNote(error.message); continue; }
      const list = pictures.get(key) || [];
      if (list.length >= 8) { composerNote('A message can carry up to 8 images.'); break; }
      if (list.reduce((sum, i) => sum + i.data.length, image.data.length) > BUDGET) { composerNote('These images are too large to send together. Send some in another message.'); break; }
      pictures.set(key, [...list, image]);
    }
    if (keyOf(box) === key) showAttached(box);
    wakeOnTyping(box);
  }
  /** The paperclip shows while the chat's agent may take images. */
  function refreshAttach() {
    const off = store.acp?.status === 'ready' && !store.acp.images;
    document.querySelectorAll('.chat .attach, #composer .attach').forEach((btn) => { btn.hidden = off; });
  }
  function attachStrip() {
    const strip = el('div', 'attached');
    strip.hidden = true;
    return strip;
  }
  /** The paperclip, and the file picker behind it. */
  function attachButton(boxOf) {
    const btn = el('button', 'attach', '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    btn.type = 'button'; btn.title = 'Add images'; btn.setAttribute('aria-label', 'Add images');
    const picker = el('input');
    picker.type = 'file'; picker.accept = 'image/png,image/jpeg,image/gif,image/webp'; picker.multiple = true; picker.hidden = true;
    picker.addEventListener('change', () => { attach(boxOf(), picker.files); picker.value = ''; });
    btn.addEventListener('click', () => picker.click());
    btn.append(picker);
    return btn;
  }
  /** Paste into the box, or drop anywhere on `zone`. */
  function takeImages(box, zone, options) {
    box.addEventListener('paste', (e) => {
      const files = imageFiles(e.clipboardData?.files);
      if (!files.length) return;
      // A file copied in Finder also carries its name as text; take the image alone.
      e.preventDefault();
      attach(box, files);
    }, options);
    const carriesFiles = (e) => [...e.dataTransfer?.types || []].includes('Files');
    zone.addEventListener('dragover', (e) => {
      if (!carriesFiles(e)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; zone.classList.add('dropping');
    }, options);
    zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('dropping'); }, options);
    zone.addEventListener('drop', (e) => {
      zone.classList.remove('dropping');
      if (!carriesFiles(e)) return;
      e.preventDefault();
      attach(box, e.dataTransfer.files);
    }, options);
  }

  const submissions = new WeakMap();
  async function dispatch(prompt, label, box = activeInput()) {
    const draftKey = box.dataset.draftKey;
    const images = attached(box);
    if (!prompt?.trim() && !images.length) return;
    if (!canSend()) return;
    let submission = submissions.get(box);
    if (submission?.sending) return;
    if (!submission || submission.prompt !== prompt || submission.images !== images) {
      submission = { id: crypto.randomUUID(), prompt, images, sending: false };
      submissions.set(box, submission);
    }
    submission.sending = true;
    try {
      await request('/api/action', { prompt, label: label || prompt.slice(0, 60), id: submission.id, sessionId: store.acp?.sessionId,
        images: images.map(({ data, mimeType }) => ({ data, mimeType })) });
      if (box.value === prompt && box.dataset.draftKey === draftKey) { box.value = ''; autosize(box); rememberDraft(box); }
      if (attached(box) === images) setAttached(box, []);
      submissions.delete(box);
      const btn = sendButton(box);
      if (btn) { btn.classList.remove('armed'); btn.disabled = !hasContent(box); }
    } catch (error) {
      composerNote(`Message was not confirmed: ${error.message}. Your draft is preserved; retry to confirm delivery.`);
    } finally { submission.sending = false; }
  }


  const drawn = new WeakMap();   // message row -> the message it was drawn from
  /** Redraw chat threads that no longer match store.chat, leaving the reply box and its draft alone. */
  function redrawThreads() {
    // ACP rewrites a message in place as it streams, so identity alone is not
    // enough to tell a thread it has changed.
    const want = JSON.stringify(store.chat);
    document.querySelectorAll('[data-chat]').forEach((box) => {
      if (box.dataset.chatVersion === want) return;
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
      box.dataset.chatVersion = want;
      // Only the messages that changed are drawn again; while a reply streams
      // that is the last one, not the whole thread.
      const rows = new Map([...box.children].map((row) => [row.dataset.id, row]));
      const who = agentName(store.acp);
      box.replaceChildren(...store.chat.map((m) => {
        const version = JSON.stringify([who, !!store.acp?.agent, m]);
        const row = rows.get(String(m.id));
        if (row && drawn.get(row) === version) { rows.delete(String(m.id)); return row; }
        const fresh = chatBubble(m);
        drawn.set(fresh, version);
        return fresh;
      }));
      if (stick) box.scrollTop = box.scrollHeight;
    });
    refreshMarks();
  }

  /** Keep conversation-sized usage with the conversation it describes. */
  function renderChatUsage() {
    const u = store.usage;
    document.querySelectorAll('[data-chat-usage]').forEach((badge) => {
      // The agent's status line lives here too; keep it when redrawing.
      const status = badge.querySelectorAll('.agent-status');
      if (!u?.model) { badge.replaceChildren(...status); badge.removeAttribute('title'); return; }
      const amount = u.size ? `${fmtTokens(u.context)} / ${fmtTokens(u.size)}` : fmtTokens(u.context);
      badge.replaceChildren(
        ...status,
        el('span', 'chat-usage-model', esc(u.model)),
        el('span', 'chat-usage-tokens', `${amount} tokens`),
      );
      badge.title = u.size ? `${u.context.toLocaleString()} of ${u.size.toLocaleString()} tokens in context` : `${u.context.toLocaleString()} tokens in context`;
    });
  }

  // --- chat tabs ---------------------------------------------------------------
  // Several conversations share the chat window: Claude in one tab, Codex in the
  // next. Only the active one's thread is on screen; the strip says how the rest
  // are doing, and a tab you have not read yet wears a dot.

  const drafts = new Map();   // what you had typed in each chat, kept across switches
  let shownTab = null;

  const switchTab = (id) => request('/api/agent/select', { tab: id }).catch((error) => composerNote(error.message));

  /** Rebuild the strip in every open chat window, and move the draft with you. */
  function renderTabs() {
    const view = store.tabs;
    if (!view) return;
    if (shownTab && shownTab !== view.active) {
      const box = document.querySelector('.chat textarea');
      if (box) {
        drafts.set(shownTab, box.value);
        box.value = drafts.get(view.active) || '';
        box.dataset.draftKey = view.active;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        showAttached(box);
      }
    }
    // A close request can fail (for example, while it still has queued work).
    // Only discard a tab's draft once the server confirms the tab is gone.
    for (const id of drafts.keys()) if (!view.tabs.some(t => t.id === id)) { drafts.delete(id); ctx.recovery?.remove(`draft:${id}`); }
    for (const id of pictures.keys()) if (id !== 'tray' && !view.tabs.some(t => t.id === id)) pictures.delete(id);
    shownTab = view.active;
    // Until one chat has an agent there is nothing to switch between.
    const show = view.tabs.some((t) => t.agent);
    const signature = JSON.stringify(view);
    document.querySelectorAll('.chat-tabs').forEach((strip) => {
      strip.hidden = !show;
      if (strip.dataset.tabsVersion === signature) return;
      strip.dataset.tabsVersion = signature;
      const list = strip.querySelector('.chat-tab-list');
      list.replaceChildren(...view.tabs.map((t) => tabButton(t, view)));
      // The + sits outside the scroller, so it stays reachable however many
      // chats are open; only the tabs themselves scroll.
      strip.querySelector('.chat-tab-add')?.remove();
      strip.append(addTabButton());
      // With several chats open the strip scrolls; the one you are in stays in sight.
      list.querySelector('.chat-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  /** Tab rails use the same gesture lifecycle as windows and desktop icons. */
  function dragToScroll(rail, onDispose) {
    let panned = false;
    rail.addEventListener('click', (e) => {
      if (!panned) return;
      panned = false; e.stopPropagation(); e.preventDefault();
    }, true);
    onDispose(onDrag(rail, () => {
      panned = false;
      if (rail.scrollWidth <= rail.clientWidth) return;
      const at = rail.scrollLeft;
      return {
        move(dx) { rail.classList.add('dragging'); rail.scrollLeft = at - dx; },
        end(moved) { rail.classList.remove('dragging'); panned = moved; },
      };
    }, { buttons: true, threshold: 4, persist: false }));
    rail.addEventListener('wheel', (e) => {
      if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY) || rail.scrollWidth <= rail.clientWidth) return;
      e.preventDefault(); rail.scrollLeft += e.deltaY;
    }, { passive: false });
  }

  function tabButton(t, view) {
    const on = t.id === view.active;
    const item = el('div', 'chat-tab' + (on ? ' on' : '') + (t.unread ? ' unread' : ''));
    const pick = el('button', 'chat-tab-pick');
    pick.type = 'button';
    pick.setAttribute('role', 'tab');
    pick.setAttribute('aria-selected', String(on));
    pick.title = [t.title, t.error ? 'needs attention' : t.status].filter(Boolean).join(' — ');
    pick.append(el('span', 'chat-tab-dot'), el('span', 'chat-tab-name', esc(t.name)));
    pick.dataset.status = t.error ? 'error' : t.status;
    pick.addEventListener('click', () => on || switchTab(t.id));
    item.append(pick);
    if (view.tabs.length > 1 || t.error || t.pending) {
      const close = el('button', 'chat-tab-close', '×');
      close.type = 'button';
      close.title = `Close this ${t.name} chat`;
      close.setAttribute('aria-label', `Close this ${t.name} chat`);
      close.addEventListener('click', async () => {
        try { await request('/api/agent/close', { tab: t.id }); }
        catch (error) {
          if (error.status !== 409 || !/queued messages/.test(error.message)) return composerNote(error.message);
          if (!confirm('Close this chat and discard its pending messages? The agent will stop. Messages already delivered may have run.')) return;
          try { await request('/api/agent/close', { tab: t.id, force: true }); }
          catch (failure) { composerNote(failure.message); }
        }
      });
      item.append(close);
    }
    return item;
  }

  function addTabButton() {
    const add = el('button', 'chat-tab-add', '+');
    add.type = 'button';
    add.title = 'Open another chat, with either agent';
    add.setAttribute('aria-label', 'Open another chat');
    add.addEventListener('click', () => request('/api/agent/open', {}).catch((error) => composerNote(error.message)));
    return add;
  }

  function autosize(box = trayInput) {
    box.style.height = 'auto';
    // A composer behind the setup card is not on screen, so it measures nothing.
    // Leave it at its natural single line rather than freezing it at zero height.
    if (!box.scrollHeight) { box.style.overflowY = 'hidden'; return; }
    const max = box === trayInput ? 140 : 96;
    box.style.height = Math.min(box.scrollHeight, max) + 'px';
    box.style.overflowY = box.scrollHeight > max ? 'auto' : 'hidden';
  }

  /** Wire a textarea + button pair to the action queue. */
  // A sleeping chat takes a few seconds to start its agent and reload the
  // conversation. Typing starts that, so it is usually ready by Enter.
  let woken = null;
  function wakeOnTyping(box) {
    const chat = store.acp;
    if (chat?.status !== 'asleep') { woken = null; return; }
    if (!hasContent(box) || woken === chat.tabId) return;
    woken = chat.tabId;
    request('/api/agent/wake', { tab: chat.tabId }).catch(() => { woken = null; });
  }
  function wireComposer(box, btn, form, options) {
    box.addEventListener('input', () => { autosize(box); rememberDraft(box); btn.disabled = !hasContent(box); btn.classList.remove('armed'); wakeOnTyping(box); }, options);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); dispatch(box.value, null, box); }
    }, options);
    form.addEventListener('submit', (e) => { e.preventDefault(); dispatch(box.value, null, box); }, options);
  }



  /** What the mark in the corner of a message you sent means. */
  function markFor(m) {
    if (m.role !== 'user' || !m.state) return null;
    let cls, glyph, title;
    if (m.state === 'queued') {
      cls = 'queued'; glyph = '◷';
      title = 'waiting for the current turn to finish';
    } else if (m.state === 'dropped') {
      cls = 'dropped'; glyph = '⊘'; title = 'discarded — this was never delivered';
    } else {
      // Delivered or already answered: Claude has it. What happens next is
      // visible in the chat itself.
      cls = 'got'; glyph = '✓'; title = 'Sent to the session; execution is visible in the chat';
    }
    const n = el('span', 'mark ' + cls, glyph);
    n.title = title;
    return n;
  }

  const INLINE_END = /^(P|H1|H2|H3|H4|BLOCKQUOTE)$/;

  /** Put the mark at the end of the last line of text, so it reads as part of it. */
  function attachMark(bub, m) {
    bub.querySelector('.mark')?.remove();
    const mark = markFor(m);
    if (!mark) return;
    const last = bub.lastElementChild;
    (last && INLINE_END.test(last.tagName) ? last : bub).append(mark);
  }

  const isWaiting = (m) => m.role === 'user' && m.state === 'queued';

  /** Marks and pinning depend on live state, so refresh without rebuilding. */
  function refreshMarks() {
    const byId = new Map(store.chat.map((m) => [m.id, m]));
    document.querySelectorAll('.chat .msg[data-id]').forEach((row) => {
      const m = byId.get(row.dataset.id);
      if (!m) return;
      const bub = row.querySelector('.bub');
      if (bub) attachMark(bub, m);
      // While it is waiting it lives in the strip instead, so hide the copy that
      // sits in the transcript flow; unhide it the moment Claude has it.
      row.hidden = isWaiting(m);
    });

    const waiting = store.chat.filter(isWaiting);
    document.querySelectorAll('.chat .pinned-strip').forEach((strip) => {
      strip.hidden = !waiting.length;
      strip.replaceChildren(...waiting.map((m) => {
        const b = chatBubble(m);
        b.removeAttribute('data-id');   // the real one keeps the id
        b.hidden = false;
        return b;
      }));
    });
  }

  function chatBubble(m) {
    const row = el('div', 'msg ' + m.role);
    row.dataset.id = m.id;
    if (m.role === 'user' && m.state === 'queued') row.classList.add('pinned');
    if (m.role === 'divider') {
      row.append(el('span', 'dl', esc(m.text)));
      return row;
    }
    if (m.role === 'tool') {
      row.append(el('span', 'tl', esc(m.tool || 'tool')));
      // Only add the detail when it says something the tool name doesn't.
      if (m.text && m.text !== m.tool) row.append(el('span', 'td', esc(m.text)));
      return row;
    }
    const agent = agentName(store.acp) || 'Claude';
    const failure = requestError(m);
    if (failure) {
      row.classList.remove('assistant');
      row.classList.add('request-error');
      row.append(el('div', 'who', esc(`${agent} · request failed`)));
      const notice = el('div', 'bub request-error-notice');
      notice.setAttribute('role', 'note');
      notice.setAttribute('aria-label', `${agent} request error`);
      notice.append(el('strong', 'request-error-title', 'Agent request failed'));
      notice.append(el('p', 'request-error-status', esc(`HTTP ${failure.status}${failure.reason ? ' · ' + failure.reason : ''}`)));
      notice.append(el('p', '', 'The agent could not complete this request. You can try again later.'));
      const details = el('details');
      details.append(el('summary', '', 'Original error'), el('pre', '', esc(failure.original)));
      notice.append(details);
      row.append(notice);
      return row;
    }
    row.append(el('div', 'who', m.role === 'user' ? 'you' : m.role === 'thought' ? `${agent} · thinking` : agent));
    const bub = el('div', 'bub md', md(m.text));
    if (m.images?.length) {
      const shots = el('div', 'msg-images');
      for (const name of m.images) {
        const link = el('a');
        link.href = `/api/chat-image?name=${encodeURIComponent(name)}`; link.target = '_blank'; link.rel = 'noopener';
        const img = el('img');
        img.src = link.href; img.alt = 'Attached image'; img.loading = 'lazy';
        link.append(img);
        shots.append(link);
      }
      bub.prepend(shots);
    }
    attachMark(bub, m);
    row.append(bub);
    if (m.state === 'queued' && store.acp?.agent) {
      const x = el('button', 'unqueue', '×');
      x.title = 'Remove from queue';
      x.addEventListener('click', () => request('/api/agent/unqueue', { id: m.id, sessionId: store.acp.sessionId })
        .catch((error) => composerNote(`Could not remove the message: ${error.message}`)));
      row.append(x);
    }
    return row;
  }


  function render(_panel, { onDispose }) {
      const wrap = el('div', 'chat');
      const strip = el('div', 'chat-tabs');
      strip.hidden = true;   // until the tabs arrive, there is nothing to frame
      const list = el('div', 'chat-tab-list');
      list.setAttribute('role', 'tablist');
      list.setAttribute('aria-label', 'Chats');
      dragToScroll(list, onDispose);
      strip.append(list);
      wrap.append(strip);
      queueMicrotask(renderTabs);
      // A fresh tab next to a connected one is still asking which agent to open.
      wrap.append(agentControls(request, () => activeInput(), composerNote,
        () => liveChats(store.tabs?.active).length > 0, onDispose));
      queueMicrotask(() => updateAgentControls(store.acp));
      const usage = el('div', 'chat-usage');
      usage.dataset.chatUsage = '1';
      usage.setAttribute('aria-label', 'Conversation token usage');
      wrap.append(usage);
      queueMicrotask(renderChatUsage);
      const msgs = el('div', 'msgs');
      msgs.dataset.chat = '1';
      for (const m of store.chat) msgs.append(chatBubble(m));
      wrap.append(msgs);

      const pinned = el('div', 'pinned-strip');
      pinned.hidden = true;
      wrap.append(pinned);

      const form = el('form', 'cbar');
      const box = el('textarea');
      box.rows = 1;
      box.dataset.draftKey = store.tabs?.active || 'tray';
      box.value = drafts.get(store.tabs?.active) || '';
      appendDraft(box, trayInput.value);
      const copied = rememberDraft(box);
      trayInput.value = '';
      if (copied) rememberDraft(trayInput);
      box.placeholder = store.acp?.agent ? `Message ${agentName(store.acp)}…` : 'Reply to Claude…';
      box.setAttribute('aria-label', 'Message agent');
      box.spellcheck = false;
      const btn = el('button', 'send', '➜');
      btn.type = 'submit';
      // The tray's images move into the chat along with its text.
      if (pictures.has('tray') && box.dataset.draftKey !== 'tray') { pictures.set(box.dataset.draftKey, [...pictures.get(box.dataset.draftKey) || [], ...pictures.get('tray')]); pictures.delete('tray'); showAttached(trayInput); }
      btn.disabled = !hasContent(box);
      form.append(attachStrip(), attachButton(() => box), box, btn);
      wrap.append(form);
      wireComposer(box, btn, form);
      takeImages(box, wrap);
      queueMicrotask(() => { showAttached(box); refreshAttach(); });

      // Land at the newest message, the way a chat should open.
      queueMicrotask(() => { msgs.scrollTop = msgs.scrollHeight; });
      return wrap;
    }

  let restored = false;
  function restoreDrafts() {
    if (restored || !ctx.recovery) return;
    restored = true;
    for (const tab of store.tabs?.tabs || []) {
      const text = ctx.recovery.read(`draft:${tab.id}`);
      if (typeof text === 'string') drafts.set(tab.id, text);
    }
    const tray = ctx.recovery.read('draft:tray');
    if (typeof tray === 'string') appendDraft(trayInput, tray);
  }
  const controller = new AbortController();
  wireComposer(trayInput, traySend, trayForm, { signal: controller.signal });
  takeImages(trayInput, trayForm, { signal: controller.signal });
  ctx.provide('arm', arm);
  ctx.provide('focusComposer', () => activeInput().focus());
  ctx.provide('rescueDraft', (text) => { appendDraft(trayInput, text); autosize(trayInput); traySend.disabled = !trayInput.value.trim(); });
  ctx.provide('send', async (prompt, label) => {
    if (!prompt?.trim() || !canSend()) return false;
    try {
      await request('/api/action', { prompt, label: label || prompt.slice(0, 60), id: crypto.randomUUID(), sessionId: store.acp?.sessionId });
      return true;
    } catch (error) { composerNote(`Not sent: ${error.message}`); return false; }
  });
  ctx.onDispose(() => controller.abort());
  ctx.subscribe('snapshot', restoreDrafts);
  ctx.subscribe('chat', () => { updateAgentControls(store.acp); refreshAttach(); renderTabs(); renderChatUsage(); redrawThreads(); });
  ctx.subscribe('tabs', renderTabs);
  ctx.subscribe('desktop', () => { trayForm.hidden = !!document.querySelector('.chat textarea'); });
  restoreDrafts();
  autosize();
  return {
    render,
    prepareReload() {
      for (const input of document.querySelectorAll('.chat textarea, #input')) {
        if (input.value && !rememberDraft(input)) throw new Error('Your draft could not be saved');
      }
    },
  };
}
