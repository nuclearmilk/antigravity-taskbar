import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

export class ConversationDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    const defaultBaseDir = process.env.ANTIGRAVITY_APP_DATA_DIR
      ? path.join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'brain')
      : path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

    this.baseDir = options.baseDir || defaultBaseDir;
    this.currentConvId = null;
    this.currentTranscriptPath = null;
    this.pollIntervalMs = options.pollIntervalMs || 1000;
    this.timer = null;
    this.lastMtime = 0;
  }

  detectActiveConversation() {
    if (!fs.existsSync(this.baseDir)) return null;

    try {
      const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
      const convs = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const transcriptPath = path.join(this.baseDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(transcriptPath)) {
          try {
            const stat = fs.statSync(transcriptPath);
            convs.push({
              id: entry.name,
              transcriptPath,
              mtimeMs: stat.mtimeMs,
              size: stat.size
            });
          } catch (e) {}
        }
      }

      convs.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return convs[0] || null;
    } catch (e) {
      return null;
    }
  }

  start() {
    const check = () => {
      const active = this.detectActiveConversation();
      if (!active) return;

      if (active.id !== this.currentConvId) {
        this.currentConvId = active.id;
        this.currentTranscriptPath = active.transcriptPath;
        this.lastMtime = active.mtimeMs;
        this.emit('switched', active);
      }
    };

    check();
    this.timer = setInterval(check, this.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
