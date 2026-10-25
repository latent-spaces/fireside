import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// A bounded, rotation-aware line reader shared by logs and transcripts.
export class LineReader {
  constructor(file, limit = 256_000) {
    this.file = file;
    this.limit = limit;
    this.pos = 0;
    this.identity = null;
    this.reset();
  }
  reset() { this.rest = ''; this.decoder = new StringDecoder('utf8'); }
  read() {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return [];
      const identity = `${stat.dev}:${stat.ino}`;
      if (identity !== this.identity || stat.size < this.pos) {
        this.reset();
        this.pos = Math.max(0, stat.size - this.limit);
        this.skipFirst = this.pos > 0;
        this.identity = identity;
      }
      const size = Math.min(this.limit, stat.size - this.pos);
      if (!size) return [];
      const buffer = Buffer.alloc(size);
      const read = fs.readSync(fd, buffer, 0, size, this.pos);
      this.pos += read;
      const lines = (this.rest + this.decoder.write(buffer.subarray(0, read))).split('\n');
      this.rest = lines.pop();
      if (this.skipFirst && lines.length) { lines.shift(); this.skipFirst = false; }
      // Discard oversized records instead of accumulating unbounded strings.
      if (this.rest.length > this.limit) { this.rest = ''; this.skipFirst = true; }
      // A CRLF log would otherwise carry its carriage return into the panel.
      return lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EISDIR'].includes(error.code)) console.error(`Cannot read ${this.file}: ${error.message}`);
      return [];
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
}
