// A template over a unified diff: a summary, then each file folded open or shut, with
// old and new line numbers, the changed words marked, unified or side by side.
// data: { diff: "output of git diff", title?: "what changed", note?: "one line" }
// With no data (as ＋ makes it) the window shows the project's own uncommitted changes
// and keeps them current: `source` names a repository below the project, `base` the
// commit or branch to compare against (default HEAD).
// Clicking line numbers (shift-click or drag for a range) drafts a question about them.
const opened = new Map();   // panel id -> Set of files the user opened or closed, kept across redraws
const BIG = 400;            // a diff longer than this starts with its files shut
const POLL = 3000;          // how often a live window asks git again, while it is in view
const NEW_FILES = 20;       // untracked files shown in a live window, at most
const ASK_LINES = 80;       // lines quoted into a drafted question, at most
const splitKey = 'fireside:diff:split';

// git quotes a path with accents or odd characters and writes its bytes as octal
// escapes; turn them back into text.
const unquote = (path) => !path.includes('\\') ? path : new TextDecoder().decode(Uint8Array.from(
  path.replace(/\\([0-7]{3}|.)/g, (_, c) => c.length === 3 ? String.fromCharCode(parseInt(c, 8)) : ({ t: '\t', n: '\n' })[c] ?? c),
  (ch) => ch.charCodeAt(0)));

export function parse(text) {
  const files = [];
  let file, hunk, oldNo = 0, newNo = 0;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      // A quoted header looks like: diff --git "a/caf\303\251" "b/caf\303\251"
      const head = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(line) || [, line.slice(11), line.slice(11)];
      file = { path: unquote(head[2]), from: unquote(head[1]), status: 'changed', add: 0, del: 0, hunks: [] }; files.push(file); hunk = null; continue;
    }
    // A merge's combined diff has a column per parent; it is named but not drawn.
    const merge = /^diff --(?:cc|combined) "?(.*?)"?$/.exec(line);
    if (merge) { file = { path: unquote(merge[1]), from: '', status: 'merge', add: 0, del: 0, hunks: [] }; files.push(file); hunk = null; continue; }
    if (!file || file.status === 'merge') continue;
    if (!hunk) {
      if (line.startsWith('new file')) file.status = 'new';
      else if (line.startsWith('deleted file')) file.status = 'deleted';
      else if (line.startsWith('rename from')) file.status = 'renamed';
      else if (line.startsWith('Binary files')) file.binary = true;
    }
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (at) { oldNo = +at[1]; newNo = +at[2]; hunk = { context: at[3], at: +at[2], lines: [] }; file.hunks.push(hunk); continue; }
    if (!hunk) continue;
    const mark = line[0], body = line.slice(1);
    if (mark === '+') { hunk.lines.push({ kind: 'ins', body, newNo: newNo++ }); file.add++; }
    else if (mark === '-') { hunk.lines.push({ kind: 'rm', body, oldNo: oldNo++ }); file.del++; }
    else if (mark === ' ') hunk.lines.push({ kind: 'same', body, oldNo: oldNo++, newNo: newNo++ });
    else if (mark === '\\') hunk.lines.push({ kind: 'note', body: line });
  }
  return files;
}

// A removed line followed by its replacement: mark the words between their common
// start and common end. A line rewritten from scratch is left plain.
const TOKEN = /\w+|\s+|[^\w\s]/g;
function markWords(rm, ins, esc) {
  const a = rm.body.match(TOKEN) || [], b = ins.body.match(TOKEN) || [];
  let s = 0, e = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const kept = a.slice(0, s).join('').length + a.slice(a.length - e).join('').length;
  if (kept < 0.3 * Math.max(rm.body.length, ins.body.length)) return;
  const draw = (t) => {
    const mid = t.slice(s, t.length - e).join('');
    return esc(t.slice(0, s).join('')) + (mid ? `<mark>${esc(mid)}</mark>` : '') + esc(t.slice(t.length - e).join(''));
  };
  rm.html = draw(a); ins.html = draw(b);
}

