import fs from 'fs';
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const DEFAULT_INITIAL_TAIL_BYTES = 64 * 1024;
const DEFAULT_MAX_INITIAL_TAIL_BYTES = 512 * 1024;

function hasValidJsonLine(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      // ignore invalid line
    }
  }
  return false;
}

export class TranscriptTailer extends EventEmitter {
  constructor(filePath, options = {}) {
    super();
    this.filePath = filePath;
    this.pollIntervalMs = options.pollIntervalMs || 200;
    this.chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    this.initialTailBytes = options.initialTailBytes || DEFAULT_INITIAL_TAIL_BYTES;
    this.maxInitialTailBytes = options.maxInitialTailBytes || DEFAULT_MAX_INITIAL_TAIL_BYTES;
    this.maxBootstrapLines = options.maxBootstrapLines || 15;
    this.currentOffset = 0;
    this.leftover = '';
    this.decoder = new StringDecoder('utf8');
    this.timer = null;
  }

  _readTailWindow(fd, fileSize, startPos) {
    const decoder = new StringDecoder('utf8');
    const chunks = [];
    let pos = startPos;

    while (pos < fileSize) {
      const toRead = Math.min(this.chunkSize, fileSize - pos);
      const buf = Buffer.allocUnsafe(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      chunks.push(decoder.write(bytesRead === toRead ? buf : buf.subarray(0, bytesRead)));
    }

    return { text: chunks.join(''), decoder, endPos: pos };
  }

  _bootstrap() {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      this.emit('replay-complete');
      return;
    }

    if (stat.size === 0) {
      this.currentOffset = 0;
      this.emit('replay-complete');
      return;
    }

    let fd;
    try {
      fd = fs.openSync(this.filePath, 'r');
      let windowBytes = Math.min(stat.size, this.initialTailBytes);
      let chosen = null;

      while (true) {
        const startPos = Math.max(0, stat.size - windowBytes);
        const { text, decoder, endPos } = this._readTailWindow(fd, stat.size, startPos);

        let usable = text;
        if (startPos > 0) {
          const firstNl = text.indexOf('\n');
          usable = firstNl === -1 ? '' : text.slice(firstNl + 1);
        }

        const parts = usable.split(/\r?\n/);
        const leftover = parts.pop() ?? '';
        const completeLines = parts.map((l) => l.trim()).filter(Boolean);

        chosen = { completeLines, leftover, decoder, endPos };

        if (startPos === 0 || windowBytes >= this.maxInitialTailBytes) {
          break;
        }
        if (completeLines.length > 0 && hasValidJsonLine(completeLines)) {
          break;
        }

        windowBytes = Math.min(this.maxInitialTailBytes, windowBytes * 2);
        if (windowBytes >= stat.size) {
          windowBytes = stat.size;
        }
      }

      if (chosen) {
        this.currentOffset = chosen.endPos;
        this.leftover = chosen.leftover;
        this.decoder = chosen.decoder;

        for (const line of chosen.completeLines.slice(-this.maxBootstrapLines)) {
          this.emit('line', line, { isReplay: true });
        }
      }
    } catch {
      // 静默容错
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close error
        }
      }
    }

    this.emit('replay-complete');
  }

  _poll() {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return;
    }

    if (stat.size < this.currentOffset) {
      // 文件被截断/轮转
      this.currentOffset = 0;
      this.leftover = '';
      this.decoder = new StringDecoder('utf8');
    }

    if (stat.size <= this.currentOffset) {
      return;
    }

    let fd;
    try {
      fd = fs.openSync(this.filePath, 'r');
      while (this.currentOffset < stat.size) {
        const toRead = Math.min(this.chunkSize, stat.size - this.currentOffset);
        const buf = Buffer.allocUnsafe(toRead);
        const bytesRead = fs.readSync(fd, buf, 0, toRead, this.currentOffset);
        if (bytesRead <= 0) break;

        this.currentOffset += bytesRead;
        const decoded = this.decoder.write(bytesRead === toRead ? buf : buf.subarray(0, bytesRead));
        const combined = this.leftover + decoded;
        const lines = combined.split(/\r?\n/);
        this.leftover = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            this.emit('line', trimmed, { isReplay: false });
          }
        }
      }
    } catch {
      // 静默容错
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close error
        }
      }
    }
  }

  start() {
    this.stop();
    this._bootstrap();
    this._poll();
    this.timer = setInterval(() => this._poll(), this.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.decoder = new StringDecoder('utf8');
  }
}
