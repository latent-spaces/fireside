// Skins. A skin is plain JSON of CSS variables and optional artwork, scene and
// CSS: a single <id>.json, or a folder with skin.json and the images it bundles.
// The desk's own theme.vars sit on top of whichever skin is on.
export function createSkins({ $, el, request, onApplied }) {
  let list = [], applied = null, appliedVars = [];

  async function load() {
    const response = await fetch('/api/skins');
    if (!response.ok) throw new Error(`Skins: HTTP ${response.status}`);
    list = (await response.json()).skins;
    return list;
  }

  /** {{asset:id}} points at a bundled image, or at the local copy of a linked one. */
  const resolveAssets = (text, skin) => String(text || '').replace(/\{\{asset:([\w.-]+)\}\}/g, (m, id) => skin.cached?.[id] || '');

  /** Pull down any linked artwork this skin declares but has not cached yet. */
  const assetRequests = new Map();
  async function ensureAssets(skin) {
    if (!(skin.assets || []).some((asset) => !skin.cached?.[asset.id])) return false;
    if (!assetRequests.has(skin.id)) {
      assetRequests.set(skin.id, request('/api/skin/fetch', { id: skin.id }).then((result) => {
        skin.cached = { ...skin.cached, ...result.assets };
        return Object.values(result.assets || {}).some(Boolean);
      }).catch((error) => { console.warn(error.message); return false; })
        .finally(() => assetRequests.delete(skin.id)));
    }
    return assetRequests.get(skin.id);
  }

  /** Apply the desk's theme: its skin, then its own vars on top. */
  function apply(theme = {}, fetchArtwork = true) {
    const id = theme.skin || 'fireside';
    const skin = list.find((s) => s.id === id) || list.find((s) => s.id === 'fireside');
    const key = JSON.stringify([skin, theme.vars]);
    if (!skin || applied === key) return;
    applied = key;
    const root = document.documentElement;

    // Artwork arrives after a round trip; re-apply once it lands.
    if (fetchArtwork) ensureAssets(skin).then((fetched) => {
      if (fetched && applied === key) { applied = null; apply(theme, false); }
    });

    // A skin declares whether it is a light or dark thing, and inherits that
    // full palette before its own overrides land. Without this, a skin that sets
    // a dark --ground but forgets --ink renders dark text on a dark window.
    // A skin with no base follows the operating system.
    if (skin.base === 'dark' || skin.base === 'light') root.dataset.theme = skin.base;
    else delete root.dataset.theme;

    const vars = { ...skin.vars, ...theme.vars };
    for (const name of appliedVars) root.style.removeProperty(name);
    appliedVars = Object.keys(vars);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);

    let link = $('skinFont');
    if (skin.fontHref) {
      if (!link) { link = el('link'); link.id = 'skinFont'; link.rel = 'stylesheet'; document.head.append(link); }
      if (link.href !== skin.fontHref) link.href = skin.fontHref;
    } else if (link) link.remove();

    let style = $('skinCss');
    if (!style) { style = el('style'); style.id = 'skinCss'; document.head.append(style); }
    style.textContent = resolveAssets(skin.css, skin);

    // The scene is a free HTML layer behind everything: parallax, weather,
    // characters wandering about. The skin's own css animates it.
    $('scene').innerHTML = resolveAssets(skin.scene, skin);
    $('scene').style.cssText = skin.sceneStyle || '';

    // A skin can hand the wallpaper a real image instead of the colour blobs.
    const wall = document.querySelector('.wall');
    const paper = resolveAssets(skin.wallpaper, skin);
    wall.style.cssText = paper ? `background:${paper};background-size:cover;background-position:center` : '';
    wall.classList.toggle('flat', !!paper);

    onApplied(skin);
  }

  return { load, apply };
}
