import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { firesideDir } from './paths.ts';
import { fail } from './errors.ts';

/**
 * Images pasted into a chat. The transcript names each one by its hash and the
 * bytes stay on disk, so a screenshot never rides along with every redraw of
 * the thread; the agent gets the bytes only when the message is delivered.
 */
export const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const NAME = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;
const MAX = 5 * 1024 * 1024;   // what Claude accepts per image

const dir = (root) => path.join(firesideDir(root), 'images');

/** Save an image sent as base64, and return the name the transcript keeps. */
export function saveImage(root, { data, mimeType } = {}) {
  const ext = IMAGE_TYPES[mimeType];
  if (!ext || typeof data !== 'string' || !data) throw fail('Only PNG, JPEG, GIF and WebP images can be sent', 400);
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw fail('That image is empty', 400);
  if (bytes.length > MAX) throw fail('That image is over 5 MB', 413);
  const name = createHash('sha256').update(bytes).digest('hex') + ext;
  fs.mkdirSync(dir(root), { recursive: true });
  const file = path.join(dir(root), name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  return name;
}

/** Where a saved image lives, or null for a name that isn't one. */
export function imageFile(root, name) {
  return typeof name === 'string' && NAME.test(name) ? path.join(dir(root), name) : null;
}

/** A saved image as an ACP content block. */
export function imageBlock(root, name) {
  const file = imageFile(root, name);
  if (!file) throw fail('Unknown image', 400);
  const mimeType = Object.keys(IMAGE_TYPES).find(type => name.endsWith(IMAGE_TYPES[type]));
  try { return { type: 'image', mimeType, data: fs.readFileSync(file).toString('base64') }; }
  catch { throw fail('An image in this message is no longer on disk'); }
}
