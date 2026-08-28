const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronNowPlaying", {
  updatePresence: (info) => {
    try {
      ipcRenderer.send("now-playing-update", info);
    } catch (e) {}
  },
});