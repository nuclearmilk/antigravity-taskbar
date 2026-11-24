import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventParser } from '../core/parser.js';

describe('EventParser', () => {
  it('parses USER_INPUT into working state', () => {
    const parser = new EventParser();
    const events = [];
    parser.on('status', (e) => events.push(e));

    parser.processLine(
      JSON.stringify({
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        step_index: 0,
        created_at: new Date().toISOString()
      })
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].state, 'working');
    assert.match(events[0].title, /分析需求/);
    assert.equal(events[0].step, 0);
  });

  it('parses single tool calls and differentiates write_file, read_file, invoke_subagent, etc.', () => {
    const parser = new EventParser();

    const writeStatus = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 3,
        tool_calls: [{ name: 'write_file', args: { Path: '/tmp/foo/bar.js' } }]
      }),
      { silent: true }
    );
    assert.equal(writeStatus.state, 'working');
    assert.equal(writeStatus.detail, '[写入] bar.js');
    assert.equal(writeStatus.step, 3);

    const readStatus = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 4,
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: 'C:\\repo\\main.ts' } }]
      }),
      { silent: true }
    );
    assert.equal(readStatus.detail, '[读取] main.ts');

    const subagentStatus = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 5,
        tool_calls: [{ name: 'invoke_subagent', args: { Role: 'Codebase Researcher', TypeName: 'research' } }]
      }),
      { silent: true }
    );
    assert.equal(subagentStatus.detail, '[子代理] Codebase Researcher');

    const workflowStatus = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 6,
        tool_calls: [{ name: 'run_workflow', args: { Description: 'Fan out tests' } }]
      }),
      { silent: true }
    );
    assert.equal(workflowStatus.detail, '[工作流] Fan out tests');

    const swarmStatus = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 7,
        tool_calls: [{ name: 'swarm', args: { action: 'add', name: 'worker-1' } }]
      }),
      { silent: true }
    );
    assert.equal(swarmStatus.detail, '[Swarm] add worker-1');
  });

  it('defends against non-string args fields without throwing', () => {
    const parser = new EventParser();
    const res = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 2,
        tool_calls: [
          {
            name: 'run_command',
            args: { CommandLine: 12345, toolSummary: { bad: true } }
          }
        ]
      }),
      { silent: true }
    );

    assert.equal(res.state, 'working');
    assert.equal(res.title, '执行中: run_command (#2)');
    assert.equal(res.detail, '[run_command] 执行中');
  });

  it('shows parallel count for multiple tool calls and prioritizes ask_question anywhere in array', () => {
    const parser = new EventParser();

    const parallel = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 5,
        tool_calls: [
          { name: 'read_file', args: { Path: 'a.js' } },
          { name: 'read_file', args: { Path: 'b.js' } },
          { name: 'grep_search', args: { Query: 'hello' } }
        ]
      }),
      { silent: true }
    );
    assert.equal(parallel.state, 'working');
    assert.match(parallel.title, /\(\+2 项\)/);

    const waiting = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 6,
        tool_calls: [
          { name: 'read_file', args: { Path: 'a.js' } },
          { name: 'ask_question', args: { questions: [] } }
        ]
      }),
      { silent: true }
    );
    assert.equal(waiting.state, 'waiting');
  });

  it('handles PLANNER_RESPONSE DONE, ERROR, CANCELED, and thinking states', () => {
    const parser = new EventParser();
    const now = Date.parse('2026-11-21T12:00:30Z');

    const thinking = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'RUNNING',
        step_index: 4,
        thinking: 'Analyzing dependencies...'
      }),
      { silent: true, now }
    );
    assert.equal(thinking.state, 'working');
    assert.equal(thinking.detail, '深度推理中');

    const err = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'ERROR',
        step_index: 4,
        error: 'Rate limit exceeded'
      }),
      { silent: true, now }
    );
    assert.equal(err.state, 'error');
    assert.equal(err.detail, 'Rate limit exceeded');

    const canceled = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'CANCELED',
        step_index: 4
      }),
      { silent: true, now }
    );
    assert.equal(canceled.state, 'standby');

    const recentDone = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 5,
        created_at: '2026-11-21T12:00:25Z'
      }),
      { silent: true, now }
    );
    assert.equal(recentDone.state, 'completed');
    assert.equal(recentDone.isHistorical, false);
  });

  it('marks historical DONE events older than 20s as standby and supports reset()', () => {
    const parser = new EventParser();
    const now = Date.parse('2026-11-21T12:05:00Z');

    const historicalDone = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 12,
        created_at: '2026-11-21T12:00:00Z'
      }),
      { silent: true, now }
    );

    assert.equal(parser.currentStep, 12);
    assert.equal(historicalDone.state, 'standby');
    assert.equal(historicalDone.isHistorical, true);
    assert.equal(historicalDone.eventTs, Date.parse('2026-11-21T12:00:00Z'));

    parser.reset();
    assert.equal(parser.currentStep, 0);
  });

  it('parses numeric created_at timestamps for both recent and historical events', () => {
    const parser = new EventParser();
    const now = 1795234000000;

    const recent = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 3,
        created_at: now - 5000
      }),
      { silent: true, now }
    );
    assert.equal(recent.state, 'completed');
    assert.equal(recent.isHistorical, false);
    assert.equal(recent.eventTs, now - 5000);

    const historical = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 4,
        created_at: now - 30000
      }),
      { silent: true, now }
    );
    assert.equal(historical.state, 'standby');
    assert.equal(historical.isHistorical, true);
    assert.equal(historical.eventTs, now - 30000);
  });

  it('tracks ArtifactMetadata RequestFeedback waiting state and clears on RequestFeedback:false, USER_INPUT, or historical DONE', () => {
    const parser = new EventParser();
    const now = Date.parse('2026-11-24T08:31:45Z');

    // 1. Object-form ArtifactMetadata (from transcript_full.jsonl)
    const writeReq = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 29,
        created_at: now - 5000,
        tool_calls: [
          {
            name: 'write_file',
            args: {
              Path: 'C:\\brain\\taskbar_notify_test.md',
              ArtifactMetadata: { RequestFeedback: true, UserFacing: true }
            }
          }
        ]
      }),
      { silent: true, now }
    );
    assert.equal(writeReq.state, 'working');
    assert.equal(writeReq.detail, '[写入] taskbar_notify_test.md');

    const reviewWait = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 31,
        created_at: now - 1000
      }),
      { silent: true, now }
    );
    assert.equal(reviewWait.state, 'waiting');
    assert.equal(reviewWait.title, 'Antigravity 等待审阅确认...');
    assert.match(reviewWait.detail, /taskbar_notify_test\.md/);
    assert.match(reviewWait.detail, /Proceed/);

    // USER_INPUT clears pendingReview so the next turn completes normally
    parser.processLine(
      JSON.stringify({ type: 'USER_INPUT', step_index: 32, created_at: now }),
      { silent: true, now }
    );
    const nextDone = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 33,
        created_at: now
      }),
      { silent: true, now }
    );
    assert.equal(nextDone.state, 'completed');

    // 2. JSON-string ArtifactMetadata (from transcript.jsonl) & RequestFeedback:false clearing
    parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 34,
        created_at: now - 2000,
        tool_calls: [
          {
            name: 'edit_file',
            args: {
              Path: '"C:\\\\brain\\\\plan.md"',
              ArtifactMetadata: JSON.stringify({ RequestFeedback: true })
            }
          }
        ]
      }),
      { silent: true, now }
    );
    assert.ok(parser.pendingReview);
    assert.equal(parser.pendingReview.fileName, 'plan.md');

    // Historical DONE (>20s) still yields standby instead of stale waiting
    const staleDone = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 35,
        created_at: now - 30000
      }),
      { silent: true, now }
    );
    assert.equal(staleDone.state, 'standby');

    // RequestFeedback: false on same file clears pendingReview
    parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 36,
        created_at: now - 1000,
        tool_calls: [
          {
            name: 'edit_file',
            args: {
              Path: 'C:\\brain\\plan.md',
              ArtifactMetadata: { RequestFeedback: false }
            }
          }
        ]
      }),
      { silent: true, now }
    );
    assert.equal(parser.pendingReview, null);
    const completedAfterClear = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 37,
        created_at: now
      }),
      { silent: true, now }
    );
    assert.equal(completedAfterClear.state, 'completed');
  });

  it('unwraps JSON-stringified CommandLine arguments with escaped quotes', () => {
    const parser = new EventParser();
    const res = parser.processLine(
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        step_index: 40,
        tool_calls: [
          {
            name: 'run_command',
            args: {
              CommandLine: JSON.stringify('Get-ChildItem -Path "C:\\Users\\demo"')
            }
          }
        ]
      }),
      { silent: true }
    );
    assert.equal(res.detail, '[命令] Get-ChildItem -Path "C:\\Users\\demo"');
  });
});
