const time = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
let brainHidden = false;

export default {
  // The sketch the ＋ menu draws of this window, with the shared .mk-* shapes.
  preview: () => '<i class="mk-l" style="width:30%;--c:var(--ink-2)"></i><span class="mk-row"><i class="mk-b" style="flex:1;height:7px;border-radius:99px;background:linear-gradient(90deg,var(--mint) 38%,var(--sunk) 38%)"></i></span><i class="mk-l" style="width:30%;--c:var(--ink-2)"></i><span class="mk-row"><i class="mk-b" style="flex:1;height:7px;border-radius:99px;background:linear-gradient(90deg,var(--sun) 72%,var(--sunk) 72%)"></i></span>',
  render(p, { el, esc, refreshSubscriptions, wakeUsage, store: { subscriptions } }) {
    const box = el('div', 'tokens');
    // Account-wide limits, read by the server every five minutes or on Refresh.
    if (!subscriptions) {
      box.append(el('p', 'tk-empty', 'Loading usage…'));
      return box;
    }
    const bar = el('div', 'tk-bar');
    bar.append(el('span', 'tk-label', 'Plan limits'));
    const wake = subscriptions.wake || {};
    if (wake.available || wake.working) {
      const button = el('button', 'tk-wake-button tk-wake-all',
        wake.working ? 'Waking…' : wake.results?.some(r => !r.ok) ? 'Try again' : 'Wake Claude + Codex');
      button.type = 'button';
      button.disabled = wake.working;
      button.onclick = async () => {
        button.disabled = true; button.textContent = 'Waking…';
        brainHidden = false; showBrain();
        // The server answers as soon as the wake starts; what happened arrives
        // in the next `subscriptions` broadcast, which redraws this window.
        try { await wakeUsage(); }
        catch (error) {
          button.disabled = false; button.textContent = 'Try again';
          bar.after(el('p', 'tk-wake-note tk-wake-failed', esc(error.message || 'Could not start the wake-up.')));
        }
      };
      bar.append(button);
    }
    const refresh = el('button', 'tk-refresh', subscriptions.reading ? 'Refreshing…' : 'Refresh');
    refresh.type = 'button';
    refresh.disabled = subscriptions.reading;
    refresh.onclick = () => {
      refresh.disabled = true; refresh.textContent = 'Refreshing…';
      refreshSubscriptions().catch(() => { refresh.disabled = false; refresh.textContent = 'Refresh'; });
    };
    bar.append(refresh);
    box.append(bar);
    // Why the last wake worked or didn't: nothing else reports it.
    for (const r of wake.results || []) box.append(el('p', `tk-wake-note${r.ok ? '' : ' tk-wake-failed'}`, `${esc(r.name)}: ${esc(r.message)}`));
    if (wake.working) box.append(el('p', 'tk-wake-note', 'Waking…'));
    function showBrain() {
      if (brainHidden || box.querySelector('.tk-brain') || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const brain = el('figure', 'tk-brain');
      const gif = el('img', '');
      // Not bundled: The Simpsons belongs to its rights holders, so it loads from Tenor.
      gif.src = 'https://media1.tenor.com/m/hKsgsuQ5N8MAAAAd/cymbals-monkey-brain.gif';
      gif.referrerPolicy = 'no-referrer';
      gif.alt = 'The monkey in Homer Simpson’s brain playing cymbals';
      gif.width = 160; gif.height = 148;
      gif.onerror = () => brain.remove();
      const caption = el('figcaption', '', 'Actual footage of the warm-up. ');
      const credit = el('a', '', 'The Simpsons, via Tenor');
      credit.href = 'https://tenor.com/view/cymbals-monkey-brain-the-simpsons-homer-empty-head-gif-15689692';
      credit.target = '_blank'; credit.rel = 'noopener noreferrer';
      caption.append(credit);
      const dismiss = el('button', 'tk-refresh', 'Hide GIF');
      dismiss.type = 'button';
      dismiss.onclick = () => { brainHidden = true; brain.remove(); };
      brain.append(gif, caption, dismiss);
      box.append(brain);
    }
    for (const s of subscriptions.providers) {
      const section = el('section', 'tk-provider');
      const title = el('div', 'tk-limit');
      // A rate limit with numbers already on screen is just a later read, not news.
      const waiting = s.retryAt && s.windows.length;
      title.append(el('b', '', esc(s.name)), el('span', '', s.at ? `Updated ${time(s.at)}${waiting ? ` · next ${time(s.retryAt)}` : ''}` : ''));
      section.append(title);
      const note = waiting ? '' : s.retryAt ? `Rate-limited. Retrying after ${time(s.retryAt)}.` : s.message;
      if (note || !s.windows.length) section.append(el('p', 'tk-empty', esc(note || 'No usage limits reported.')));
      for (const w of s.windows) {
        const head = el('div', 'tk-limit');
        head.append(el('span', '', esc(w.name)), el('span', '', `${Math.round(w.used)}% used`));
        const meter = el('progress', 'tk-meter');
        meter.max = 100; meter.value = Math.max(0, Math.min(100, w.used));
        meter.setAttribute('aria-label', `${s.name} ${w.name}: ${Math.round(w.used)}% used`);
        section.append(head, meter);
        if (w.resetsAt) section.append(el('div', 'tk-reset', `${w.expires ? 'Expires' : 'Resets'} ${new Date(w.resetsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`));
      }
      box.append(section);
    }
    if (wake.working) showBrain();
    return box;
  },
};
