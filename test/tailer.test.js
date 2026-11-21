import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TranscriptTailer } from '../core/tailer.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ag-tailer-test-'));
}

describe('TranscriptTailer', () => {
  it('reads single lines larger than 16KB and dynamically expands tail window past 64KB', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'transcript.jsonl');

    const line1 = JSON.stringify({ step_index: 1, type: 'USER_INPUT', pad: 'a'.repeat(5000) });
    const hugeLine = JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', thinking: 'x'.repeat(75000) });
    fs.writeFileSync(filePath, `${line1}\n${hugeLine}\n`, 'utf-8');

    const tailer = new TranscriptTailer(filePath, {
      pollIntervalMs: 10000,
      initialTailBytes: 16384,
      maxInitialTailBytes: 512 * 1024
    });

    const lines = [];
    let replayCompleted = false;
    tailer.on('line', (l, meta) => lines.push({ l, meta }));
    tailer.on('replay-complete', () => {
      replayCompleted = true;
    });

    tailer.start();
    tailer.stop();

    assert.equal(replayCompleted, true);
    assert.ok(lines.some((entry) => JSON.parse(entry.l).step_index === 2));
    assert.equal(lines[lines.length - 1].meta.isReplay, true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('decodes multi-byte Chinese UTF-8 split across read chunks without corruption', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(filePath, '', 'utf-8');

    const tailer = new TranscriptTailer(filePath, {
      pollIntervalMs: 10000,
      chunkSize: 5
    });

    const received = [];
    tailer.on('line', (l) => received.push(l));
    tailer.start();

    const chinesePayload = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      msg: '你好世界，正在测试多字节中文分片解码稳定性'
    });
    fs.appendFileSync(filePath, `${chinesePayload}\n`, 'utf-8');
    tailer._poll();
    tailer.stop();

    assert.equal(received.length, 1);
    assert.equal(received[0].includes('\uFFFD'), false);
    assert.deepEqual(JSON.parse(received[0]), JSON.parse(chinesePayload));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves trailing incomplete line in leftover across bootstrap and poll', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'transcript.jsonl');

    const completeLine = JSON.stringify({ step_index: 1, type: 'USER_INPUT' });
    const partialLine = '{"step_index":2,"type":"PLANNER_';
    fs.writeFileSync(filePath, `${completeLine}\n${partialLine}`, 'utf-8');

    const tailer = new TranscriptTailer(filePath, { pollIntervalMs: 10000 });
    const received = [];
    tailer.on('line', (l, meta) => received.push({ l, isReplay: meta.isReplay }));

    tailer.start();
    assert.equal(received.length, 1);
    assert.equal(received[0].isReplay, true);
    assert.equal(tailer.leftover, partialLine);

    fs.appendFileSync(filePath, 'RESPONSE"}\n', 'utf-8');
    tailer._poll();
    tailer.stop();

    assert.equal(received.length, 2);
    assert.equal(received[1].isReplay, false);
    assert.deepEqual(JSON.parse(received[1].l), { step_index: 2, type: 'PLANNER_RESPONSE' });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resets offset on file truncation and closes file descriptors cleanly', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(filePath, `${JSON.stringify({ step_index: 1, pad: 'z'.repeat(200) })}\n`, 'utf-8');

    const tailer = new TranscriptTailer(filePath, { pollIntervalMs: 10000 });
    const received = [];
    tailer.on('line', (l) => received.push(l));
    tailer.start();

    // Truncate and write shorter content
    fs.writeFileSync(filePath, `${JSON.stringify({ step_index: 99 })}\n`, 'utf-8');
    tailer._poll();
    tailer.stop();

    assert.equal(received.length, 2);
    assert.equal(JSON.parse(received[1]).step_index, 99);

    // Ensure no open FD prevents immediate file deletion on Windows
    fs.unlinkSync(filePath);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