// Pair each run of removed lines with the added lines right after it, first with first.
function pairUp(lines, esc) {
  const rows = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === 'same' || lines[i].kind === 'note') { rows.push([lines[i], lines[i]]); i++; continue; }
    const rms = [], ins = [];
    while (lines[i]?.kind === 'rm') rms.push(lines[i++]);
    while (lines[i]?.kind === 'ins') ins.push(lines[i++]);
    for (let k = 0; k < Math.max(rms.length, ins.length); k++) {
      if (rms[k] && ins[k]) markWords(rms[k], ins[k], esc);
      rows.push([rms[k], ins[k]]);
    }
  }
  return rows;
}

// Five blocks showing the share of added and removed lines, as GitHub does.
const blocks = (add, del) => {
  const total = add + del, green = total ? Math.round(5 * add / total) : 0, red = total ? Math.min(5 - green, Math.ceil(5 * del / total)) : 0;
  return '<span class="dblocks">' + '<i class="p"></i>'.repeat(green) + '<i class="n"></i>'.repeat(red) + '<i></i>'.repeat(5 - green - red) + '</span>';
};
const split = (path) => { const at = path.lastIndexOf('/'); return [path.slice(0, at + 1), path.slice(at + 1)]; };
const sign = { ins: '+', rm: '−', same: '', note: '' };
const range = (a, b) => a === b ? `line ${a}` : `lines ${a}–${b}`;

// The question a selection drafts: where it is, and the lines themselves, since the
// agent cannot see this window.
function question(f, lines, title) {
  lines = lines.filter((l) => l.kind !== 'note');
  const now = lines.map((l) => l.newNo).filter((n) => n != null), was = lines.map((l) => l.oldNo).filter((n) => n != null);
  const where = now.length ? range(now[0], now.at(-1)) : `removed ${range(was[0], was.at(-1))}`;
  const quoted = lines.slice(0, ASK_LINES).map((l) => ({ ins: '+', rm: '-', same: ' ' })[l.kind] + l.body).join('\n')
    + (lines.length > ASK_LINES ? `\n… ${lines.length - ASK_LINES} more lines` : '');
  return { label: `Ask about ${where}`, prompt: `About ${where} of ${f.path}${title ? ` in "${title}"` : ''}:\n\n\`\`\`diff\n${quoted}\n\`\`\`\n\n` };
}

