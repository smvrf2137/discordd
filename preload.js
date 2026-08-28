const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  closeOverlay: () => {
    ipcRenderer.send("close-overlay");
  },

  toggleOverlay: () => {
    ipcRenderer.send("toggle-overlay");
  },

  toggleMixer: () => {
    ipcRenderer.send("toggle-mixer");
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