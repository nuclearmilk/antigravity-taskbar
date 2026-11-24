import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TaskbarCore } from '../core/index.js';
import { ConversationDetector } from '../core/detector.js';

describe('TaskbarCore & ConversationDetector', () => {
  it('suppresses bootstrap replay storm into a single status and resets parser on conversation switch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-core-test-'));
    const t1 = path.join(dir, 't1.jsonl');
    const t2 = path.join(dir, 't2.jsonl');

    const lines1 = [];
    for (let i = 1; i <= 10; i++) {
      lines1.push(
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          source: 'MODEL',
          status: 'DONE',
          step_index: i,
          tool_calls: [{ name: 'read_file', args: { Path: `file${i}.js` } }]
        })
      );
    }
    fs.writeFileSync(t1, `${lines1.join('\n')}\n`, 'utf-8');
    fs.writeFileSync(
      t2,
      `${JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', step_index: 0 })}\n`,
      'utf-8'
    );

    const core = new TaskbarCore({ tailerOptions: { pollIntervalMs: 10000 } });
    const statuses = [];
    core.on('status', (s) => statuses.push(s));

    core.attachToConversation({ id: 'conv-1', transcriptPath: t1 });
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].step, 10);
    assert.equal(core.parser.currentStep, 10);

    core.attachToConversation({ id: 'conv-2', transcriptPath: t2 });
    assert.equal(statuses.length, 2);
    assert.equal(core.parser.currentStep, 0);
    assert.equal(statuses[1].state, 'working');

    core.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('attaches directly via handleHookEvent transcriptPath and synthesizes Stop terminal states', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-hook-test-'));
    const tPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      tPath,
      `${JSON.stringify({ type: 'USER_INPUT', step_index: 1 })}\n`,
      'utf-8'
    );

    const core = new TaskbarCore({ tailerOptions: { pollIntervalMs: 10000 } });
    const statuses = [];
    core.on('status', (s) => statuses.push(s));

    core.handleHookEvent({
      hookEventName: 'PreInvocation',
      conversationId: 'conv-hook',
      transcriptPath: tPath
    });
    assert.equal(core.currentConvId, 'conv-hook');
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].state, 'working');

    core.handleHookEvent({
      hookEventName: 'Stop',
      conversationId: 'conv-hook',
      transcriptPath: tPath,
      terminationReason: 'USER_CANCELED'
    });
    assert.equal(statuses.length, 2);
    assert.equal(statuses[1].state, 'standby');

    core.handleHookEvent({
      hookEventName: 'Stop',
      conversationId: 'conv-hook',
      transcriptPath: tPath,
      terminationReason: 'ERROR',
      error: 'Network failure'
    });
    assert.equal(statuses.length, 3);
    assert.equal(statuses[2].state, 'error');
    assert.equal(statuses[2].detail, 'Network failure');

    core.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deduplicates consecutive identical completed/Stop statuses and blocks stale working rollback until new turn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-stop-guard-'));
    const tPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      tPath,
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 5,
        created_at: new Date().toISOString()
      })}\n`,
      'utf-8'
    );

    const core = new TaskbarCore({ tailerOptions: { pollIntervalMs: 10000 } });
    const statuses = [];
    core.on('status', (s) => statuses.push(s));

    core.attachToConversation({ id: 'conv-guard', transcriptPath: tPath });
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].state, 'completed');

    // Stop(NO_TOOL_CALL) produces identical completed status within <3s -> deduplicated
    core.handleHookEvent({
      hookEventName: 'Stop',
      conversationId: 'conv-guard',
      transcriptPath: tPath,
      terminationReason: 'NO_TOOL_CALL'
    });
    assert.equal(statuses.length, 1);

    // Delayed working line at step <= stoppedStep (5) -> ignored
    fs.appendFileSync(
      tPath,
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 5,
        tool_calls: [{ name: 'read_file', args: { Path: 'late.js' } }]
      })}\n`,
      'utf-8'
    );
    core.tailer._poll();
    assert.equal(statuses.length, 1);

    // New USER_INPUT clears stoppedStep and transitions back to working
    fs.appendFileSync(
      tPath,
      `${JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        step_index: 6,
        created_at: new Date().toISOString()
      })}\n`,
      'utf-8'
    );
    core.tailer._poll();
    assert.equal(statuses.length, 2);
    assert.equal(statuses[1].state, 'working');

    core.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('emits standby when switching to an empty/new conversation to clear stale display', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-empty-switch-'));
    const t1 = path.join(dir, 't1.jsonl');
    const t2 = path.join(dir, 't2.jsonl');

    fs.writeFileSync(
      t1,
      `${JSON.stringify({ type: 'USER_INPUT', step_index: 1 })}\n`,
      'utf-8'
    );
    fs.writeFileSync(t2, '', 'utf-8');

    const core = new TaskbarCore({ tailerOptions: { pollIntervalMs: 10000 } });
    const statuses = [];
    core.on('status', (s) => statuses.push(s));

    core.attachToConversation({ id: 'conv-1', transcriptPath: t1 });
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].state, 'working');

    core.attachToConversation({ id: 'conv-empty', transcriptPath: t2 });
    assert.equal(statuses.length, 2);
    assert.equal(statuses[1].state, 'standby');
    assert.equal(statuses[1].title, 'Antigravity 就绪');

    core.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects active conversation asynchronously across multiple product brain directories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-detector-test-'));
    const ideBrain = path.join(root, 'antigravity-ide', 'brain');
    const cliBrain = path.join(root, 'antigravity-cli', 'brain');

    const convOldDir = path.join(ideBrain, 'conv-old', '.system_generated', 'logs');
    const convNewDir = path.join(cliBrain, 'conv-new', '.system_generated', 'logs');
    fs.mkdirSync(convOldDir, { recursive: true });
    fs.mkdirSync(convNewDir, { recursive: true });

    const oldFile = path.join(convOldDir, 'transcript.jsonl');
    const newFile = path.join(convNewDir, 'transcript.jsonl');
    fs.writeFileSync(oldFile, '{}\n', 'utf-8');
    fs.writeFileSync(newFile, '{}\n', 'utf-8');

    const nowSec = Date.now() / 1000;
    fs.utimesSync(oldFile, nowSec - 60, nowSec - 60);
    fs.utimesSync(newFile, nowSec, nowSec);

    const detector = new ConversationDetector({ baseDirs: [ideBrain, cliBrain] });
    const active = await detector.detectActiveConversation();

    assert.ok(active);
    assert.equal(active.id, 'conv-new');
    assert.equal(active.transcriptPath, newFile);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('prefers transcript_full.jsonl over transcript.jsonl and prevents downgrade ping-pong', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-full-prefer-'));
    const brainDir = path.join(root, 'antigravity', 'brain');
    const logsDir = path.join(brainDir, 'conv-full', '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const compactFile = path.join(logsDir, 'transcript.jsonl');
    const fullFile = path.join(logsDir, 'transcript_full.jsonl');
    fs.writeFileSync(compactFile, `${JSON.stringify({ type: 'USER_INPUT', step_index: 1 })}\n`, 'utf-8');
    fs.writeFileSync(fullFile, `${JSON.stringify({ type: 'USER_INPUT', step_index: 1 })}\n`, 'utf-8');

    const detector = new ConversationDetector({ baseDirs: [brainDir] });
    const active = await detector.detectActiveConversation();
    assert.ok(active);
    assert.equal(active.transcriptPath, fullFile);

    // Core should not tear down / re-emit when attachToConversation receives compact path or casing variance
    const core = new TaskbarCore({ tailerOptions: { pollIntervalMs: 10000 } });
    const statuses = [];
    core.on('status', (s) => statuses.push(s));

    core.handleHookEvent({
      hookEventName: 'PreInvocation',
      conversationId: 'conv-full',
      transcriptPath: fullFile
    });
    assert.equal(statuses.length, 1);

    core.attachToConversation({ id: 'conv-full', transcriptPath: compactFile });
    core.attachToConversation({ id: 'conv-full', transcriptPath: fullFile.toUpperCase() });
    assert.equal(statuses.length, 1);
    assert.equal(core.currentTranscriptPath, fullFile);

    core.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves review waiting state across Stop(NO_TOOL_CALL) and clears it on USER_CANCELED or ERROR', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-review-stop-'));
    const tPath = path.join(dir, 'transcript_full.jsonl');
    fs.writeFileSync(
      tPath,
      `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 10,
        created_at: new Date().toISOString(),
        tool_calls: [
          {
            name: 'write_file',
            args: {
              Path: 'C:\\brain\\implementation_plan.md',
              ArtifactMetadata: { RequestFeedback: true, UserFacing: true }
            }
          }
        ]
      })}\n`,
      'utf-8'
    );

    const core = new TaskbarCore({ tailerOptions: { pollIntervalMs: 10000 } });
    const statuses = [];
    core.on('status', (s) => statuses.push(s));

    core.attachToConversation({ id: 'conv-review', transcriptPath: tPath });
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].state, 'working');

    // Stop with NO_TOOL_CALL should emit waiting instead of completed
    core.handleHookEvent({
      hookEventName: 'Stop',
      conversationId: 'conv-review',
      transcriptPath: tPath,
      terminationReason: 'NO_TOOL_CALL'
    });
    assert.equal(statuses.length, 2);
    assert.equal(statuses[1].state, 'waiting');
    assert.match(statuses[1].detail, /implementation_plan\.md/);

    // Stop with USER_CANCELED clears pendingReview and emits standby
    core.handleHookEvent({
      hookEventName: 'Stop',
      conversationId: 'conv-review',
      transcriptPath: tPath,
      terminationReason: 'USER_CANCELED'
    });
    assert.equal(statuses.length, 3);
    assert.equal(statuses[2].state, 'standby');
    assert.equal(core.parser.pendingReview, null);

    // ERROR also clears pendingReview
    core.parser.pendingReview = { fileName: 'plan.md', step: 11 };
    core.handleHookEvent({
      hookEventName: 'Stop',
      conversationId: 'conv-review',
      transcriptPath: tPath,
      terminationReason: 'ERROR',
      error: 'Boom'
    });
    assert.equal(statuses.length, 4);
    assert.equal(statuses[3].state, 'error');
    assert.equal(core.parser.pendingReview, null);

    core.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
