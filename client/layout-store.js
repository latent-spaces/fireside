// Geometry changes paint immediately. Only completed interactions reach disk.
export function createLayoutStore(getGeometry, request, onError) {
  let ready = false, paused = false, timer = null, sending = false, pointerDown = false;
  const saved = new Map();
  function schedule() {
    if (!ready || paused) return;
    clearTimeout(timer);
    timer = setTimeout(flush, 200);
  }
  async function flush() {
    if (!ready || paused || pointerDown || sending) return;
    const entries = Object.entries(getGeometry()).map(([id, rect]) => [id, JSON.stringify(rect)])
      .filter(([id, value]) => saved.get(id) !== value);
    if (!entries.length) return;
    sending = true;
    let success = false;
    try {
      await request('/api/layout', {
        changes: Object.fromEntries(entries.map(([id, value]) => [id, JSON.parse(value)])),
      }, { signal: AbortSignal.timeout(5000), keepalive: true });
      for (const [id, value] of entries) saved.set(id, value);
      success = true;
    } catch (error) { if (!paused) onError(`Layout could not be saved: ${error.message}. It will retry while this page is open.`); }
    finally {
      sending = false;
      clearTimeout(timer);
      if (!paused) timer = setTimeout(flush, success ? 200 : 5000);
    }
  }
  addEventListener('pointerdown', () => { pointerDown = true; }, true);
  for (const event of ['pointerup', 'pointercancel', 'blur']) {
    addEventListener(event, () => { pointerDown = false; schedule(); });
  }
  addEventListener('pagehide', () => { pointerDown = false; clearTimeout(timer); flush(); });
  return {
    initialize(layout) {
      if (ready || paused) return false;
      for (const [id, rect] of Object.entries(layout || {})) saved.set(id, JSON.stringify(rect));
      ready = true;
      return true;
    },
    schedule,
    // A new project at this address must never receive the old desk's layout.
    // Stay paused until the page reloads, including retries and pagehide flushes.
    pause() { paused = true; clearTimeout(timer); timer = null; },
  };
}
