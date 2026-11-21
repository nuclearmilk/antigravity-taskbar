const { app, BrowserWindow, screen, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');

const {
  applyCliEnvOverrides,
  getRuntimeDataDir,
  getPipePath,
  appendLogWithRotation,
  selectHostPidFromProcesses,
  parseWmicProcesses,
  parseRegThemeOutput,
  loadSettings,
  computeWindowBounds,
  formatHwnd
} = require('./helpers.cjs');

applyCliEnvOverrides(process.argv, process.env);

const execFileAsync = promisify(execFile);

const logFile = path.join(getRuntimeDataDir(), 'taskbar.log');
function log(msg) {
  appendLogWithRotation(logFile, msg);
}

process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err?.stack || err}`);
});
process.on('unhandledRejection', (err) => {
  log(`unhandledRejection: ${err?.stack || err}`);
});

// 禁用 GPU 硬件加速防崩溃
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let mainWindow = null;
let coreInstance = null;
let pipeServer = null;
let livenessTimer = null;
let retryTimer = null;
let topmostTimer = null;
let isShuttingDown = false;
let lastActivityAt = Date.now();
let currentTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
const pendingHookEvents = [];

let lastStatusData = {
  state: 'standby',
  title: 'Antigravity 就绪',
  detail: 'STANDBY · 随时可指派新任务',
  step: 0,
  ts: Date.now()
};

function parseHookFromArgv(argv = []) {
  if (!Array.isArray(argv)) return null;
  let payload = null;

  const hookB64Arg = argv.find((a) => typeof a === 'string' && a.startsWith('--hook-b64='));
  if (hookB64Arg) {
    try {
      const b64 = hookB64Arg.slice('--hook-b64='.length);
      const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
      if (parsed && typeof parsed === 'object') {
        payload = parsed;
      }
    } catch {}
  }

  const transcriptArg = argv.find((a) => typeof a === 'string' && a.startsWith('--transcript='));
  if (transcriptArg) {
    const transcriptPath = transcriptArg.slice('--transcript='.length).trim();
    if (transcriptPath) {
      payload = payload || {};
      if (!payload.transcriptPath) payload.transcriptPath = transcriptPath;
    }
  }

  return payload;
}

function dispatchHookPayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  lastActivityAt = Date.now();
  log(`Received hook event: ${payload.hookEventName || 'transcript'} (${payload.conversationId || payload.transcriptPath || ''})`);
  if (coreInstance) {
    coreInstance.handleHookEvent(payload);
  } else {
    pendingHookEvents.push(payload);
  }
}

// 单例互斥锁：严禁多开
const gotTheLock = app.requestSingleInstanceLock();
log(`requestSingleInstanceLock: ${gotTheLock}`);
if (!gotTheLock) {
  log('did not get lock, exiting');
  app.quit();
  setTimeout(() => app.exit(0), 500).unref();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const payload = parseHookFromArgv(commandLine);
    if (payload) {
      dispatchHookPayload(payload);
    }
  });
}

function gracefulShutdown(reason = 'normal') {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`gracefulShutdown triggered: ${reason}`);

  if (livenessTimer) {
    clearInterval(livenessTimer);
    livenessTimer = null;
  }
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  if (topmostTimer) {
    clearInterval(topmostTimer);
    topmostTimer = null;
  }

  if (coreInstance) {
    try {
      coreInstance.stop();
    } catch (err) {
      log(`core.stop error: ${err?.message || err}`);
    }
    coreInstance = null;
  }

  if (pipeServer) {
    try {
      pipeServer.close();
    } catch {}
    pipeServer = null;
    if (process.platform !== 'win32') {
      try {
        const pipePath = getPipePath();
        if (fs.existsSync(pipePath)) fs.unlinkSync(pipePath);
      } catch {}
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.close();
    } catch {}
  }

  app.quit();
  setTimeout(() => app.exit(0), 2000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

function startPipeServer() {
  const pipePath = getPipePath();
  if (process.platform !== 'win32') {
    try {
      if (fs.existsSync(pipePath)) fs.unlinkSync(pipePath);
    } catch {}
  }

  pipeServer = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf-8');

    const processMessage = (rawLine) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed);
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'hook' && msg.payload) {
          dispatchHookPayload(msg.payload);
        } else if (msg.hookEventName || msg.transcriptPath) {
          dispatchHookPayload(msg);
        }
      } catch (err) {
        log(`Pipe message parse error: ${err?.message || err}`);
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        processMessage(line);
      }
    });

    socket.on('end', () => {
      if (buffer.trim()) {
        processMessage(buffer);
        buffer = '';
      }
    });

    socket.on('error', () => {
      // ignore client disconnect
    });
  });

  pipeServer.on('error', (err) => {
    log(`Pipe server error (${pipePath}): ${err?.message || err}`);
  });

  pipeServer.listen(pipePath, () => {
    log(`Pipe server listening on ${pipePath}`);
  });
}

async function detectHostPidViaCim() {
  if (process.platform !== 'win32') return null;
  try {
    const script = `
      $ProgressPreference = 'SilentlyContinue'
      $procs = @(Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe'" | ForEach-Object {
        [PSCustomObject]@{
          ProcessId = $_.ProcessId
          ParentProcessId = $_.ParentProcessId
          CommandLine = $_.CommandLine
          CreationTs = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }
        }
      })
      if ($procs.Count -gt 0) { $procs | ConvertTo-Json -Compress }
    `;
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
      { encoding: 'utf-8', windowsHide: true, timeout: 4000 }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return selectHostPidFromProcesses(list);
  } catch {
    return null;
  }
}

async function detectHostPidViaWmic() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync(
      'wmic',
      [
        'process',
        'where',
        "Name='Antigravity.exe'",
        'get',
        'ProcessId,ParentProcessId,CreationDate,CommandLine',
        '/format:value'
      ],
      { encoding: 'utf-8', windowsHide: true, timeout: 3000 }
    );
    const list = parseWmicProcesses(stdout);
    return selectHostPidFromProcesses(list);
  } catch {
    return null;
  }
}

async function detectHostPid() {
  return (await detectHostPidViaCim()) || (await detectHostPidViaWmic());
}

function attachLivenessWatch(hostPid) {
  if (livenessTimer) {
    clearInterval(livenessTimer);
    livenessTimer = null;
  }

  let currentPid = hostPid;
  let missingCount = 0;
  let revalidating = false;

  livenessTimer = setInterval(async () => {
    if (isShuttingDown || revalidating) return;

    try {
      // 极速内核系统调用：零开销探活
      process.kill(currentPid, 0);
      missingCount = 0;
    } catch (e) {
      // EPERM 表示高权限进程存活但无信号权限
      if (e.code === 'EPERM') {
        missingCount = 0;
        return;
      }

      missingCount++;
      if (missingCount >= 2) {
        revalidating = true;
        try {
          const replacementPid = await detectHostPid();
          if (isShuttingDown) return;

          if (replacementPid && replacementPid !== currentPid) {
            log(`Host PID ${currentPid} exited, switching liveness watch to surviving root PID ${replacementPid}`);
            currentPid = replacementPid;
            missingCount = 0;
            return;
          }

          log(`Host Antigravity PID ${currentPid} has exited and no surviving root process found.`);
          gracefulShutdown('host-exited');
        } finally {
          revalidating = false;
        }
      }
    }
  }, 1000);
}

async function startHostLifecycleWatcher() {
  if (process.platform !== 'win32') {
    log('Non-Windows platform: host PID watch skipped');
    return;
  }

  const hostPidArg = process.argv.find((a) => a.startsWith('--host-pid='));
  let hostPid = hostPidArg ? parseInt(hostPidArg.split('=')[1], 10) : null;

  if (!hostPid) {
    hostPid = await detectHostPid();
  }

  if (isShuttingDown) return;

  log(`startHostLifecycleWatcher watching host GUI PID: ${hostPid || 'none'}`);

  if (hostPid) {
    attachLivenessWatch(hostPid);
    return;
  }

  log('WARN: host PID unresolved, entering self-healing retry mode');
  let retries = 0;
  let probing = false;

  retryTimer = setInterval(async () => {
    if (isShuttingDown || probing) return;
    probing = true;
    try {
      retries++;
      const pid = await detectHostPid();
      if (isShuttingDown) return;

      if (pid) {
        clearInterval(retryTimer);
        retryTimer = null;
        log(`host PID recovered: ${pid}, switching to liveness watch`);
        attachLivenessWatch(pid);
        return;
      }

      if (Date.now() - lastActivityAt < 3 * 60 * 1000) {
        retries = 0;
        return;
      }

      if (retries >= 6) {
        clearInterval(retryTimer);
        retryTimer = null;
        log('WARN: host PID still unresolved after 6 retries (~3min), exiting; next hook will relaunch.');
        gracefulShutdown('host-unresolved');
      }
    } finally {
      probing = false;
    }
  }, 30000);
}

async function detectTaskbarTheme() {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync(
        'reg.exe',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
          '/v',
          'SystemUsesLightTheme'
        ],
        { encoding: 'utf-8', windowsHide: true, timeout: 2000 }
      );
      const parsed = parseRegThemeOutput(stdout);
      if (parsed) return parsed;
    } catch {}
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

async function refreshTheme() {
  const nextTheme = await detectTaskbarTheme();
  currentTheme = nextTheme;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('taskbar:theme', currentTheme);
  }
}

async function startCoreWatcher() {
  try {
    const coreFilePath = path.resolve(__dirname, '../core/index.js');
    const coreUrl = pathToFileURL(coreFilePath).href;
    const { TaskbarCore } = await import(coreUrl);
    if (isShuttingDown) return;

    coreInstance = new TaskbarCore();

    coreInstance.on('status', (data) => {
      lastActivityAt = Date.now();
      lastStatusData = data;
      log(`Status event: [${data.state}] ${data.title} - ${data.detail}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('taskbar:status', data);
        if (mainWindow.isVisible()) {
          mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
          mainWindow.moveTop();
        }
      }
    });

    const initialHook = parseHookFromArgv(process.argv);
    if (initialHook) {
      coreInstance.handleHookEvent(initialHook);
    }

    while (pendingHookEvents.length > 0) {
      const evt = pendingHookEvents.shift();
      coreInstance.handleHookEvent(evt);
    }

    coreInstance.start();
  } catch (err) {
    log(`startCoreWatcher error: ${err?.stack || err}`);
  }
}

