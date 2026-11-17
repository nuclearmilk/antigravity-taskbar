import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pidFile = path.resolve(__dirname, 'taskbar.pid');

export function findElectron() {
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
  } catch (e) {}

  // 2. 预设候选路径
  const candidates = [
    process.env.ELECTRON_PATH,
    path.resolve(__dirname, '../node_modules/electron/dist', exe),
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'electron', exe),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'electron', exe)
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      return c;
    }
  }

  // 3. 系统 PATH
  try {
    const cmd = isWin ? 'where.exe electron' : 'which electron';
    const found = execSync(cmd, { encoding: 'utf-8', windowsHide: true }).split(/\r?\n/)[0]?.trim();
    if (found && fs.existsSync(found)) {
      if (found.endsWith('.cmd') || found.endsWith('.bat')) {
        const distBin = path.resolve(path.dirname(found), '../electron/dist', exe);
        if (fs.existsSync(distBin)) return distBin;
      } else {
        return found;
      }
    }
  } catch (e) {}

  return null;
}

export function isTaskbarRunning() {
  try {
    if (fs.existsSync(pidFile)) {
      const pidStr = fs.readFileSync(pidFile, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      if (pid && !isNaN(pid)) {
        process.kill(pid, 0);
        return true;
      }
    }
  } catch (e) {}
  return false;
}

export function findAntigravityHostPid() {
  try {
    const isWin = process.platform === 'win32';
    if (!isWin) return null;
    const out = execSync('wmic process where "Name=\'Antigravity.exe\' and not CommandLine like \'%--type=%\' and not CommandLine like \'%--import=%\'" get ProcessId', {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 2500
    });
    const match = out.match(/\b(\d+)\b/);
    return match ? parseInt(match[1], 10) : null;
  } catch (e) {
    return null;
  }
}

export function launchTaskbarStatus() {
  if (isTaskbarRunning()) {
    return null;
  }

  const electronBin = findElectron();
  if (!electronBin) {
    const logFile = path.resolve(__dirname, 'taskbar.log');
    try {
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] Electron runtime not found. Please run 'npm install' in the plugin directory to install electron.\n`, 'utf-8');
    } catch (e) {}
    return null;
  }

  const runnerScript = path.join(__dirname, 'runner.cjs');
  const hostPid = findAntigravityHostPid();
  const hostPidArg = hostPid ? ` --host-pid=${hostPid}` : '';

  // 通过 WMI 创建系统级常驻进程，彻底脱离父终端树，并传入宿主 PID 进行精准生命周期绑定
  const cmd = `wmic process call create "\\"${electronBin.replace(/\\/g, '\\\\')}\\" \\"${runnerScript.replace(/\\/g, '\\\\')}\\"${hostPidArg}"`;
  try {
    const out = execSync(cmd, { windowsHide: true, encoding: 'utf-8' });
    const match = out.match(/ProcessId\s*=\s*(\d+);/);
    if (match && match[1]) {
      const newPid = match[1];
      try {
        fs.writeFileSync(pidFile, newPid, 'utf-8');
      } catch (e) {}
      return parseInt(newPid, 10);
    }
  } catch (e) {}

  return null;
}

try {
  launchTaskbarStatus();
} catch (e) {}

process.stdout.write(JSON.stringify({}));
process.exit(0);
