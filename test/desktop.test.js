import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import {
  trySendToPipe,
  buildRunnerArgs,
  extractHookPayload,
  launchTaskbarStatus
} from '../desktop/launcher.js';

const require = createRequire(import.meta.url);
const {
  applyCliEnvOverrides,
  selectHostPidFromProcesses,
  parseWmicProcesses,
  parseRegThemeOutput,
  computeWindowBounds,
  formatHwnd,
  appendLogWithRotation
} = require('../desktop/helpers.cjs');

describe('desktop helpers & IPC', () => {
  it('selects main root Antigravity.exe process via process tree when CommandLine is null (elevated)', () => {
    const procs = [
      // Child GPU process created earlier/later with null CommandLine
      { ProcessId: 200, ParentProcessId: 100, CommandLine: null, CreationTs: 2000 },
      // Child renderer process with null CommandLine
      { ProcessId: 300, ParentProcessId: 100, CommandLine: null, CreationTs: 3000 },
      // Actual root main GUI process (parent is explorer.exe = 50)
      { ProcessId: 100, ParentProcessId: 50, CommandLine: null, CreationTs: 1000 }
    ];

    assert.equal(selectHostPidFromProcesses(procs), 100);
  });

  it('prefers elevated root process with Antigravity.exe children over earlier standalone sidecar root', () => {
    const procs = [
      // Earlier standalone Sidecar root (CommandLine: null, 0 Antigravity.exe children)
      { ProcessId: 5936, ParentProcessId: 16956, CommandLine: null, CreationTs: 1795233985113 },
      // Slightly later GUI main process (CommandLine: null, has GPU/renderer children)
      { ProcessId: 16244, ParentProcessId: 6660, CommandLine: null, CreationTs: 1795234145456 },
      { ProcessId: 232, ParentProcessId: 16244, CommandLine: null, CreationTs: 1795234145600 },
      { ProcessId: 11800, ParentProcessId: 16244, CommandLine: null, CreationTs: 1795234145700 }
    ];

    assert.equal(selectHostPidFromProcesses(procs), 16244);
  });

  it('filters out --type= and --import= root processes when CommandLine is available', () => {
    const procs = [
      {
        ProcessId: 5936,
        ParentProcessId: 16956,
        CommandLine: '"Antigravity.exe" --import=file:///sidecar/register_loader.js main.mjs',
        CreationTs: 1000
      },
      {
        ProcessId: 16244,
        ParentProcessId: 6660,
        CommandLine: '"Antigravity.exe" --updated',
        CreationTs: 2000
      },
      {
        ProcessId: 232,
        ParentProcessId: 16244,
        CommandLine: '"Antigravity.exe" --type=gpu-process',
        CreationTs: 2001
      }
    ];

    assert.equal(selectHostPidFromProcesses(procs), 16244);
  });

  it('parses WMIC /format:value output and Windows registry theme output', () => {
    const wmicOut = [
      'CommandLine="C:\\\\App\\\\Antigravity.exe" --updated',
      'CreationDate=20261121120905.123456+480',
      'ParentProcessId=6660',
      'ProcessId=16244',
      '',
      'CommandLine="C:\\\\App\\\\Antigravity.exe" --type=renderer',
      'CreationDate=20261121120906.000000+480',
      'ParentProcessId=16244',
      'ProcessId=232'
    ].join('\r\n');

    const parsed = parseWmicProcesses(wmicOut);
    assert.equal(parsed.length, 2);
    assert.equal(selectHostPidFromProcesses(parsed), 16244);

    assert.equal(
      parseRegThemeOutput('    SystemUsesLightTheme    REG_DWORD    0x0\r\n'),
      'dark'
    );
    assert.equal(
      parseRegThemeOutput('    SystemUsesLightTheme    REG_DWORD    0x1\r\n'),
      'light'
    );
    assert.equal(parseRegThemeOutput('ERROR: not found'), null);
  });

  it('computes window bounds for bottom, top, auto-hide, multi-monitor, and aligned layouts', () => {
    const bottomDisplay = {
      bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: 1920, y: 0, width: 1920, height: 1032 }
    };
    const center = computeWindowBounds(bottomDisplay, { align: 'center', width: 600, offsetX: 0 });
    assert.deepEqual(center, { x: 1920 + 660, y: 1034, width: 600, height: 44, taskbarHeight: 48 });

    const left = computeWindowBounds(bottomDisplay, { align: 'left', width: 400, offsetX: 10 });
    assert.equal(left.x, 1920 + 26);
    assert.equal(left.width, 400);

    const topDisplay = {
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 48, width: 1920, height: 1032 }
    };
    const topBounds = computeWindowBounds(topDisplay, { align: 'right', width: 500, offsetX: 0 });
    assert.equal(topBounds.y, 2);
    assert.equal(topBounds.x, 1920 - 500 - 16);

    const autoHideDisplay = {
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    };
    const autoHideBounds = computeWindowBounds(autoHideDisplay, {});
    assert.equal(autoHideBounds.y, 1080 - 48 + 2);
  });

  it('formats 64-bit and 32-bit HWND buffers safely and rotates oversized logs', () => {
    const buf64 = Buffer.alloc(8);
    buf64.writeBigUInt64LE(0x123456789abcn, 0);
    assert.equal(formatHwnd(buf64), String(0x123456789abcn));

    const buf32 = Buffer.alloc(4);
    buf32.writeUInt32LE(424242, 0);
    assert.equal(formatHwnd(buf32), '424242');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-log-test-'));
    const logFile = path.join(dir, 'taskbar.log');
    appendLogWithRotation(logFile, 'x'.repeat(100), 80);
    appendLogWithRotation(logFile, 'second-line', 80);

    assert.equal(fs.existsSync(`${logFile}.1`), true);
    assert.match(fs.readFileSync(logFile, 'utf-8'), /second-line/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('delivers hook payload over named pipe / unix socket', async () => {
    const pipeName =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\ag-taskbar-test-${process.pid}-${Date.now()}`
        : path.join(os.tmpdir(), `ag-taskbar-test-${process.pid}-${Date.now()}.sock`);

    const received = [];
    let resolveServerDone;
    const serverDone = new Promise((resolve) => {
      resolveServerDone = resolve;
    });

    const server = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (c) => {
        buf += c.toString('utf-8');
        if (buf.includes('\n')) {
          received.push(JSON.parse(buf.trim()));
          resolveServerDone();
        }
      });
      socket.on('end', () => {
        if (received.length === 0 && buf.trim()) {
          received.push(JSON.parse(buf.trim()));
        }
        resolveServerDone();
      });
    });

    await new Promise((resolve) => server.listen(pipeName, resolve));
    try {
      const ok = await trySendToPipe(pipeName, {
        hookEventName: 'Stop',
        conversationId: 'c1',
        terminationReason: 'NO_TOOL_CALL'
      });
      assert.equal(ok, true);
      await Promise.race([
        serverDone,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Pipe server timeout')), 1000))
      ]);
      assert.equal(received.length, 1);
      assert.equal(received[0].type, 'hook');
      assert.equal(received[0].payload.terminationReason, 'NO_TOOL_CALL');
    } finally {
      server.close();
    }
  });

  it('propagates PLUGIN_DATA/env overrides to runner args, truncates error, and skips cold-launch on Stop', async () => {
    const fakeEnv = {
      PLUGIN_DATA: 'C:\\custom\\plugin-data',
      ANTIGRAVITY_APP_DATA_DIR: 'C:\\custom\\app-data',
      ANTIGRAVITY_TASKBAR_ALIGN: 'left',
      ANTIGRAVITY_TASKBAR_OFFSET_X: '24',
      ANTIGRAVITY_TASKBAR_WIDTH: '480',
      ANTIGRAVITY_TASKBAR_FULLSCREEN: 'true'
    };

    const args = buildRunnerArgs('runner.cjs', { hookEventName: 'SessionStart' }, fakeEnv);
    const parsedEnv = applyCliEnvOverrides(args, {});
    assert.equal(parsedEnv.PLUGIN_DATA, 'C:\\custom\\plugin-data');
    assert.equal(parsedEnv.ANTIGRAVITY_APP_DATA_DIR, 'C:\\custom\\app-data');
    assert.equal(parsedEnv.ANTIGRAVITY_TASKBAR_ALIGN, 'left');
    assert.equal(parsedEnv.ANTIGRAVITY_TASKBAR_OFFSET_X, '24');
    assert.equal(parsedEnv.ANTIGRAVITY_TASKBAR_WIDTH, '480');
    assert.equal(parsedEnv.ANTIGRAVITY_TASKBAR_FULLSCREEN, 'true');

    const longErrPayload = extractHookPayload(
      JSON.stringify({ hookEventName: 'Stop', error: 'E'.repeat(500) })
    );
    assert.equal(longErrPayload.error.length, 300);

    const nonexistentPipe =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\ag-nonexistent-${process.pid}-${Date.now()}`
        : path.join(os.tmpdir(), `ag-nonexistent-${process.pid}-${Date.now()}.sock`);
    const res = await launchTaskbarStatus(
      { hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL' },
      { pipePath: nonexistentPipe, pipeTimeoutMs: 50 }
    );
    assert.deepEqual(res, { status: 'skipped-stop', pid: null });
  });
});
