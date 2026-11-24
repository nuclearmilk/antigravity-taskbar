import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';

const DEFAULT_PRODUCTS = ['antigravity', 'antigravity-cli', 'antigravity-ide'];
const TRANSCRIPT_FILES = ['transcript_full.jsonl', 'transcript.jsonl'];

function normalizePathKey(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isFullTranscriptPath(p) {
  return typeof p === 'string' && path.basename(p).toLowerCase() === 'transcript_full.jsonl';
}

function isCompactTranscriptPath(p) {
  return typeof p === 'string' && path.basename(p).toLowerCase() === 'transcript.jsonl';
}

function resolveBaseDirs(options = {}) {
  if (Array.isArray(options.baseDirs) && options.baseDirs.length > 0) {
    return options.baseDirs;
  }
  if (options.baseDir) {
    return [options.baseDir];
  }
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    return [path.join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'brain')];
  }
  const geminiRoot = path.join(os.homedir(), '.gemini');
  return DEFAULT_PRODUCTS.map((product) => path.join(geminiRoot, product, 'brain'));
}

export class ConversationDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.baseDirs = resolveBaseDirs(options);
    this.baseDir = this.baseDirs[0];
    this.currentConvId = null;
    this.currentTranscriptPath = null;
    this.pollIntervalMs = options.pollIntervalMs || 2500;
    this.timer = null;
    this.lastMtime = 0;
    this.hookPinnedAt = 0;
    this._checking = false;
    this._stopped = false;
  }

  setActiveHint(convId, transcriptPath) {
    if (convId) this.currentConvId = convId;
    if (transcriptPath) this.currentTranscriptPath = transcriptPath;
    this.hookPinnedAt = Date.now();
  }

  async _scanDir(baseDir) {
    let entries;
    try {
      entries = await fs.readdir(baseDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const convs = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const logsDir = path.join(baseDir, entry.name, '.system_generated', 'logs');
      for (const fileName of TRANSCRIPT_FILES) {
        const transcriptPath = path.join(logsDir, fileName);
        try {
          const stat = await fs.stat(transcriptPath);
          convs.push({
            id: entry.name,
            transcriptPath,
            mtimeMs: stat.mtimeMs,
            size: stat.size
          });
          break;
        } catch {
          // transcript file does not exist yet
        }
      }
    }

    return convs;
  }

  async detectActiveConversation() {
    const results = await Promise.all(this.baseDirs.map((dir) => this._scanDir(dir)));
    const convs = results.flat();
    convs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return convs[0] || null;
  }

  async checkOnce() {
    if (this._checking || this._stopped) return;
    this._checking = true;
    try {
      const active = await this.detectActiveConversation();
      if (!active || this._stopped) return;

      const samePath =
        normalizePathKey(active.transcriptPath) === normalizePathKey(this.currentTranscriptPath);
      const keepFullOverCompact =
        isFullTranscriptPath(this.currentTranscriptPath) &&
        isCompactTranscriptPath(active.transcriptPath);
      const sameConv =
        active.id === this.currentConvId && (samePath || keepFullOverCompact);
      if (sameConv) {
        this.lastMtime = active.mtimeMs;
        return;
      }

      if (
        this.hookPinnedAt &&
        Date.now() - this.hookPinnedAt < 10000 &&
        active.mtimeMs <= this.hookPinnedAt
      ) {
        return;
      }

      this.currentConvId = active.id;
      this.currentTranscriptPath = active.transcriptPath;
      this.lastMtime = active.mtimeMs;
      this.emit('switched', active);
    } finally {
      this._checking = false;
    }
  }

  start() {
    this.stop();
    this._stopped = false;
    void this.checkOnce();
    this.timer = setInterval(() => {
      void this.checkOnce();
    }, this.pollIntervalMs);
  }

  stop() {
    this._stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
