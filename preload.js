const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  closeOverlay: () => {
    ipcRenderer.send("close-overlay");
  },

  toggleOverlay: () => {
    ipcRenderer.send("toggle-overlay");
  },

  toggleTwitch: () => {
    ipcRenderer.send("toggle-twitch");
  },

  closeTwitch: () => {
    ipcRenderer.send("close-twitch");
  },

  onTwitchLive: (cb) => {
    const handler = (_e, live) => {
      try {
        cb(live);
      } catch (e) {}
    };
    ipcRenderer.on("twitch-live", handler);
    return () => ipcRenderer.removeListener("twitch-live", handler);
  },

  toggleMixer: () => {
    ipcRenderer.send("toggle-mixer");
  },

  onMixerActive: (cb) => {
    const handler = (_e, active) => {
      try {
        cb(active);
      } catch (e) {}
    };
    ipcRenderer.on("mixer-active", handler);
    return () => ipcRenderer.removeListener("mixer-active", handler);
  },

  minimize: () => {
    ipcRenderer.send("window-minimize");
  },

  maximize: () => {
    ipcRenderer.send("window-maximize");
  },

  closeWindow: () => {
    ipcRenderer.send("window-close");
  },
});