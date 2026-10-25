export default {
  render(p, { el, esc, fileURL }) {
    const ul = el('ul', 'filelist');
    for (const it of p.items || []) {
      const li = el('li');
      const a = el('a', null, esc(it.label || it.path));
      a.href = fileURL(it.path); a.target = '_blank';
      li.append(a);
      if (it.note) li.append(el('span', 'meta', esc(it.note)));
      ul.append(li);
    }
    return ul;
  },
};
