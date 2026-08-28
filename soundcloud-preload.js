const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronNowPlaying", {
  updatePresence: (info) => {
    try {
      ipcRenderer.send("now-playing-update", info);
    } catch (e) {}
  },

  // Glosnosc SoundClouda sterowana z miksera (0..100).
  // Rejestracja od razu pyta maina o ostatnia wartosc.
  onSetVolume: (cb) => {
    const handler = (_e, pct) => {
      try {
        cb(pct);
      } catch (e) {}
    };
    ipcRenderer.on("soundcloud-set-volume", handler);
    try {
      ipcRenderer.send("soundcloud-volume-request");
    } catch (e) {}
    return () => ipcRenderer.removeListener("soundcloud-set-volume", handler);
  },
});
