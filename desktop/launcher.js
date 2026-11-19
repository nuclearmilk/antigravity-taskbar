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

    // 1. 优先使用现代化 PowerShell CIM 查询（无缝兼容 Windows 11 24H2 及以上废弃 WMIC 的系统）
    try {
      const script = `
        $ProgressPreference = 'SilentlyContinue'
        $p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Antigravity.exe' -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--import=' }
        if ($p) { [Console]::WriteLine(($p | Select-Object -First 1).ProcessId) }
      `;
      const b64 = Buffer.from(script, 'utf16le').toString('base64');
      const out = execSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${b64}`, {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 3000
      });
      const match = out.match(/\b(\d+)\b/);
      if (match) return parseInt(match[1], 10);
    } catch (e) {}

    // 2. 降级兼容：传统 WMIC 查询（兼容旧版系统）
    try {
      const out = execSync('wmic process where "Name=\'Antigravity.exe\' and not CommandLine like \'%--type=%\' and not CommandLine like \'%--import=%\'" get ProcessId', {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 2500
      });
      const match = out.match(/\b(\d+)\b/);
      if (match) return parseInt(match[1], 10);
    } catch (e) {}

    return null;
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
  const targetCmd = `"${electronBin}" "${runnerScript}"${hostPidArg}`;
  const psLiteral = "'" + targetCmd.replace(/'/g, "''") + "'";

  // 1. 优先使用现代化 PowerShell Invoke-CimMethod 创建系统独立常驻进程（脱离终端树，且兼容 Win11 24H2）
  try {
    const script = `
      $ProgressPreference = 'SilentlyContinue'
      $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psLiteral} }
      if ($res.ReturnValue -eq 0) { [Console]::WriteLine($res.ProcessId) }
    `;
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const out = execSync(`powershell.exe -NoProfile -NonInteractive -EncodedCommand ${b64}`, {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 4000
    });
    const match = out.match(/\b(\d+)\b/);
    if (match && match[1]) {
      const newPid = match[1];
      try {
        fs.writeFileSync(pidFile, newPid, 'utf-8');
      } catch (e) {}
      return parseInt(newPid, 10);
    }
  } catch (e) {}

  // 2. 降级兼容：传统 WMI process call create
  try {
    const cmd = `wmic process call create "\\"${electronBin.replace(/\\/g, '\\\\')}\\" \\"${runnerScript.replace(/\\/g, '\\\\')}\\"${hostPidArg}"`;
    const out = execSync(cmd, { windowsHide: true, encoding: 'utf-8', timeout: 3000 });
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
