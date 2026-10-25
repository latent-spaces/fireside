import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import { CLIENT_DIR, PKG_ROOT } from './paths.ts';
import { projectFile } from './http.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

export function serveFile(res: ServerResponse, file: string, { download = false, app = false, range = '' } = {}) {
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) { res.writeHead(404).end('not found'); return; }
    const headers: OutgoingHttpHeaders = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': app ? 'no-store' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    if (!app) headers['Content-Security-Policy'] = 'sandbox allow-scripts';
    if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
    // A player asks for the part of a video it needs; without ranges it cannot seek,
    // and Safari will not play at all.
    const part = /^bytes=(\d*)-(\d*)$/.exec(range);
    let slice: { start: number; end: number } | undefined;
    if (part && (part[1] || part[2])) {
      const start = part[1] ? Number(part[1]) : Math.max(stat.size - Number(part[2]), 0);
      const end = part[1] && part[2] ? Math.min(Number(part[2]), stat.size - 1) : stat.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end(); return; }
      slice = { start, end };
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = end - start + 1;
    }
    headers['Accept-Ranges'] = 'bytes';
    res.writeHead(slice ? 206 : 200, headers);
    const stream = fs.createReadStream(file, slice);
    stream.on('error', (error) => res.destroy(error));
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

// The shell is served straight from client/ through Vite, so there is no build to
// run or go stale. Vite's own live reload is off: its connection drops with every
// server restart and it reloads the page each time, even when nothing in the page
// changed. The desk's own stream says when the shell really changed (src/watch.ts).
export async function createAppAssets() {
  const vite = await (await import('vite')).createServer({
    configFile: path.join(PKG_ROOT, 'vite.config.ts'),
    appType: 'custom',
    logLevel: 'warn',
    server: { middlewareMode: true, hmr: false, ws: false, host: '127.0.0.1' },
  });
  return {
    async handle(req: IncomingMessage, res: ServerResponse, pathname: string) {
      if (pathname === '/' || pathname === '/index.html') {
        const html = await vite.transformIndexHtml(req.url || '/', fs.readFileSync(path.join(CLIENT_DIR, 'index.html'), 'utf8'));
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }).end(html);
        return;
      }
      vite.middlewares(req, res, () => res.writeHead(404).end('not found'));
    },
    async close() { await vite.close(); },
  };
}
