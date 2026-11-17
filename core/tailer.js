import fs from 'fs';
import { EventEmitter } from 'events';

export class TranscriptTailer extends EventEmitter {
  constructor(filePath, options = {}) {
    super();
    this.filePath = filePath;
    this.pollIntervalMs = options.pollIntervalMs || 200;
    this.currentOffset = 0;
    this.timer = null;
    this.leftover = '';

    // 初始化时直接读取末尾的一段，获取当前最新状态
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        // 读取最后 16KB 获取最新状态
        this.currentOffset = Math.max(0, stat.size - 16384);
      }
    } catch (e) {}
  }

  start() {
    // 首次读取最近历史，立即填充任务栏初始状态
    try {
      if (fs.existsSync(this.filePath)) {
        const stat = fs.statSync(this.filePath);
        const startPos = Math.max(0, stat.size - 16384);
        const len = stat.size - startPos;
        if (len > 0) {
          const buf = Buffer.alloc(len);
          const fd = fs.openSync(this.filePath, 'r');
          fs.readSync(fd, buf, 0, len, startPos);
          fs.closeSync(fd);
          this.currentOffset = stat.size;
          const lines = buf.toString('utf-8').split(/\r?\n/);
          for (const l of lines.slice(-15)) {
            if (l.trim()) this.emit('line', l.trim());
          }
        }
      }
    } catch (e) {}

    const poll = () => {
      try {
        if (!fs.existsSync(this.filePath)) return;
        const stat = fs.statSync(this.filePath);

        if (stat.size < this.currentOffset) {
          // 文件被截断/轮转
          this.currentOffset = 0;
          this.leftover = '';
        }

        if (stat.size > this.currentOffset) {
          const lengthToRead = stat.size - this.currentOffset;
          const buffer = Buffer.alloc(lengthToRead);
          const fd = fs.openSync(this.filePath, 'r');
          fs.readSync(fd, buffer, 0, lengthToRead, this.currentOffset);
          fs.closeSync(fd);

          this.currentOffset = stat.size;
          const content = this.leftover + buffer.toString('utf-8');
          const lines = content.split(/\r?\n/);
          this.leftover = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              this.emit('line', trimmed);
            }
          }
        }
      } catch (e) {
        // 静默容错
      }
    };

    poll();
    this.timer = setInterval(poll, this.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
