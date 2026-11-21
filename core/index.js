import { ConversationDetector } from './detector.js';
import { TranscriptTailer } from './tailer.js';
import { EventParser } from './parser.js';
import { EventEmitter } from 'events';

function truncateError(text, maxLen = 45) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  return trimmed.length <= maxLen
    ? trimmed
    : `${trimmed.slice(0, Math.max(1, maxLen - 3))}...`;
}

function buildStopStatus(payload, step) {
  const reason = typeof payload.terminationReason === 'string' ? payload.terminationReason : '';
  const now = Date.now();

  if (reason === 'ERROR') {
    const errDetail = truncateError(payload.error);
    return {
      state: 'error',
      title: 'Antigravity 执行出错',
      detail: errDetail || 'Agent 执行异常终止',
      step,
      eventTs: now,
      isHistorical: false,
      ts: now
    };
  }

  if (reason === 'USER_CANCELED' || reason === 'TERMINAL_CUSTOM_HOOK') {
    return {
      state: 'standby',
      title: 'Antigravity 已中止',
      detail: 'STANDBY · 任务已取消',
      step,
      eventTs: now,
      isHistorical: false,
      ts: now
    };
  }

  if (
    reason === 'MAX_INVOCATIONS' ||
    reason === 'MAX_FORCED_INVOCATIONS' ||
    reason === 'MAX_TOKEN_BUDGET_EXCEEDED'
  ) {
    return {
      state: 'standby',
      title: 'Antigravity 已暂停',
      detail: `STANDBY · 达到上限 (${reason})`,
      step,
      eventTs: now,
      isHistorical: false,
      ts: now
    };
  }

  return {
    state: 'completed',
    title: 'Antigravity 任务已完成',
    detail: 'Agent STANDBY · 等待下一指令',
    step,
    eventTs: now,
    isHistorical: false,
    ts: now
  };
}

export class TaskbarCore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.detector = new ConversationDetector(options);
    this.tailerOptions = options.tailerOptions || {};
    this.tailer = null;
    this.parser = new EventParser(options.parserOptions);
    this.currentConvId = null;
    this.currentTranscriptPath = null;
    this._started = false;
    this._lastEmittedStatus = null;
    this._stoppedStep = null;

    this.parser.on('status', (data) => {
      if (this._stoppedStep !== null) {
        if (data.isUserInput || data.step > this._stoppedStep) {
          this._stoppedStep = null;
        } else if (data.state === 'working' || data.state === 'waiting') {
          return;
        }
      }
      this._emitStatus(data);
    });
    this.detector.on('switched', (conv) => {
      this.attachToConversation(conv);
    });
  }

  _emitStatus(data) {
    if (!data || typeof data !== 'object') return false;
    const now = Date.now();
    if (
      this._lastEmittedStatus &&
      this._lastEmittedStatus.state === data.state &&
      this._lastEmittedStatus.title === data.title &&
      this._lastEmittedStatus.detail === data.detail &&
      now - this._lastEmittedStatus.emittedAt < 3000
    ) {
      return false;
    }

    this._lastEmittedStatus = {
      state: data.state,
      title: data.title,
      detail: data.detail,
      emittedAt: now
    };
    this.emit('status', data);
    return true;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this.detector.start();
  }

  attachToConversation(conv) {
    if (!conv || !conv.transcriptPath) return;
    const convId = conv.id || conv.transcriptPath;
    if (
      this.currentConvId === convId &&
      this.currentTranscriptPath === conv.transcriptPath &&
      this.tailer
    ) {
      return;
    }

    this.currentConvId = convId;
    this.currentTranscriptPath = conv.transcriptPath;
    this._stoppedStep = null;
    this._lastEmittedStatus = null;
    this.parser.reset();

    if (this.tailer) {
      this.tailer.stop();
      this.tailer = null;
    }

    let replayLatestStatus = null;
    this.tailer = new TranscriptTailer(conv.transcriptPath, this.tailerOptions);
    this.tailer.on('line', (line, meta) => {
      if (meta && meta.isReplay) {
        const status = this.parser.processLine(line, { silent: true });
        if (status) {
          replayLatestStatus = status;
        }
      } else {
        this.parser.processLine(line);
      }
    });
    this.tailer.on('replay-complete', () => {
      if (replayLatestStatus) {
        this._emitStatus(replayLatestStatus);
        replayLatestStatus = null;
      } else {
        const now = Date.now();
        this._emitStatus({
          state: 'standby',
          title: 'Antigravity 就绪',
          detail: 'STANDBY · 等待下一指令',
          step: 0,
          eventTs: now,
          isHistorical: false,
          ts: now
        });
      }
    });
    this.tailer.start();
  }

  handleHookEvent(payload) {
    if (!payload || typeof payload !== 'object') return;

    if (typeof payload.transcriptPath === 'string' && payload.transcriptPath.trim()) {
      const transcriptPath = payload.transcriptPath.trim();
      const convId =
        typeof payload.conversationId === 'string' && payload.conversationId.trim()
          ? payload.conversationId.trim()
          : transcriptPath;
      this.detector.setActiveHint(convId, transcriptPath);
      this.attachToConversation({ id: convId, transcriptPath });
    }

    if (payload.hookEventName === 'Stop') {
      this._stoppedStep = this.parser.currentStep;
      this._emitStatus(buildStopStatus(payload, this.parser.currentStep));
    }
  }

  stop() {
    this._started = false;
    if (this.tailer) {
      this.tailer.stop();
      this.tailer = null;
    }
    this.detector.stop();
  }
}
