/** One connection delivers snapshots and feature feeds to the shared runtime. */
export function connectDesk({ store, snapshot, update, notify, render, offline }) {
  const events = new EventSource('/api/stream');
  const listen = (feed, callback) => events.addEventListener(feed, event => callback(JSON.parse(event.data)));
  listen('state', view => { if (!snapshot(view)) events.close(); });
  listen('acp', update);
  listen('tabs', view => { store.tabs = view.tabs; notify('tabs'); });
  // The shell's stylesheet changed: swap it in place. Scripts changing come as a
  // new `shell` fingerprint in the next snapshot, and the page reloads for those.
  listen('shell-css', at => {
    // Windows and skins swap their own stylesheets; only the shell's are ours here.
    for (const link of document.querySelectorAll('link[rel=stylesheet][href^="/"]:not([href^="/windows/"]):not([href^="/skins/"])')) link.href = `${link.getAttribute('href').split('?')[0]}?t=${at}`;
  });
  listen('status', status => { if (store.state) { store.state.status = status; render(); } });
  for (const feed of ['git', 'subscriptions']) {
    listen(feed, news => { store[feed] = news; notify(feed); });
  }
  listen('activity', row => { store.activity = [...store.activity, row].slice(-80); notify('activity', row); });
  listen('activity-update', row => {
    const index = store.activity.findIndex(item => item.id === row.id);
    if (index !== -1) store.activity[index] = row;
    notify('activity', row);
  });
  listen('lines', news => {
    store.buffers[news.id] = [...(store.buffers[news.id] || []), ...news.lines].slice(-500);
    notify('lines', news);
  });
  events.onerror = offline;
  return () => events.close();
}
