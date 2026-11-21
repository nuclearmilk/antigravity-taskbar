const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_LOG_BYTES = 512 * 1024;

function applyCliEnvOverrides(argv = process.argv, env = process.env) {
  if (!Array.isArray(argv)) return env;
  const mappings = [
    ['--data-dir=', 'PLUGIN_DATA'],
    ['--app-data-dir=', 'ANTIGRAVITY_APP_DATA_DIR'],
    ['--align=', 'ANTIGRAVITY_TASKBAR_ALIGN'],
    ['--offset-x=', 'ANTIGRAVITY_TASKBAR_OFFSET_X'],
    ['--width=', 'ANTIGRAVITY_TASKBAR_WIDTH'],
    ['--fullscreen=', 'ANTIGRAVITY_TASKBAR_FULLSCREEN'],
    ['--pipe=', 'ANTIGRAVITY_TASKBAR_PIPE']
  ];

  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    for (const [prefix, envKey] of mappings) {
      if (arg.startsWith(prefix)) {
        const val = arg.slice(prefix.length);
        if (val !== '') {
          env[envKey] = val;
        }
        break;
      }
    }
  }
  return env;
}

function getRuntimeDataDir(env = process.env) {
  return env.PLUGIN_DATA || path.join(os.tmpdir(), 'antigravity-taskbar');
}

