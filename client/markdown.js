const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --- markdown (a deliberate subset: what Claude actually writes into panels) --
export function md(src, { html = false } = {}) {
  const blocks = [];
  let s = String(src || '').replace(/\r/g, '');
  // The placeholder must survive trimEnd(), so it carries no padding spaces.
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `\n\u0000CB${blocks.push(`<pre><code class="lang-${esc(lang)}">${esc(code.replace(/\n$/, ''))}</code></pre>`) - 1}\u0000\n`);
  // README-style HTML is opt-in. Rebuild a small allowlist rather than inserting
  // source HTML: scripts, event handlers, styles and unsafe URLs never survive.
  const tags = [];
  if (html) s = s.replace(/<\/?[a-z][^>]*>/gi, (tag) => {
    const match = /^<(\/?)([a-z][a-z0-9]*)\b([^>]*)>$/i.exec(tag);
    if (!match) return '';
    const [, closing, rawName, attrs] = match, name = rawName.toLowerCase();
    if (!['p', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary', 'br', 'strong', 'em'].includes(name)) return '';
    let safe = `<${closing ? '/' : ''}${name}`;
    if (!closing) {
      for (const attr of attrs.matchAll(/([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
        const key = attr[1].toLowerCase(), value = attr[2] ?? attr[3] ?? attr[4];
        if (['alt', 'title'].includes(key) || (['width', 'height'].includes(key) && /^\d+%?$/.test(value)) || (key === 'align' && /^(left|center|right)$/.test(value))) safe += ` ${key}="${esc(value)}"`;
        if ((name === 'a' && key === 'href') || (name === 'img' && key === 'src')) {
          try { if (['http:', 'https:', 'mailto:'].includes(new URL(value, 'http://localhost').protocol)) safe += ` ${key}="${esc(value)}"`; } catch {}
        }
      }
      if (name === 'a') safe += ' target="_blank" rel="noreferrer"';
    }
    return `\u0000HT${tags.push(safe + '>') - 1}\u0000`;
  });
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      // Undo only our escaping so validation sees the same value as the browser.
      const destination = href.replace(/&(amp|lt|gt|quot);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"' }[name]));
      let url;
      try { url = new URL(destination, 'http://localhost'); } catch { return label; }
      return ['http:', 'https:', 'mailto:'].includes(url.protocol)
        ? `<a href="${esc(destination)}" target="_blank" rel="noreferrer">${label}</a>` : label;
    });

  const out = [];
  let list = null, table = null, para = [], quote = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (table) { out.push('</tbody></table>'); table = null; } };
  // Consecutive plain lines are one paragraph, the way markdown actually works.
  const closePara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const closeQuote = () => { if (quote.length) { out.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`); quote = []; } };
  const close = () => { closePara(); closeQuote(); closeList(); closeTable(); };

  for (const raw of s.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.trim().match(/^\u0000CB(\d+)\u0000$/))) { close(); out.push(blocks[+m[1]]); continue; }
    if (!line.trim()) { close(); continue; }
    if (html && /^(?:\s*\u0000HT\d+\u0000)+\s*$/.test(line)) { close(); out.push(line); continue; }
    if (html && (m = line.trim().match(/^\u0000HT(\d+)\u0000/)) && /^<(?:p|summary|td|th)\b/.test(tags[+m[1]]) && /\u0000HT\d+\u0000$/.test(line.trim())) {
      close(); out.push(inline(line)); continue;
    }
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { close(); out.push('<hr>'); continue; }
    if (line.trim().startsWith('|') && line.includes('|', 1)) {
      closePara(); closeQuote(); closeList();
      const cells = line.trim().split('|').slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
      if (!table) { out.push('<table><tbody>'); table = 1; }
      const tag = table++ === 1 ? 'th' : 'td';
      out.push(`<tr>${cells.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`);
      continue;
    }
    closeTable();
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) { closePara(); closeQuote(); if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); continue; }
    // A blank line or code block between steps ends the list, so each <ol> starts at the number as written.
    if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)/))) { closePara(); closeQuote(); if (list !== 'ol') { closeList(); out.push(`<ol start="${+m[1]}">`); list = 'ol'; } out.push(`<li>${inline(m[2])}</li>`); continue; }
    if ((m = line.match(/^>\s?(.*)/))) { closePara(); closeList(); quote.push(m[1]); continue; }
    closeQuote();
    // An indented continuation line belongs to the open list item, not a new paragraph.
    if (list && /^\s{2,}\S/.test(raw)) { out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ' ' + inline(line.trim()) + '</li>'); continue; }
    closeList();
    para.push(line.trim());
  }
  close();
  return out.join('\n').replace(/\u0000HT(\d+)\u0000/g, (_, i) => tags[+i] || '');
}
