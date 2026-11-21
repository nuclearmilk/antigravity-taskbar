import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  getPipePath,
  getRuntimeDataDir,
  appendLogWithRotation
} = require('./helpers.cjs');

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export { getPipePath };

function getLogFile() {
  return path.join(getRuntimeDataDir(), 'taskbar.log');
}

function logLauncher(msg) {
  appendLogWithRotation(getLogFile(), `[launcher] ${msg}`);
}

export async function findElectron() {
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'electron.exe' : 'electron';

  // 1. 本地项目 node_modules 中的 electron (npm install 后自动生成)
  try {
    const electronPkg = path.resolve(__dirname, '../node_modules/electron');
    const pathFile = path.join(electronPkg, 'path.txt');
    if (fs.existsSync(pathFile)) {
      const execName = fs.readFileSync(pathFile, 'utf-8').trim();
      const bin = path.join(electronPkg, 'dist', execName);
      if (fs.existsSync(bin)) return bin;
    }
  } catch {}

  // 2. 预设候选路径
  const candidates = [
    process.env.ELECTRON_PATH,
    path.resolve(__dirname, '../node_modules/electron/dist', exe),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'electron', exe)
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      return c;
    }
  }

  // 3. 系统 PATH (异步 execFile)
  try {
    const cmd = isWin ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(cmd, ['electron'], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 2000
    });
    const found = stdout.split(/\r?\n/)[0]?.trim();
    if (found && fs.existsSync(found)) {
      if (found.endsWith('.cmd') || found.endsWith('.bat')) {
        const distBin = path.resolve(path.dirname(found), '../electron/dist', exe);
        if (fs.existsSync(distBin)) return distBin;
      } else {
        return found;
      }
    }
  } catch {}

  return null;
}

export function extractHookPayload(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const payload = {};
    if (typeof parsed.hookEventName === 'string') payload.hookEventName = parsed.hookEventName;
    if (typeof parsed.conversationId === 'string') payload.conversationId = parsed.conversationId;
    if (typeof parsed.transcriptPath === 'string') payload.transcriptPath = parsed.transcriptPath;
    if (typeof parsed.terminationReason === 'string') payload.terminationReason = parsed.terminationReason;
    if (typeof parsed.error === 'string') payload.error = parsed.error.slice(0, 300);
    return Object.keys(payload).length > 0 ? payload : null;
  } catch {
    return null;
  }
}

export function readHookStdin(timeoutMs = 120) {
  if (process.stdin.isTTY) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      try {
        process.stdin.pause();
      } catch {}
    };

    const finish = (rawText) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(extractHookPayload(rawText));
    };

    const onData = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        finish(Buffer.concat(chunks).toString('utf-8'));
      }, timeoutMs);
    };

    const onEnd = () => {
      finish(Buffer.concat(chunks).toString('utf-8'));
    };

    const onError = () => {
      finish('');
    };

    timer = setTimeout(() => {
      finish(Buffer.concat(chunks).toString('utf-8'));
    }, timeoutMs);

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
    process.stdin.resume();
  });
}

export function trySendToPipe(pipePath, payload = null, timeoutMs = 200) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection(pipePath);

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      if (!ok) {
        try {
          socket.destroy();
        } catch {}
      }
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => {
      const msg = payload ? JSON.stringify({ type: 'hook', payload }) : JSON.stringify({ type: 'ping' });
      socket.end(`${msg}\n`, () => finish(true));
    });

    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export function buildRunnerArgs(runnerScript, payload, env = process.env) {
  const args = [runnerScript, `--data-dir=${getRuntimeDataDir(env)}`];

  const envMappings = [
    ['ANTIGRAVITY_APP_DATA_DIR', '--app-data-dir='],
    ['ANTIGRAVITY_TASKBAR_ALIGN', '--align='],
    ['ANTIGRAVITY_TASKBAR_OFFSET_X', '--offset-x='],
    ['ANTIGRAVITY_TASKBAR_WIDTH', '--width='],
    ['ANTIGRAVITY_TASKBAR_FULLSCREEN', '--fullscreen='],
    ['ANTIGRAVITY_TASKBAR_PIPE', '--pipe=']
  ];

  for (const [envKey, prefix] of envMappings) {
    if (typeof env[envKey] === 'string' && env[envKey] !== '') {
      args.push(`${prefix}${env[envKey]}`);
    }
  }

  if (payload && typeof payload === 'object') {
    if (typeof payload.transcriptPath === 'string' && payload.transcriptPath.trim()) {
      args.push(`--transcript=${payload.transcriptPath.trim()}`);
    }
    const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
    args.push(`--hook-b64=${b64}`);
  }
  return args;
}

