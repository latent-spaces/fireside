// A template: tabs of sections of idea cards. The ideas are the panel's data,
// usually a file in .fireside/data, so changing them never touches this file.
// data: { review?: "prompt with {idea}", sections: [{ label, lede, ideas: [{ title, text, why, size, impact }] }] }
const REVIEW = 'Let\'s review this idea before building anything: "{idea}". Look at the relevant code, tell me how you\'d approach it, what it would touch, the risks, and a rough size. Don\'t write code yet.';
const chosen = new Map();   // panel id -> open tab, kept when new data redraws the window

export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<span class="mk-row" style="flex:1;align-items:stretch"><span class="mk-col" style="padding:4px;border:1px solid var(--line);border-radius:5px"><i class="mk-l" style="width:80%;--c:var(--ink-2)"></i><i class="mk-l" style="width:95%"></i><i class="mk-l" style="width:60%"></i><i class="mk-fill"></i><i class="mk-b" style="width:60%;height:7px;--c:var(--accent)"></i></span><span class="mk-col" style="padding:4px;border:1px solid var(--line);border-radius:5px"><i class="mk-l" style="width:80%;--c:var(--ink-2)"></i><i class="mk-l" style="width:95%"></i><i class="mk-l" style="width:60%"></i><i class="mk-fill"></i><i class="mk-b" style="width:60%;height:7px;--c:var(--accent)"></i></span></span>',
  render(p, { el, esc, actionRow }) {
    const { sections = [], review = REVIEW } = p.data || {};
    if (!sections.length) return el('div', 'md', `<p>${esc(p.dataError || 'No ideas yet.')}</p>`);
    const wrap = el('div', 'ideas');
    const bar = el('div', 'tabs');
    bar.setAttribute('role', 'tablist');
    wrap.append(bar);

    const open = (index) => {
      chosen.set(p.id, index);
      [...bar.children].forEach((tab, i) => tab.setAttribute('aria-selected', i === index));
      wrap.querySelectorAll('section').forEach((section, i) => { section.hidden = i !== index; });
    };

    sections.forEach((s, index) => {
      const ideas = s.ideas || [];
      const tab = el('button', 'tab', `${esc(s.label)}<span class="n">${ideas.length}</span>`);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.addEventListener('click', () => open(index));
      bar.append(tab);

      const section = el('section');
      if (s.lede) section.append(el('p', 'lede', esc(s.lede)));
      for (const idea of ideas) {
        const card = el('div', 'idea', `<h3>${esc(idea.title)}</h3><p>${esc(idea.text)}</p>`);
        const row = el('div', 'row', `<span class="why">${idea.why ? `↳ ${esc(idea.why)}` : ''}</span>`);
        const tags = el('span', 'tags', [idea.size && `size ${idea.size}`, idea.impact && `impact ${idea.impact}`]
          .filter(Boolean).map((tag) => `<span class="pill">${esc(tag)}</span>`).join(''));
        tags.append(actionRow([{ label: 'Review', prompt: review.replaceAll('{idea}', () => `${idea.title} — ${idea.text}`) }]));
        row.append(tags);
        card.append(row);
        section.append(card);
      }
      wrap.append(section);
    });

    open(Math.min(chosen.get(p.id) || 0, sections.length - 1));
    return wrap;
  },
};
