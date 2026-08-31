const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronMixerBridge", {
  // strona -> main: lista uzytkownikow na kanale
  pushUsers: (users) => {
    try {
      ipcRenderer.send("mixer-users-update", users);
    } catch (e) {}
  },

  // strona -> main: obszary na kanale #transmisja do osadzenia Twitcha
  // rect = { player: {x,y,width,height}, chat: {x,y,width,height}|null }
  // (wspolrzedne wzgledem strony) lub null (inny kanal)
  pushTwitchEmbed: (rect) => {
    try {
      ipcRenderer.send("twitch-embed-rect", rect);
    } catch (e) {}
  },

  // main -> strona: zadanie ustawienia glosnosci uzytkownika
  onSetUserVolume: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data.userId, data.percent);
      } catch (e) {}
    };
    ipcRenderer.on("discord-set-user-volume", handler);
    return () => ipcRenderer.removeListener("discord-set-user-volume", handler);
  },

  // zmiana glosnosci w trakcie przeciagania (na zywo)
  onSetUserVolumeLive: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data.userId, data.percent);
      } catch (e) {}
    };
    ipcRenderer.on("discord-set-user-volume-live", handler);
    return () => ipcRenderer.removeListener("discord-set-user-volume-live", handler);
  },

  // koniec przeciagania
  onSetUserVolumeEnd: (cb) => {
    const handler = (_e, data) => {
      try {
        cb(data.userId, data.percent);
      } catch (e) {}
    };
    ipcRenderer.on("discord-set-user-volume-end", handler);
    return () => ipcRenderer.removeListener("discord-set-user-volume-end", handler);
  },

  debug: (msg) => {
    try {
      ipcRenderer.send("mixer-debug", "[discord] " + String(msg));
    } catch (e) {}
  },

  // main -> strona: status live Twitcha (true/false) - do animacji kafla
  // kanalu #transmisja na liscie kanalow
  onTwitchLive: (cb) => {
    const handler = (_e, live) => {
      try {
        cb(!!live);
      } catch (e) {}
    };
    ipcRenderer.on("twitch-live-state", handler);
    return () => ipcRenderer.removeListener("twitch-live-state", handler);
  },

  // strona -> main: popros o biezacy status live (po zaladowaniu strony)
  requestTwitchLive: () => {
    try {
      ipcRenderer.send("twitch-live-state-request");
    } catch (e) {}
  },

  // strona -> main: pobierz mape kanal Discorda -> login Twitcha
  requestTwitchChannelMap: () => {
    try {
      ipcRenderer.send("twitch-channel-map-request");
    } catch (e) {}
  },

  // main -> strona: aktualna mapa
  onTwitchChannelMap: (cb) => {
    const handler = (_e, map) => {
      try {
        cb(map || {});
      } catch (e) {}
    };
    ipcRenderer.on("twitch-channel-map", handler);
    return () => ipcRenderer.removeListener("twitch-channel-map", handler);
  },

  // strona -> main: otworz natywne okno ustawien dla kanalu
  openTwitchSettings: (channelId, channelName) => {
    try {
      ipcRenderer.send("twitch-settings-open", { channelId, channelName });
    } catch (e) {}
  },

  // main -> strona: zmierz ponownie obszar czatu (resize okna itp.)
  onTwitchEmbedMeasure: (fn) => {
    try {
      ipcRenderer.on("twitch-embed-measure", () => {
        try {
          fn();
        } catch (e) {}
      });
    } catch (e) {}
  },
});