function getPipePath(usernameOverride, env = process.env) {
  if (env.ANTIGRAVITY_TASKBAR_PIPE) {
    return env.ANTIGRAVITY_TASKBAR_PIPE;
  }
  let rawUser = usernameOverride;
  if (!rawUser) {
    try {
      rawUser = os.userInfo().username;
    } catch {
      rawUser = env.USERNAME || env.USER || 'default';
    }
  }
  const safeUser = String(rawUser).replace(/[\\/:*?"<>|]/g, '_');
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\antigravity-taskbar-${safeUser}`;
  }
  return path.join(os.tmpdir(), `antigravity-taskbar-${safeUser}.sock`);
}

function appendLogWithRotation(logFilePath, msg, maxBytes = MAX_LOG_BYTES) {
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    try {
      const stat = fs.statSync(logFilePath);
      if (stat.size >= maxBytes) {
        const rotatedPath = `${logFilePath}.1`;
        try {
          if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
          fs.renameSync(logFilePath, rotatedPath);
        } catch {
          fs.truncateSync(logFilePath, 0);
        }
      }
    } catch {
      // file does not exist yet
    }
    fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8');
  } catch {
    // ignore logging failure
  }
}

function toCreationTs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    // WMIC CreationDate format: YYYYMMDDHHMMSS.ffffff+zzz
    const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)/);
    if (m) {
      const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7].slice(0, 3)}Z`;
      const ts = Date.parse(iso);
      if (Number.isFinite(ts)) return ts;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function selectHostPidFromProcesses(processes) {
  if (!Array.isArray(processes) || processes.length === 0) return null;

  const valid = processes
    .filter((p) => p && Number.isInteger(p.ProcessId) && p.ProcessId > 0)
    .map((p) => ({
      ProcessId: p.ProcessId,
      ParentProcessId: Number.isInteger(p.ParentProcessId) ? p.ParentProcessId : 0,
      CommandLine: typeof p.CommandLine === 'string' ? p.CommandLine : null,
      CreationTs: toCreationTs(p.CreationTs ?? p.CreationDate)
    }));

  if (valid.length === 0) return null;

  const pidSet = new Set(valid.map((p) => p.ProcessId));
  const childCountByPid = new Map();
  for (const p of valid) {
    if (p.ParentProcessId && pidSet.has(p.ParentProcessId)) {
      childCountByPid.set(
        p.ParentProcessId,
        (childCountByPid.get(p.ParentProcessId) || 0) + 1
      );
    }
  }

  const roots = valid.filter((p) => !pidSet.has(p.ParentProcessId));
  const rootPool = roots.length > 0 ? roots : valid;

  const nonWorkerPool = rootPool.filter((p) => {
    if (!p.CommandLine || !p.CommandLine.trim()) return true;
    return !/--(type|import)=/i.test(p.CommandLine);
  });

  if (nonWorkerPool.length === 0) return null;

  const withCleanCmd = nonWorkerPool.filter(
    (p) => typeof p.CommandLine === 'string' && p.CommandLine.trim().length > 0
  );
  const candidates = withCleanCmd.length > 0 ? withCleanCmd : nonWorkerPool;

  candidates.sort((a, b) => {
    const aHasChildren = (childCountByPid.get(a.ProcessId) || 0) > 0;
    const bHasChildren = (childCountByPid.get(b.ProcessId) || 0) > 0;
    if (aHasChildren !== bHasChildren) {
      return aHasChildren ? -1 : 1;
    }

    const aHasTs = a.CreationTs > 0;
    const bHasTs = b.CreationTs > 0;
    if (aHasTs && bHasTs && a.CreationTs !== b.CreationTs) {
      return a.CreationTs - b.CreationTs;
    }
    if (aHasTs !== bHasTs) {
      return aHasTs ? -1 : 1;
    }
    return a.ProcessId - b.ProcessId;
  });

  return candidates[0].ProcessId;
}

function parseWmicProcesses(output) {
  if (typeof output !== 'string' || !output.trim()) return [];
  const blocks = output.trim().split(/\r?\n\s*\r?\n/);
  const list = [];

  for (const block of blocks) {
    const record = {};
    for (const rawLine of block.split(/\r?\n/)) {
      const idx = rawLine.indexOf('=');
      if (idx === -1) continue;
      const key = rawLine.slice(0, idx).trim();
      const val = rawLine.slice(idx + 1).trim();
      if (key) record[key] = val;
    }
    const pid = parseInt(record.ProcessId, 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    list.push({
      ProcessId: pid,
      ParentProcessId: parseInt(record.ParentProcessId, 10) || 0,
      CommandLine: record.CommandLine || null,
      CreationTs: toCreationTs(record.CreationDate)
    });
  }

  return list;
}

function parseRegThemeOutput(output) {
  if (typeof output !== 'string') return null;
  const match = output.match(/SystemUsesLightTheme\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/i);
  if (!match) return null;
  const val = match[1].toLowerCase().startsWith('0x')
    ? parseInt(match[1], 16)
    : parseInt(match[1], 10);
  if (val === 1) return 'light';
  if (val === 0) return 'dark';
  return null;
}

function loadSettings(dataDir = getRuntimeDataDir(), env = process.env) {
  const settings = {
    align: 'center',
    offsetX: 0,
    width: 600,
    visibleOnFullScreen: false
  };

  try {
    const filePath = path.join(dataDir, 'settings.json');
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        if (parsed.align === 'left' || parsed.align === 'center' || parsed.align === 'right') {
          settings.align = parsed.align;
        }
        if (typeof parsed.offsetX === 'number' && Number.isFinite(parsed.offsetX)) {
          settings.offsetX = parsed.offsetX;
        }
        if (typeof parsed.width === 'number' && Number.isFinite(parsed.width)) {
          settings.width = parsed.width;
        }
        if (typeof parsed.visibleOnFullScreen === 'boolean') {
          settings.visibleOnFullScreen = parsed.visibleOnFullScreen;
        }
      }
    }
  } catch {
    // ignore malformed settings.json
  }

  if (
    env.ANTIGRAVITY_TASKBAR_ALIGN === 'left' ||
    env.ANTIGRAVITY_TASKBAR_ALIGN === 'center' ||
    env.ANTIGRAVITY_TASKBAR_ALIGN === 'right'
  ) {
    settings.align = env.ANTIGRAVITY_TASKBAR_ALIGN;
  }
  if (env.ANTIGRAVITY_TASKBAR_OFFSET_X !== undefined) {
    const v = Number(env.ANTIGRAVITY_TASKBAR_OFFSET_X);
    if (Number.isFinite(v)) settings.offsetX = v;
  }
  if (env.ANTIGRAVITY_TASKBAR_WIDTH !== undefined) {
    const v = Number(env.ANTIGRAVITY_TASKBAR_WIDTH);
    if (Number.isFinite(v)) settings.width = v;
  }
  if (env.ANTIGRAVITY_TASKBAR_FULLSCREEN !== undefined) {
    settings.visibleOnFullScreen = env.ANTIGRAVITY_TASKBAR_FULLSCREEN === 'true' || env.ANTIGRAVITY_TASKBAR_FULLSCREEN === '1';
  }

  return settings;
}

function computeWindowBounds(display, settings = {}) {
  const bounds = display?.bounds || { x: 0, y: 0, width: 1920, height: 1080 };
  const workArea = display?.workArea || bounds;

  const dx = bounds.x || 0;
  const dy = bounds.y || 0;
  const dw = bounds.width || 1920;
  const dh = bounds.height || 1080;

  const wy = workArea.y ?? dy;
  const wh = workArea.height ?? dh;

  const bottomGap = dy + dh - (wy + wh);
  const topGap = wy - dy;

  let taskbarHeight = 48;
  let y = dy + dh - taskbarHeight + 2;

  if (bottomGap > 0) {
    taskbarHeight = Math.max(40, bottomGap);
    y = dy + dh - taskbarHeight + 2;
  } else if (topGap > 0) {
    taskbarHeight = Math.max(40, topGap);
    y = dy + 2;
  }

  const winHeight = Math.max(32, taskbarHeight - 4);
  const requestedWidth = Number(settings.width);
  const winWidth = Math.min(dw, Math.max(160, Number.isFinite(requestedWidth) ? requestedWidth : 600));
  const offsetX = Number.isFinite(Number(settings.offsetX)) ? Number(settings.offsetX) : 0;

  let x;
  if (settings.align === 'left') {
    x = dx + 16 + offsetX;
  } else if (settings.align === 'right') {
    x = dx + dw - winWidth - 16 + offsetX;
  } else {
    x = Math.round(dx + (dw - winWidth) / 2) + offsetX;
  }

  x = Math.round(Math.max(dx, Math.min(dx + dw - winWidth, x)));
  y = Math.round(y);

  return {
    x,
    y,
    width: Math.round(winWidth),
    height: Math.round(winHeight),
    taskbarHeight: Math.round(taskbarHeight)
  };
}

function formatHwnd(buf) {
  if (!Buffer.isBuffer(buf)) return '0';
  if (buf.length >= 8) {
    return buf.readBigUInt64LE(0).toString();
  }
  if (buf.length >= 4) {
    return String(buf.readUInt32LE(0));
  }
  return '0';
}

module.exports = {
  MAX_LOG_BYTES,
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
};
