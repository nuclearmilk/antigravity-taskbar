import { ConversationDetector } from './detector.js';
import { TranscriptTailer } from './tailer.js';
import { EventParser } from './parser.js';
import { EventEmitter } from 'events';

export class TaskbarCore extends EventEmitter {
  constructor(options = {}) {
    super();
    this.detector = new ConversationDetector(options);
    this.tailer = null;
    this.parser = new EventParser();
    this.currentConvId = null;

    this.parser.on('status', (data) => this.emit('status', data));
  }

  start() {
    this.detector.on('switched', (conv) => {
      this.attachToConversation(conv);
    });
    this.detector.start();
  }

  attachToConversation(conv) {
    if (!conv || !conv.transcriptPath) return;
    if (this.currentConvId === conv.id && this.tailer) return;

    this.currentConvId = conv.id;
    if (this.tailer) {
      this.tailer.stop();
      this.tailer = null;
    }

    this.tailer = new TranscriptTailer(conv.transcriptPath);
    this.tailer.on('line', (line) => this.parser.processLine(line));
    this.tailer.start();
  }

  stop() {
    if (this.tailer) {
      this.tailer.stop();
      this.tailer = null;
    }
    this.detector.stop();
  }
}
