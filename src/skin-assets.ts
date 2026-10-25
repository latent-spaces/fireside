import fs from 'node:fs';
import path from 'node:path';
import { firesideDir } from './paths.ts';
import { findSkin as find } from './catalog.ts';
import type { SkinAsset, Activity } from './contracts.ts';

export function createSkinAssets(ROOT: string, record: (entry: Activity) => unknown) {
  // --- skin assets -----------------------------------------------------------

  const findSkin = (id: string) => find(id, ROOT);

  const assetDir = (skinId: string) => path.join(firesideDir(ROOT), 'skins', 'assets', skinId.replace(/[^\w.-]/g, '_'));

  /** Local path for an asset if it has already been cached, else null. */
  function cachedAsset(skinId: string, a: SkinAsset) {
    const dir = assetDir(skinId);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return null; }
    const hit = names.find((n) => n.replace(/\.[^.]+$/, '') === a.id);
    return hit ? `/files/.fireside/skins/assets/${path.basename(dir)}/${hit}` : null;
  }

  const ASSET_MAX = 12 * 1024 * 1024;
  const ASSET_TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/avif': '.avif' };

  async function cacheAsset(skinId: string, a: SkinAsset) {
    const already = cachedAsset(skinId, a);
    if (already) return already;
    const url = new URL(a.url!);
    if (!/^https?:$/.test(url.protocol)) throw new Error('only http(s)');

    // Some official sites only serve their art to pages of their own; a skin may name that page.
    const headers: Record<string, string> = typeof a.referer === 'string' && /^https?:\/\//.test(a.referer) ? { Referer: a.referer } : {};
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow', headers });
    if (!r.ok) throw new Error(`http ${r.status}`);
    const type = (r.headers.get('content-type') || '').split(';')[0].trim();
    const ext = ASSET_TYPES[type];
    if (!ext) throw new Error(`refusing ${type || 'unknown type'} — images only`);
    const chunks = [];
    let size = 0;
    for await (const chunk of r.body!) {
      size += chunk.length;
      if (size > ASSET_MAX) throw new Error('too large');
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);

    const dir = assetDir(skinId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, a.id.replace(/[^\w.-]/g, '_') + ext), buf);
    record({ type: 'icon', label: `fetched artwork for ${skinId}: ${a.id}` });
    return cachedAsset(skinId, a);
  }


  return {findSkin, cachedAsset, cacheAsset};
}
