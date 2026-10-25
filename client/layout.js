// Pure geometry: compare balanced rows, retaining panel order and size hints.
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function distribute(weights, total, minimum) {
  const sizes = weights.map(() => minimum);
  const extra = Math.max(0, total - minimum * weights.length);
  const sum = weights.reduce((a, b) => a + b, 0);
  return sizes.map((size, i) => size + extra * weights[i] / sum);
}

export function tilePanels(panels, bounds, defaults = {}, widths = {}) {
  if (!panels.length) return [];
  const { x, y, w, h } = bounds;
  const gap = 13, minW = Math.min(240, w), minH = Math.min(120, h);
  const preferred = panels.map(p => ({
    w: Math.max(minW, Math.min(w, widths[p.kind] || w * clamp(Number(p.span) || 6, 1, 12) / 12)),
    h: Math.max(minH, Number(p.height) || defaults[p.kind] || 280),
  }));
  const maxCols = Math.min(panels.length, Math.max(1, Math.floor((w + gap) / (minW + gap))));
  let best;
  for (let cols = 1; cols <= maxCols; cols++) {
    const count = Math.ceil(panels.length / cols);
    const rows = [];
    let offset = 0;
    for (let r = 0; r < count; r++) {
      const length = Math.ceil((panels.length - offset) / (count - r));
      rows.push(Array.from({ length }, (_, i) => offset + i));
      offset += length;
    }
    const natural = rows.map(row => Math.max(...row.map(i => preferred[i].h)));
    const overlaps = count * minH + (count - 1) * gap > h;
    const available = h - (count - 1) * gap;
    const total = natural.reduce((a, b) => a + b, 0);
    const heights = overlaps ? rows.map(() => minH)
      : distribute(natural.map(n => Math.max(1, n - minH)), Math.min(available, total), minH);
    let top = y, score = overlaps ? 1000 + count : 0;
    const rects = [];
    rows.forEach((row, r) => {
      const widths = distribute(row.map(i => preferred[i].w), w - gap * (row.length - 1), minW);
      let left = x;
      row.forEach((i, j) => {
        const width = widths[j], height = heights[r];
        // Penalize unreadably short panels and distorted media more than expansion.
        const sx = width / preferred[i].w, sy = height / preferred[i].h;
        score += 3 * Math.max(0, -Math.log(sx)) ** 2 + 5 * Math.max(0, -Math.log(sy)) ** 2
          + .5 * Math.log(sx / sy) ** 2;
        rects[i] = { x: left, y: top, w: width, h: height };
        left += width + gap;
      });
      top = overlaps ? y + (h - minH) * (r + 1) / Math.max(1, count - 1) : top + heights[r] + gap;
    });
    if (!best || score < best.score) best = { score, rects };
  }
  return best.rects;
}

export function fitRect(rect, width, height) {
  const w = clamp(rect.w, Math.min(240, width), width);
  const h = clamp(rect.h, Math.min(120, height), height);
  return { x: clamp(rect.x, 0, width - w), y: clamp(rect.y, 0, height - h), w, h };
}
