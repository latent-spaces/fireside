// Redrawn whenever the server reports a change in the repository.
export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<span class="mk-row"><i class="mk-b" style="width:42%;height:8px;border-radius:99px;--c:color-mix(in srgb,var(--mint) 45%,transparent)"></i></span><span class="mk-row"><i class="mk-dot" style="--c:var(--mint)"></i><i class="mk-l" style="width:70%"></i></span><span class="mk-row"><i class="mk-dot" style="--c:var(--mint)"></i><i class="mk-l" style="width:52%"></i></span><span class="mk-row"><i class="mk-dot" style="--c:var(--clay)"></i><i class="mk-l" style="width:80%"></i></span><span class="mk-row"><i class="mk-dot" style="--c:var(--sun)"></i><i class="mk-l" style="width:46%"></i></span>',
  render(p, { el, esc, store: { git: g }, actionRow }) {
    const box = el('div', 'git');
    if (!g) return el('div', 'md', '<p>Reading the repository…</p>');
    if (!g.repo) {
      box.append(el('div', 'md', '<p>Not a git repository.</p>'));
      box.append(actionRow([{ label: 'Start one', prompt: 'Run git init in this project, add a sensible .gitignore, and make the first commit.' }]));
      return box;
    }

    const head = el('div', 'ghead');
    head.append(el('span', 'br', esc(g.branch || 'HEAD')));
    if (g.ahead) head.append(el('span', 'ab up', '↑' + g.ahead));
    if (g.behind) head.append(el('span', 'ab dn', '↓' + g.behind));
    if (g.upstream) head.append(el('span', 'up', esc(g.upstream)));
    if (g.fresh) head.append(el('span', 'up', 'no commits yet'));
    box.append(head);

    const groups = [
      ['staged', 'Staged', g.staged],
      ['unstaged', 'Changed', g.unstaged],
      ['untracked', 'Untracked', g.untracked],
    ].filter(([, , list]) => list?.length);

    if (!groups.length) {
      box.append(el('p', 'clean', '✓ working tree clean'));
    } else {
      for (const [cls, title, list] of groups) {
        box.append(el('div', 'gt', `${esc(title)} <b>${list.length}</b>`));
        const ul = el('ul', 'gfiles ' + cls);
        for (const f of list) {
          const li = el('li');
          li.append(el('span', 'c', esc(f.code || '?')), el('span', 'p', esc(f.path)));
          li.title = f.label || 'untracked';
          ul.append(li);
        }
        box.append(ul);
      }
    }

    if (g.commits?.length) {
      box.append(el('div', 'gt', 'Recent'));
      const ul = el('ul', 'glog');
      for (const c of g.commits) {
        const li = el('li');
        li.append(el('span', 'h', esc(c.hash)), el('span', 's', esc(c.subject)), el('span', 'w', esc(c.when)));
        ul.append(li);
      }
      box.append(ul);
    }

    const dirty = (g.staged?.length || 0) + (g.unstaged?.length || 0) + (g.untracked?.length || 0);
    box.append(actionRow([
      { label: 'Show me the diff', prompt: 'Walk me through everything that has changed in this repo right now — what each change does, not just the file names.', disabled: dirty ? null : 'nothing has changed' },
      { label: 'Commit', prompt: 'Stage and commit everything with a good message. Do not push.', tone: 'primary', disabled: dirty ? null : 'nothing to commit' },
    ]));
    return box;
  },
};
