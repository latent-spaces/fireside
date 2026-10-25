import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};

export async function body(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw Object.assign(new Error('Expected application/json'), { status: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8_000_000) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw Object.assign(new Error('Expected a JSON object'), { status: 400 }); }
}

/** A request body as bytes, for uploads such as a component ZIP. */
export async function rawBody(req: IncomingMessage, limit: number) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Upload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export function guard(req: IncomingMessage, url: string, token: string) {
  const allowed = [new URL(url).host, new URL(url.replace('127.0.0.1', 'localhost')).host];
  if (!allowed.includes(req.headers.host || '')) throw Object.assign(new Error('Wrong host'), { status: 403 });
  const origin = req.headers.origin;
  if (origin && !allowed.some((host) => origin === `http://${host}`)) throw Object.assign(new Error('Wrong origin'), { status: 403 });
  const pathname = new URL(req.url || "/", url).pathname;
  const privileged = /^\/api\/push$/.test(pathname);
  if (privileged && req.headers.authorization !== `Bearer ${token}`) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  if (!['GET', 'HEAD'].includes(req.method || '') && !privileged && req.headers['x-fireside-request'] !== '1') {
    throw Object.assign(new Error('Missing request header'), { status: 403 });
  }
}

export function projectFile(root: string, relative: string) {
  // The native call gives the name's real case, so a case-blind disk can't
  // dress a private folder up as another.
  const realRoot = fs.realpathSync.native(root);
  const file = fs.realpathSync.native(path.resolve(root, relative));
  if (file !== realRoot && !file.startsWith(realRoot + path.sep)) throw Object.assign(new Error('Outside project'), { status: 403 });
  return file;
}
