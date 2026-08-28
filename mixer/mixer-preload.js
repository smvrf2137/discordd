const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronMixer", {
  closeMixer: () => {
    ipcRenderer.send("close-mixer");
  },

  getState: () => {
    ipcRenderer.send("mixer-get-state");
  },

  debug: (msg) => {
    try {
      ipcRenderer.send("mixer-debug", String(msg));
    } catch (e) {}
  },

  setAppVolume: (pid, percent) => {
    ipcRenderer.send("mixer-set-app-volume", { pid, percent });
  },

  setUserVolume: (userId, percent) => {
    ipcRenderer.send("mixer-set-user-volume", { userId, percent });
  },

  onApps: (cb) => {
    const handler = (_e, apps) => cb(apps);
    ipcRenderer.on("mixer-apps", handler);
    return () => ipcRenderer.removeListener("mixer-apps", handler);
  },

  onUsers: (cb) => {
    const handler = (_e, users) => cb(users);
    ipcRenderer.on("mixer-users", handler);
    return () => ipcRenderer.removeListener("mixer-users", handler);
  },

  onStatus: (cb) => {
    const handler = (_e, available) => cb(available);
    ipcRenderer.on("mixer-status", handler);
    return () => ipcRenderer.removeListener("mixer-status", handler);
  },

  onLog: (cb) => {
    const handler = (_e, line) => cb(line);
    ipcRenderer.on("mixer-log", handler);
    return () => ipcRenderer.removeListener("mixer-log", handler);
  },
});