export async function launchTaskbarStatus(payload = null, options = {}) {
  const pipePath = options.pipePath || getPipePath();
  const pipeTimeoutMs = options.pipeTimeoutMs ?? 200;

  // 优先通过命名管道探活并直接推送 Hook 数据（<10ms，零 PowerShell 调用）
  const alive = await trySendToPipe(pipePath, payload, pipeTimeoutMs);
  if (alive) {
    return { status: 'already-running', pid: null };
  }

  if (payload?.hookEventName === 'Stop') {
    return { status: 'skipped-stop', pid: null };
  }

  const electronBin = await findElectron();
  if (!electronBin) {
    logLauncher(
      "Electron runtime not found. Please run 'npm install' in the plugin directory to install electron."
    );
    return null;
  }

  const runnerScript = path.join(__dirname, 'runner.cjs');
  const args = buildRunnerArgs(runnerScript, payload);

  if (process.platform === 'win32') {
    const quoteArg = (a) => `"${String(a).replace(/"/g, '\\"')}"`;
    const targetCmd = [electronBin, ...args].map(quoteArg).join(' ');
    const psLiteral = `'${targetCmd.replace(/'/g, "''")}'`;

    // 1. 优先使用 PowerShell Invoke-CimMethod Win32_Process.Create（脱离 Hook 父进程 / Job Object）
    try {
      const script = `
        $ProgressPreference = 'SilentlyContinue'
        $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psLiteral} }
        if ($res.ReturnValue -eq 0) { [Console]::WriteLine($res.ProcessId) }
      `;
      const b64 = Buffer.from(script, 'utf16le').toString('base64');
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
        { windowsHide: true, encoding: 'utf-8', timeout: 4000 }
      );
      const match = stdout.match(/\b(\d+)\b/);
      if (match && match[1]) {
        return { status: 'launched', pid: parseInt(match[1], 10), method: 'cim' };
      }
    } catch {}

    // 2. 降级兼容：WMIC process call create
    try {
      const { stdout } = await execFileAsync(
        'wmic',
        ['process', 'call', 'create', targetCmd],
        { windowsHide: true, encoding: 'utf-8', timeout: 3000 }
      );
      const match = stdout.match(/ProcessId\s*=\s*(\d+);/);
      if (match && match[1]) {
        return { status: 'launched', pid: parseInt(match[1], 10), method: 'wmic' };
      }
    } catch {}
  }

  // 3. 最终降级：spawn detached + unref
  try {
    const child = spawn(electronBin, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return { status: 'launched', pid: child.pid || null, method: 'spawn' };
  } catch (err) {
    logLauncher(`Failed to launch electron runner: ${err?.message || err}`);
    return null;
  }
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  const entryPath = path.resolve(process.argv[1]);
  if (process.platform === 'win32') {
    return entryPath.toLowerCase() === __filename.toLowerCase();
  }
  return entryPath === __filename;
}

if (isMainEntry()) {
  (async () => {
    try {
      const payload = await readHookStdin();
      await launchTaskbarStatus(payload);
    } catch (err) {
      logLauncher(`Unexpected launcher error: ${err?.stack || err}`);
    } finally {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }
  })();
}