export default {
  preview: () => '<span class="mk-row"><i class="mk-l" style="width:50%;--c:var(--ink-2)"></i></span><span class="mk-row"><i class="mk-b" style="width:90%;height:6px;--c:color-mix(in srgb,var(--clay) 40%,transparent)"></i></span><span class="mk-row"><i class="mk-b" style="width:90%;height:6px;--c:color-mix(in srgb,var(--mint) 45%,transparent)"></i></span><span class="mk-row"><i class="mk-b" style="width:90%;height:6px;--c:color-mix(in srgb,var(--mint) 45%,transparent)"></i></span><span class="mk-row"><i class="mk-l" style="width:70%"></i></span>',
  render(p, { el, esc, actionRow, exec, onDispose }) {
    const live = p.data == null && !p.dataError;
    const base = p.base || 'HEAD';
    const toggled = opened.get(p.id) ?? opened.set(p.id, new Set()).get(p.id);
    let splitView = false;
    try { splitView = localStorage.getItem(splitKey) === '1'; } catch {}

    const box = el('div', 'diffw');
    const head = el('div', 'dhead');
    const titleRow = el('div', 'dtitle');
    const note = el('p', 'dnote');
    const tools = el('div', 'dtools');
    const filter = el('input', 'dfilter');
    filter.type = 'search'; filter.placeholder = 'Filter files'; filter.setAttribute('aria-label', 'Filter files');
    const button = (label, title) => { const b = el('button', 'dbtn', label); b.type = 'button'; b.title = title; return b; };
    const all = button('Open all', 'Open or close every file');
    const view = button('Split', 'Show old and new side by side');
    const refresh = button('↻', 'Read the changes again');
    tools.append(filter, view, all);
    if (live) tools.append(refresh);
    head.append(titleRow, note, tools);
    const list = el('div', 'dfiles');
    box.append(head, list);

    let sections = [];
    let dragging = null;   // the file whose line numbers are being dragged over
    const stop = () => { dragging = null; };
    addEventListener('mouseup', stop);
    onDispose(() => removeEventListener('mouseup', stop));
    const syncAll = () => {
      all.textContent = sections.every(({ sec }) => sec.open || sec.hidden) ? 'Close all' : 'Open all';
    };
    const applyFilter = () => {
      const q = filter.value.trim().toLowerCase();
      for (const { f, sec } of sections) sec.hidden = !!q && !f.path.toLowerCase().includes(q);
    };

    // A file's lines are drawn the first time it is opened, so a long diff stays quick.
    function build(entry) {
      const { f, sec, title } = entry;
      entry.built = true;
      sec.querySelector('.dcode')?.remove();
      sec.querySelector('.acts')?.remove();
      const code = el('div', 'dcode' + (splitView ? ' split' : ''));
      const flat = [];
      if (f.status === 'merge') code.append(el('p', 'dempty', 'Merge result, not drawn line by line'));
      else if (f.binary) code.append(el('p', 'dempty', 'Binary file'));
      else if (!f.hunks.length) code.append(el('p', 'dempty', f.status === 'renamed' ? 'Renamed, no other change' : 'No line changes'));
      const cell = (l, side) => {
        if (!l) return '<div class="dside gap"><span class="no"></span><span class="tx"></span></div>';
        const no = side === 'old' ? l.oldNo : l.newNo;
        return `<div class="dside ${l.kind}" data-i="${l.i}"><span class="no">${no ?? ''}</span><span class="tx">${l.html ?? (esc(l.body) || ' ')}</span></div>`;
      };
      for (const h of f.hunks) {
        for (const l of h.lines) { l.i = flat.length; flat.push(l); }
        const rows = pairUp(h.lines, esc);
        code.append(el('div', 'dhunk', `<span class="dat">line ${h.at}</span>${esc(h.context)}`));
        const html = splitView
          ? rows.map(([l, r]) => `<div class="drow">${cell(l, 'old')}${cell(r, 'new')}</div>`)
          : h.lines.map((l) => `<div class="dl ${l.kind}" data-i="${l.i}"><span class="no">${l.oldNo ?? ''}</span><span class="no">${l.newNo ?? ''}</span><span class="mk">${sign[l.kind]}</span><span class="tx">${l.html ?? (esc(l.body) || ' ')}</span></div>`);
        code.insertAdjacentHTML('beforeend', html.join(''));
      }
      const explain = { label: 'Explain this change', prompt: `Explain the change to ${f.path}${title ? ` in "${title}"` : ''}: what it does and why.` };
      let acts = actionRow([explain]);
      sec.append(code, acts);

      // Line numbers pick lines: a click, a shift-click to extend, or a drag.
      let from = null, to = null;
      const mark = () => {
        const [a, b] = from == null ? [-1, -2] : [Math.min(from, to), Math.max(from, to)];
        for (const row of code.querySelectorAll('[data-i]')) row.classList.toggle('sel', +row.dataset.i >= a && +row.dataset.i <= b);
        const next = actionRow(from == null ? [explain] : [question(f, flat.slice(a, b + 1), title), explain]);
        acts.replaceWith(next); acts = next;
      };
      const lineAt = (e) => e.target.closest('.no') && e.target.closest('[data-i]');
      code.addEventListener('mousedown', (e) => {
        const row = lineAt(e);
        if (!row) return;
        e.preventDefault();
        const i = +row.dataset.i;
        if (e.shiftKey && from != null) to = i;
        else if (from === i && to === i) from = to = null;
        else { from = to = i; dragging = code; }
        mark();
      });
      code.addEventListener('mouseover', (e) => {
        const row = dragging === code && lineAt(e);
        if (row && +row.dataset.i !== to) { to = +row.dataset.i; mark(); }
      });
    }

    function draw({ diff, title, note: line, empty }) {
      const files = parse(diff);
      const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
      const startOpen = add + del <= BIG;
      titleRow.innerHTML = `${title ? `<b>${esc(title)}</b>` : ''}${files.length ? `<span class="dsum">${files.length} file${files.length === 1 ? '' : 's'} <span class="dpos">+${add}</span> <span class="dneg">−${del}</span></span>` : ''}`;
      note.textContent = line || '';
      note.hidden = !line;
      filter.hidden = all.hidden = files.length < 2;
      view.hidden = !files.length;
      view.textContent = splitView ? 'Unified' : 'Split';
      view.title = splitView ? 'Show changes in one column' : 'Show old and new side by side';
      if (!files.length) {
        sections = [];
        list.replaceChildren(el('div', 'md', `<p>${esc(empty)}</p>`));
        return;
      }
      sections = files.map((f) => {
        const [dir, name] = split(f.path);
        const sec = el('details', 'dfile ' + f.status);
        const stat = f.status === 'changed' ? '' : f.status;
        sec.append(el('summary', null, `<span class="dstat">${esc(stat)}</span><span class="dpath">${dir ? `<span class="dir">${esc(dir)}</span>` : ''}<span class="nm">${esc(name)}</span>${f.status === 'renamed' ? `<span class="dir"> ← ${esc(f.from)}</span>` : ''}</span><span class="dn"><span class="dpos">+${f.add}</span> <span class="dneg">−${f.del}</span>${blocks(f.add, f.del)}</span>`));
        const entry = { f, sec, title, built: false };
        sec.open = startOpen !== toggled.has(f.path);
        if (sec.open) build(entry);
        sec.addEventListener('toggle', () => {
          if (sec.open === startOpen) toggled.delete(f.path); else toggled.add(f.path);
          if (sec.open && !entry.built) build(entry);
          syncAll();
        });
        return entry;
      });
      list.replaceChildren(...sections.map(({ sec }) => sec));
      applyFilter();
      syncAll();
    }

    all.addEventListener('click', () => {
      const open = all.textContent === 'Open all';
      for (const { sec } of sections) if (!sec.hidden) sec.open = open;
    });
    filter.addEventListener('input', () => { applyFilter(); syncAll(); });
    view.addEventListener('click', () => {
      splitView = !splitView;
      try { localStorage.setItem(splitKey, splitView ? '1' : '0'); } catch {}
      view.textContent = splitView ? 'Unified' : 'Split';
      view.title = splitView ? 'Show changes in one column' : 'Show old and new side by side';
      for (const entry of sections) {
        entry.built = false;
        if (entry.sec.open) build(entry);
      }
    });

    if (!live) {
      const { diff, title, note: line } = p.data || {};
      draw({ diff, title, note: line, empty: p.dataError || (diff && !parse(diff).length ? 'This is not a unified diff.' : 'No changes to show yet.') });
      return box;
    }

    // Live: the working tree against `base`, plus new files git does not track yet.
    const cwd = p.source || '.';
    const title = base === 'HEAD' ? 'Uncommitted changes' : `Changes since ${base}`;
    let last = null, busy = false;
    async function read() {
      const run = (cmd) => exec(cmd, { cwd, timeout: 10000 });
      const changed = await run(['git', 'diff', '--no-color', '--no-ext-diff', base]);
      if (changed.code !== 0 || changed.error) return { error: (changed.stderr || changed.error || '').trim().split('\n').pop() || 'git diff failed' };
      const others = await run(['git', 'ls-files', '--others', '--exclude-standard', '-z']);
      const fresh = (others.stdout || '').split('\0').filter(Boolean);
      const shown = await Promise.all(fresh.slice(0, NEW_FILES).map((f) => run(['git', 'diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', f])));
      const notes = [];
      if (changed.stdout.length >= 1e6) notes.push('Too long to show whole: the first files are left out.');
      if (fresh.length > NEW_FILES) notes.push(`${fresh.length - NEW_FILES} more new files not shown.`);
      return { diff: [changed.stdout, ...shown.map((r) => r.stdout || '')].join('\n'), note: notes.join(' ') };
    }
    async function update() {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const got = await read().catch((error) => ({ error: error.message }));
        const key = JSON.stringify(got);
        if (key === last) return;
        last = key;
        draw(got.error ? { title, empty: got.error } : { title, ...got, empty: base === 'HEAD' ? '✓ No uncommitted changes.' : `✓ No changes since ${base}.` });
      } finally { busy = false; }
    }
    refresh.addEventListener('click', () => { last = null; update(); });
    draw({ title, empty: 'Reading the changes…' });
    update();
    const timer = setInterval(() => { if (box.isConnected) update(); }, POLL);
    onDispose(() => clearInterval(timer));
    return box;
  },
};
