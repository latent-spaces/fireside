function logLine(el, esc, line) {
  const tone = /(error|fail|fatal|exception)/i.test(line) ? 'err'
    : /(warn|deprecat)/i.test(line) ? 'warn'
    : /(pass|success|done|ready|compiled)/i.test(line) ? 'ok' : '';
  return el('span', 'l ' + tone, esc(line));
}

export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<span class="mk-col" style="gap:3px;font-family:var(--mono)"><i class="mk-l" style="width:64%"></i><i class="mk-l" style="width:88%"></i><i class="mk-l" style="width:40%"></i><i class="mk-l" style="width:76%"></i><i class="mk-l" style="width:52%"></i><i class="mk-l" style="width:92%"></i><i class="mk-l" style="width:30%;--c:var(--mint)"></i></span>',
  render(p, { el, esc, store }) {
    const box = el('div', 'log');
    for (const line of store.buffers[p.id] || []) box.append(logLine(el, esc, line));
    queueMicrotask(() => { box.scrollTop = box.scrollHeight; });
    return box;
  },
  // New lines append, and the log follows them if it was already at the bottom.
  update(box, { id, lines }, p, { el, esc }) {
    if (id !== p.id) return;
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    for (const line of lines) box.append(logLine(el, esc, line));
    while (box.childElementCount > 500) box.firstElementChild.remove();
    if (stick) box.scrollTop = box.scrollHeight;
  },
};
