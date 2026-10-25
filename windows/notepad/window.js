// A notepad of small tasks. Jot one down, edit it, and send it to Claude when
// it's ready. The window saves its own list to .fireside/data/<panel-id>.json.
// data: { prompt?: "text with {task}", items: [{ id, text, at, sent? }] }
const pending = new Map();   // unacknowledged edits, retained across close/reopen
const focus = new Map();     // panel id -> caret in the jot box, kept across redraws
const editing = new Map();   // panel id -> { id, text } of the task being edited

function acknowledgeEcho(entry) {
  if (entry.saved && !entry.saving && !entry.error && pending.get(entry.panelId) === entry &&
      JSON.stringify(entry.items) === JSON.stringify(entry.observedItems)) pending.delete(entry.panelId);
}

// One write at a time per panel, including across renderer replacements. A newer
// edit waits for the older write, so a late response cannot overwrite it.
function flush(entry) {
  if (entry.inFlight) return entry.inFlight;
  entry.inFlight = saveEdits(entry).finally(() => { delete entry.inFlight; });
  return entry.inFlight;
}

async function saveEdits(entry) {
  if (entry.saving) return;
  entry.saving = true; entry.error = null; entry.notify();
  try {
    while (true) {
      const revision = entry.revision;
      await entry.save(entry.items);
      if (entry.revision === revision) {
        entry.saved = true;
        entry.localError = entry.clearBackup() ? null : 'Saved to the project, but the browser backup could not be cleared. Review any recovered notes after reloading.';
        break;
      }
    }
  } catch (error) {
    entry.error = error.message || 'Save failed';
  } finally {
    entry.saving = false;
    // The file watcher may echo the write before its HTTP response arrives.
    // Reconsider that snapshot now instead of waiting for an identical redraw.
    acknowledgeEcho(entry);
    entry.notify();
  }
}

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
};

