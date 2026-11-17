const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const logFile = path.resolve(__dirname, 'taskbar.log');
function log(msg) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch (e) {}
}

process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err.stack || err}`);
});
process.on('unhandledRejection', (err) => {
  log(`unhandledRejection: ${err.stack || err}`);
});

// 禁用 GPU 硬件加速防崩溃
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

// 单例互斥锁：严禁多开
const gotTheLock = app.requestSingleInstanceLock();
log(`requestSingleInstanceLock: ${gotTheLock}`);
if (!gotTheLock) {
  log('did not get lock, exit');
  app.quit();
  process.exit(0);
}

const pidFile = path.resolve(__dirname, 'taskbar.pid');
try {
  fs.writeFileSync(pidFile, String(process.pid), 'utf-8');
} catch (e) {}

app.on('will-quit', () => {
  try {
    if (fs.existsSync(pidFile)) {
      const cur = fs.readFileSync(pidFile, 'utf-8').trim();
      if (cur === String(process.pid)) fs.unlinkSync(pidFile);
    }
  } catch (e) {}
});

let mainWindow = null;
let lastStatusData = {
  state: 'completed',
  title: 'Antigravity 就绪',
  detail: 'STANDBY · 随时可指派新任务',
  step: 0,
  ts: Date.now()
};

async function startCoreWatcher() {
  try {
    const coreFilePath = path.resolve(__dirname, '../core/index.js');
    const coreUrl = pathToFileURL(coreFilePath).href;
    const { TaskbarCore } = await import(coreUrl);
    const core = new TaskbarCore();

    core.on('status', (data) => {
      lastStatusData = data;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('taskbar:status', data);
        // 关键：状态更新时强行提升 Z 轴层级，防止被 Windows 11 任务栏遮盖
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        mainWindow.moveTop();
      }
    });

    core.start();
  } catch (err) {
    // 容错
  }
}

function createWindow() {
  log('createWindow called');
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.bounds;
    const { height: workAreaHeight } = primaryDisplay.workArea;

    const taskbarHeight = Math.max(40, screenHeight - workAreaHeight); // 常见 48px
    const winHeight = taskbarHeight - 4; // 留 2px 垂直居中余量
    const winWidth = 600; // 宽幅居中

    const x = Math.round((screenWidth - winWidth) / 2); // 居中
    const y = screenHeight - taskbarHeight + 2; // 嵌入任务栏内部 (Y=1034)

    log(`geometry: x=${x}, y=${y}, w=${winWidth}, h=${winHeight}, screen=${screenWidth}x${screenHeight}, workArea=${workAreaHeight}`);

    mainWindow = new BrowserWindow({
      width: winWidth,
      height: winHeight,
      x: x,
      y: y,
      show: true,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    const htmlPath = path.resolve(__dirname, '../ui/index.html');
    mainWindow.loadFile(htmlPath);

    mainWindow.once('ready-to-show', () => {
      log('ready-to-show event');
      mainWindow.show();
      mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      mainWindow.setSkipTaskbar(true); // Windows Shell 强制二次隐身
      mainWindow.setIgnoreMouseEvents(true); // 窗口就绪后开启全穿透
      const hwnd = mainWindow.getNativeWindowHandle().readInt32LE(0);
      log(`hwnd=${hwnd}, isVisible=${mainWindow.isVisible()}, bounds=${JSON.stringify(mainWindow.getBounds())}`);
    });

    mainWindow.webContents.on('did-finish-load', () => {
      log('did-finish-load event');
      mainWindow.showInactive();
      mainWindow.setSkipTaskbar(true);
      log(`did-finish-load: isVisible=${mainWindow.isVisible()}`);
      if (lastStatusData && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('taskbar:status', lastStatusData);
      }
    });

    mainWindow.on('closed', () => {
      log('mainWindow closed');
      mainWindow = null;
    });

    // 定时置顶心跳守护：彻底解决 Windows 11 任务栏重绘抢占 Z 轴将文字盖住的问题
    setInterval(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        mainWindow.moveTop();
      }
    }, 800);

    startCoreWatcher();
  } catch (err) {
    log(`createWindow exception: ${err.stack || err}`);
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
