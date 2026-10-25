/** Shared commands and live feeds. Components use the same trusted page and store. */
export function createRuntime(report) {
  const commands = new Map(), feeds = new Map();
  return {
    command(name, ...args) {
      const action = commands.get(name);
      if (!action) throw new Error(`Component command unavailable: ${name}`);
      return action(...args);
    },
    provide(name, action) {
      if (commands.has(name)) throw new Error(`Component command already registered: ${name}`);
      commands.set(name, action);
      return () => { if (commands.get(name) === action) commands.delete(name); };
    },
    subscribe(feed, callback) {
      if (!feeds.has(feed)) feeds.set(feed, new Set());
      const listeners = feeds.get(feed);
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    publish(feed, news) {
      for (const callback of feeds.get(feed) || []) {
        try { callback(news); } catch (error) { report(error); }
      }
    },
  };
}

/** A component's listeners and commands live exactly as long as its scope. */
export function createScope(ctx) {
  const callbacks = [];
  const context = Object.create(ctx);
  context.onDispose = (callback) => callbacks.push(callback);
  for (const method of ['provide', 'subscribe']) {
    context[method] = (...args) => {
      const cleanup = ctx[method](...args);
      context.onDispose(cleanup);
      return cleanup;
    };
  }
  return {
    context,
    dispose() {
      for (const callback of callbacks.splice(0)) {
        try { callback(); } catch (error) { console.error(error); }
      }
    },
  };
}