export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<i class="mk-b" style="height:10px;flex:none"></i><span class="mk-row"><i class="mk-b" style="width:6px;height:6px;border-radius:2px;border:1px solid var(--ink-3);background:none"></i><i class="mk-l" style="width:76%"></i></span><span class="mk-row"><i class="mk-b" style="width:6px;height:6px;border-radius:2px;border:1px solid var(--ink-3);background:none"></i><i class="mk-l" style="width:58%"></i></span><span class="mk-row"><i class="mk-b" style="width:6px;height:6px;border-radius:2px;border:1px solid var(--ink-3);background:none"></i><i class="mk-l" style="width:84%"></i></span><span class="mk-row"><i class="mk-b" style="width:6px;height:6px;border-radius:2px;border:1px solid var(--ink-3);background:none"></i><i class="mk-l" style="width:40%"></i></span>',
  async prepareReload(_root, panel) {
    const entry = pending.get(panel.id);
    if (!entry) return;
    await flush(entry);
    if (entry.error) throw new Error(entry.error);
    if (entry.localError) throw new Error(entry.localError);
  },
  render(p, { el, esc, save, send, recovery }) {
    const backupKey = `note:${p.id}`;
    const jotKey = `note-draft:${p.id}`;
    const editKey = `note-edit:${p.id}`;
    let local = pending.get(p.id);
    if (!local && recovery) {
      const backup = recovery.read(backupKey);
      if (Array.isArray(backup?.items)) {
        if (JSON.stringify(backup.items) === JSON.stringify(p.data?.items || [])) recovery.remove(backupKey);
        else {
          local = { items: backup.items, revision: 0, saved: false,
            error: 'Recovered local edits. Review them, then retry saving to the project' };
          pending.set(p.id, local);
        }
      }
    }
    // Keep successful optimistic edits until the server actually echoes them;
    // reopening against an older snapshot must not make them disappear.
    if (local?.saved && !local.saving && !local.error && JSON.stringify(local.items) === JSON.stringify(p.data?.items || [])) {
      pending.delete(p.id); local = null;
    }
    let items = local?.items || (p.data?.items || []);
    if (!editing.has(p.id)) {
      const edit = recovery?.read(editKey);
      if (typeof edit?.text === 'string' && items.some(item => item.id === edit.id && !item.sent)) editing.set(p.id, edit);
    }
    const template = p.data?.prompt || '{task}';
    const sending = new Set();

    const wrap = el('div', 'notepad');
    if (p.dataError && !/not found/.test(p.dataError)) wrap.append(el('p', 'err', esc(p.dataError)));

    const bind = (entry) => {
      entry.panelId = p.id;
      entry.observedItems = p.data?.items || [];
      entry.notify = draw;
      entry.save = (items) => save(p.id, { ...(p.data || {}), items });
      entry.clearBackup = () => !recovery || recovery.remove(backupKey);
      return entry;
    };
    if (local) bind(local);

    const commit = (next) => {
      items = next;
      const entry = bind(pending.get(p.id) || { revision: 0 });
      entry.items = next;
      entry.revision++; entry.saved = false;
      const backedUp = recovery?.write(backupKey, { items: next }) ?? false;
      entry.localError = backedUp ? null : 'Browser backup unavailable. Keep this page open or copy your edits until the project save succeeds.';
      pending.set(p.id, entry);
      draw();
      void flush(entry);
      return backedUp;
    };

    // --- the jot box ---
    const jot = el('textarea', 'jot');
    jot.rows = 2;
    jot.placeholder = 'Jot a small task… Enter adds it, Shift+Enter for a new line';
    jot.spellcheck = true;
    const draft = recovery?.read(jotKey);
    if (typeof draft === 'string') jot.value = draft;
    const remember = () => focus.set(p.id, [jot.selectionStart, jot.selectionEnd]);
    jot.addEventListener('focus', remember);
    jot.addEventListener('keyup', remember);
    jot.addEventListener('input', () => {
      remember();
      if (jot.value) recovery?.write(jotKey, jot.value);
      else recovery?.remove(jotKey);
    });
    jot.addEventListener('blur', () => setTimeout(() => { if (jot.isConnected) focus.delete(p.id); }));
    jot.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      const text = jot.value.trim();
      if (!text) return;
      jot.value = '';
      if (commit([...items, { id: crypto.randomUUID(), text, at: Date.now() }])) recovery?.remove(jotKey);
    });

    const list = el('div', 'list');
    wrap.append(jot, list);

    const sendTasks = async (tasks) => {
      tasks = tasks.filter((t) => !sending.has(t.id));
      if (!tasks.length) return;
      tasks.forEach((t) => sending.add(t.id));
      draw();
      const sent = new Map();
      for (const t of tasks) {
        if (await send(template.replaceAll('{task}', () => t.text), t.text.slice(0, 60))) sent.set(t.id, Date.now());
        else break;   // detached or failing: the rest stay put
      }
      tasks.forEach((t) => sending.delete(t.id));
      if (sent.size) commit(items.map((t) => (sent.has(t.id) ? { ...t, sent: sent.get(t.id) } : t)));
      else draw();
    };

    function taskRow(t) {
      const row = el('div', 'task' + (t.sent ? ' sent' : ''));
      const edit = editing.get(p.id);
      if (!t.sent && edit?.id === t.id) {
        const box = el('textarea', 'edit');
        box.value = edit.text;
        box.rows = Math.min(6, edit.text.split('\n').length + 1);
        const done = (keep) => {
          if (editing.get(p.id)?.id !== t.id) return;
          editing.delete(p.id);
          const text = box.value.trim();
          if (!keep || text === t.text) { recovery?.remove(editKey); return draw(); }
          if (commit(text ? items.map((x) => (x.id === t.id ? { ...x, text } : x)) : items.filter((x) => x.id !== t.id))) recovery?.remove(editKey);
        };
        box.addEventListener('input', () => { edit.text = box.value; recovery?.write(editKey, edit); });
        box.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); done(true); }
          if (e.key === 'Escape') { e.preventDefault(); done(false); }
        });
        box.addEventListener('blur', () => setTimeout(() => { if (box.isConnected) done(true); }));
        row.append(box);
        queueMicrotask(() => { box.focus(); box.setSelectionRange(box.value.length, box.value.length); });
        return row;
      }

      const text = el('div', 'text', esc(t.text));
      if (!t.sent) {
        text.title = 'Click to edit';
        text.addEventListener('click', () => { editing.set(p.id, { id: t.id, text: t.text }); draw(); });
      }
      const meta = el('div', 'meta', esc(t.sent ? `sent ${ago(t.sent)}` : ago(t.at)));
      const acts = el('div', 'acts');
      const button = (cls, label, title, onClick) => {
        const b = el('button', cls, label);
        b.type = 'button';
        b.title = title;
        b.addEventListener('click', onClick);
        acts.append(b);
        return b;
      };
      if (t.sent) {
        button('ghost', '↺', 'Back to the list', () => commit(items.map((x) => (x.id === t.id ? { id: x.id, text: x.text, at: x.at } : x))));
      } else {
        const go = button('go', sending.has(t.id) ? 'Sending…' : 'Send ➜', 'Send this task to Claude', () => sendTasks([t]));
        go.disabled = sending.has(t.id);
      }
      button('ghost del', '✕', 'Delete', () => commit(items.filter((x) => x.id !== t.id)));
      row.append(text, meta, acts);
      return row;
    }

    function draw() {
      const entry = pending.get(p.id);
      if (entry) items = entry.items;
      const todo = items.filter((t) => !t.sent);
      const done = items.filter((t) => t.sent).sort((a, b) => b.sent - a.sent);
      const parts = [];

      if (entry?.error) {
        const error = el('div', 'save-error');
        error.setAttribute('role', 'alert');
        error.append(el('p', '', esc(`Not saved: ${entry.error}.`)));
        const retry = el('button', 'go', 'Retry save');
        retry.type = 'button';
        retry.addEventListener('click', () => { void flush(entry); });
        error.append(retry); parts.push(error);
      } else if (entry?.saving) {
        const status = el('p', 'save-status', 'Saving…');
        status.setAttribute('role', 'status'); parts.push(status);
      }
      if (entry?.localError) {
        const warning = el('p', 'save-error', esc(entry.localError));
        warning.setAttribute('role', 'alert'); parts.push(warning);
      }

      const head = el('div', 'head', `<span>${todo.length ? `${todo.length} to do` : 'Nothing waiting'}</span>`);
      if (todo.length > 1) {
        const all = el('button', 'go', 'Send all ➜');
        all.type = 'button';
        all.title = 'Send every task, one message each';
        all.disabled = todo.every((t) => sending.has(t.id));
        all.addEventListener('click', () => sendTasks(todo));
        head.append(all);
      }
      parts.push(head);

      if (!todo.length && !done.length) parts.push(el('p', 'empty', 'Small ideas go here. When one is ready, send it and Claude picks it up.'));
      parts.push(...todo.map(taskRow));

      if (done.length) {
        const sentHead = el('div', 'head sub', `<span>Sent · ${done.length}</span>`);
        const clear = el('button', 'ghost', 'Clear');
        clear.type = 'button';
        clear.title = 'Remove sent tasks';
        clear.addEventListener('click', () => commit(items.filter((t) => !t.sent)));
        sentHead.append(clear);
        parts.push(sentHead, ...done.map(taskRow));
      }
      list.replaceChildren(...parts);
    }

    draw();
    const caret = focus.get(p.id);
    if (caret && !editing.has(p.id)) queueMicrotask(() => { jot.focus(); jot.setSelectionRange(...caret); });
    return wrap;
  },
};
