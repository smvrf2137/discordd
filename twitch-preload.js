// Preload widokow playera Twitcha (osadzony w kanale #transmisja oraz
// osobne okno Twitcha).
// contextIsolation jest wylaczone (patrz main.js), wiec preload dziala w
// tym samym swiecie JS co strona i przed jej skryptami; nodeIntegration
// jest wylaczone w swiecie strony, a w preloadzie require("electron")
// nadal dziala.
//
// Glosnosc: Electron/Chromium kieruje cale audio przez JEDNA sesje WASAPI,
// wiec player Twitcha nie ma osobnego wpisu w mikserze. Przechwytujemy
// zrodla dzwieku (element <video> oraz Web Audio API) i regulujemy je
// suwakiem z miksera (IPC z maina).

const { ipcRenderer } = require("electron");

(() => {
  if (window.__twMixerInjected) return;
  window.__twMixerInjected = true;

  let target = 1; // 0..1
  const gains = [];

  function masterGainFor(ctx) {
    for (const g of gains) if (g.context === ctx) return g;
    let g = null;
    try {
      g = ctx.createGain();
      g.gain.value = target;
      g.__mixerOwn = true;
      g.connect(ctx.destination); // nasz wezel: omija hook
      gains.push(g);
    } catch (e) {}
    return g;
  }

  function installConnectHook() {
    const NodeCtor = window.AudioNode;
    if (!NodeCtor || !NodeCtor.prototype || NodeCtor.prototype.__mixerHooked) return;
    const origConnect = NodeCtor.prototype.connect;
    NodeCtor.prototype.__mixerHooked = true;
    NodeCtor.prototype.connect = function (dest) {
      try {
        if (!this.__mixerOwn) {
          const ctx = this.context;
          if (ctx && dest === ctx.destination) {
            const g = masterGainFor(ctx);
            if (g) return origConnect.call(this, g);
          }
        }
      } catch (e) {}
      return origConnect.apply(this, arguments);
    };
  }

  // Player Twitcha to glownie element <video> - ustawiamy mu .volume.
  // Wymuszamy cyklicznie, bo player moze sam nadpisywac wartosc.
  function applyMedia() {
    try {
      const nodes = document.querySelectorAll("audio,video");
      for (const el of nodes) {
        if (typeof el.volume === "number" && Math.abs(el.volume - target) > 0.005) {
          try {
            el.volume = target;
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  function setTarget(pct) {
    const p = Number(pct);
    if (!isFinite(p)) return;
    target = Math.max(0, Math.min(100, p)) / 100;
    for (const g of gains) {
      try {
        g.gain.setTargetAtTime(target, 0, 0.02);
      } catch (e) {}
    }
    applyMedia();
  }

  installConnectHook();

  const boot = () => {
    applyMedia();
    setInterval(applyMedia, 800);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  ipcRenderer.on("twitch-set-volume", (_e, pct) => {
    try {
      setTarget(pct);
    } catch (e) {}
  });

  // popros o zapamietana glosnosc
  try {
    ipcRenderer.send("twitch-volume-request");
  } catch (e) {}
})();
