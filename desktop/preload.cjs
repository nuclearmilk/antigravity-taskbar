const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taskbarAPI', {
  onStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('taskbar:status', handler);
    return () => ipcRenderer.removeListener('taskbar:status', handler);
  },
  onTheme: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, theme) => callback(theme);
    ipcRenderer.on('taskbar:theme', handler);
    return () => ipcRenderer.removeListener('taskbar:theme', handler);
  }
});
