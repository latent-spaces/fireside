// Browser-local recovery, separated by project even when a localhost port is
// reused. Failure never prevents typing; callers keep their in-memory copy.
export function createRecovery(scope, getStorage = () => globalThis.localStorage, onError = () => {}) {
  const prefix = `fireside:recovery:v1:${encodeURIComponent(scope)}:`;
  const errors = new Set();
  const run = (key, operation, fallback) => {
    try {
      const result = operation(getStorage(), prefix + key);
      errors.delete(key); onError(errors.size > 0);
      return result;
    } catch {
      errors.add(key); onError(true);
      return fallback;
    }
  };
  return {
    read: (key) => run(key, (storage, name) => JSON.parse(storage.getItem(name) || 'null'), null),
    write: (key, value) => run(key, (storage, name) => { storage.setItem(name, JSON.stringify(value)); return true; }, false),
    remove: (key) => run(key, (storage, name) => { storage.removeItem(name); return true; }, false),
  };
}
