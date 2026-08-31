// Preload okna ustawien: przypinanie/odlaczanie live Twitch do kanalu.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("twSettings", {
  // main -> okno: dane biezacego kanalu
  onData: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data || {});
      } catch (e) {}
    };
    ipcRenderer.on("twitch-settings-data", handler);
    return () => ipcRenderer.removeListener("twitch-settings-data", handler);
  },
  save: (login) => ipcRenderer.send("twitch-settings-save", { login: String(login || "") }),
  unbind: () => ipcRenderer.send("twitch-settings-unbind"),
  cancel: () => ipcRenderer.send("twitch-settings-close"),
});
