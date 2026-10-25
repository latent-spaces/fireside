import fs from 'node:fs';
import path from 'node:path';
import { writeJSON } from './storage.mjs';
import { firesideDir } from './paths.ts';

function validate(raw) {
  const invalid = () => { throw Object.assign(new Error('Invalid window layout'), { status: 400 }); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 2000) invalid();
  const layout = Object.create(null);
  for (const [id, value] of Object.entries(raw)) {
    if (!id || id.length > 1000 || !value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const rect = {};
    for (const key of ['x', 'y', 'w', 'h']) {
      if (value[key] === undefined && id.startsWith('icon:') && ['w', 'h'].includes(key)) continue;
      if (!Number.isFinite(value[key]) || Math.abs(value[key]) > 1000000 || (['w', 'h'].includes(key) && value[key] <= 0)) invalid();
      rect[key] = value[key];
    }
    if (typeof value.closed === 'boolean') rect.closed = value.closed;
    if (Number.isInteger(value.z) && value.z >= 0 && value.z <= 1000000) rect.z = value.z;   // stacking: higher is in front
    if (value.pinned === true) rect.pinned = true;   // stays above every unpinned window
    if (typeof value.closedFor === 'string' || value.closedFor === null) rect.closedFor = value.closedFor;
    for (const key of ['max', 'snap']) {
      if (value[key] !== undefined) {
        const saved = value[key];
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) invalid();
        rect[key] = {};
        for (const field of ['x', 'y', 'w', 'h']) {
          if (saved[field] === undefined && ['x', 'y'].includes(field)) continue;
          if (!Number.isFinite(saved[field]) || Math.abs(saved[field]) > 1000000 || (['w', 'h'].includes(field) && saved[field] <= 0)) invalid();
          rect[key][field] = saved[field];
        }
      }
    }
    layout[id] = rect;
  }
  return layout;
}

export function createLayout(root) {
  const file = path.join(firesideDir(root), 'layout.json');
  let current = Object.create(null);
  try { current = validate(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${error.message}`); }
  function write(next) {
    writeJSON(file, next);
    current = next;
  }
  return {
    get value() { return current; },
    update(changes) { write(validate({ ...current, ...validate(changes) })); },
    /** Forget a deleted window, so a new one with the same id starts fresh. */
    remove(id) {
      if (!Object.hasOwn(current, id)) return;
      const next = Object.assign(Object.create(null), current);
      delete next[id];
      write(next);
    },
  };
}
