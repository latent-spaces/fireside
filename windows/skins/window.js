// The skin picker. Redrawn whenever a skin is applied.
export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<span class="mk-grid" style="grid-template-columns:repeat(3,1fr)"><i class="mk-b" style="--c:var(--accent)"></i><i class="mk-b" style="--c:var(--mint)"></i><i class="mk-b" style="--c:var(--lilac)"></i><i class="mk-b" style="--c:var(--sun)"></i><i class="mk-b" style="--c:#2B2551"></i><i class="mk-b" style="--c:var(--clay)"></i></span>',
  render(p, { el, esc, store: { skins, state }, chooseSkin, share }) {
    const wrap = el('div', 'skinlist');
    if (!skins.length) return el('div', 'md', '<p>No skins found.</p>');
    for (const sk of skins) {
      const card = el('button', 'skincard' + (sk.id === (state?.theme?.skin || 'fireside') ? ' on' : ''));
      card.type = 'button';
      const v = sk.vars || {};
      const sw = el('div', 'sw');
      sw.style.background = v['--ground'] || 'var(--ground)';
      // A skin with artwork shows it, once it has been fetched.
      const art = (sk.assets || []).map((a) => sk.cached?.[a.id]).find(Boolean);
      if (art) sw.style.background = `url('${art}') center 60% / cover, ${sw.style.background}`;
      for (const key of ['--surface', '--accent', '--ink']) {
        const dot = el('i');
        dot.style.background = v[key] || `var(${key})`;
        sw.append(dot);
      }
      card.append(sw, el('b', null, esc(sk.name || sk.id)), el('span', null, esc(sk.note || '')));
      const credits = [sk.credit, ...(sk.assets || []).map((a) => a.credit).filter(Boolean)].filter(Boolean);
      if (credits.length) {
        const c = el('span', 'credit', esc(credits.join(' · ')));
        c.title = credits.join('\n');
        card.append(c);
      }
      if ((sk.assets || []).length) {
        const n = sk.assets.length;
        const got = sk.assets.filter((a) => sk.cached?.[a.id]).length;
        card.append(el('span', 'assets', `${got}/${n} artwork ${got === n ? 'cached' : 'to fetch'}`));
      }
      card.addEventListener('click', () => chooseSkin(sk.id));
      // Sharing sits beside the card, not inside it: a button cannot hold another.
      const item = el('div', 'skinitem');
      const send = el('button', 'skinshare', '⇪');
      send.type = 'button';
      send.title = `Share ${sk.name || sk.id} as a ZIP`;
      send.setAttribute('aria-label', send.title);
      send.addEventListener('click', () => share('skin', sk.id, send));
      item.append(card, send);
      wrap.append(item);
    }
    return wrap;
  },
};