function createWindow() {
  log('createWindow called');
  try {
    const settings = loadSettings(getRuntimeDataDir());
    const updateWindowBounds = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const primaryDisplay = screen.getPrimaryDisplay();
      const bounds = computeWindowBounds(primaryDisplay, settings);
      mainWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      });
      log(
        `updateWindowBounds: x=${bounds.x}, y=${bounds.y}, w=${bounds.width}, h=${bounds.height}, display=${JSON.stringify(
          primaryDisplay.bounds
        )}, workArea=${JSON.stringify(primaryDisplay.workArea)}`
      );
    };

    const primaryDisplay = screen.getPrimaryDisplay();
    const initialBounds = computeWindowBounds(primaryDisplay, settings);

    log(
      `initial geometry: x=${initialBounds.x}, y=${initialBounds.y}, w=${initialBounds.width}, h=${initialBounds.height}, align=${settings.align}, visibleOnFullScreen=${settings.visibleOnFullScreen}`
    );

    mainWindow = new BrowserWindow({
      width: initialBounds.width,
      height: initialBounds.height,
      x: initialBounds.x,
      y: initialBounds.y,
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      hasShadow: false,
      webPreferences: {
        preload: path.resolve(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    mainWindow.setIgnoreMouseEvents(true);
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    if (process.platform === 'darwin') {
      mainWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: Boolean(settings.visibleOnFullScreen)
      });
    }

    const htmlPath = path.resolve(__dirname, '../ui/index.html');
    mainWindow.loadFile(htmlPath);

    mainWindow.once('ready-to-show', () => {
      log('ready-to-show event');
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.showInactive();
      mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
      if (process.platform === 'darwin') {
        mainWindow.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: Boolean(settings.visibleOnFullScreen)
        });
      }
      mainWindow.setSkipTaskbar(true);
      mainWindow.setIgnoreMouseEvents(true);
      const hwnd = formatHwnd(mainWindow.getNativeWindowHandle());
      log(`hwnd=${hwnd}, isVisible=${mainWindow.isVisible()}, bounds=${JSON.stringify(mainWindow.getBounds())}`);
    });

    mainWindow.webContents.on('did-finish-load', () => {
      log('did-finish-load event');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('taskbar:theme', currentTheme);
        if (lastStatusData) {
          mainWindow.webContents.send('taskbar:status', lastStatusData);
        }
      }
      void refreshTheme();
    });

    mainWindow.on('closed', () => {
      log('mainWindow closed');
      mainWindow = null;
    });

    screen.on('display-metrics-changed', updateWindowBounds);
    screen.on('display-added', updateWindowBounds);
    screen.on('display-removed', updateWindowBounds);

    nativeTheme.on('updated', () => {
      void refreshTheme();
    });

    // 定时置顶心跳守护：解决 Windows 11 任务栏重绘抢占 Z 轴的问题
    topmostTimer = setInterval(() => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        mainWindow.moveTop();
      }
    }, 800);

    startPipeServer();
    void refreshTheme();
    void startCoreWatcher();
    void startHostLifecycleWatcher();
  } catch (err) {
    log(`createWindow exception: ${err?.stack || err}`);
  }
}

if (gotTheLock) {
  app.whenReady().then(createWindow);

  app.on('before-quit', () => {
    if (!isShuttingDown) {
      gracefulShutdown('before-quit');
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      gracefulShutdown('window-all-closed');
    }
  });
}
