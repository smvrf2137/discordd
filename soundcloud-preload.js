// Preload widoku SoundClouda.
// contextIsolation jest wylaczone (patrz main.js), wiec ten preload dziala w
// tym samym swiecie JS co strona i przed jej skryptami. Przy tej stronie
// nodeIntegration=false (Node niedostepny w SWIECIE STRONY); ipcRenderer bierzemy
// przez require dostepny w preloadzie.
//
// Glosnosc: SoundCloud odtwarza muzyke przez Web Audio API (AudioContext ->
// destination), wiec ustawianie element.volume nie dziala. Przechwytujemy
// AudioNode.prototype.connect i przepuszczamy caly dzwiek przez nasz GainNode,
// ktorym steruje mikser (IPC z maina).

const { contextBridge, ipcRenderer } = require("electron");

// RPC "teraz gra" - most dla skryptu strony (executeJavaScript swiat strony).
try {
  contextBridge.exposeInMainWorld("electronNowPlaying", {
    updatePresence: (info) => {
      try {
        ipcRenderer.send("now-playing-update", info);
      } catch (e) {}
    },
  });
} catch (e) {}

(() => {
  if (window.__scMixerInjected) return;
  window.__scMixerInjected = true;

  let target = 1; // 0..1
  const gains = [];

  function masterGainFor(ctx) {
    for (const g of gains) if (g.context === ctx) return g;
    let g = null;
    try {
      g = ctx.createGain();
      g.gain.value = target;
      g.__mixerOwn = true;
      g.connect(ctx.destination); // nasz wlasny wezel: omija hook
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

  // Elementy <audio>/<video> pojawiaja sie z opoznieniem / przy zmianie utworu.
  const boot = () => {
    applyMedia();
    setInterval(applyMedia, 800);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  ipcRenderer.on("soundcloud-set-volume", (_e, pct) => {
    try {
      setTarget(pct);
    } catch (e) {}
  });

  try {
    ipcRenderer.send("soundcloud-volume-request");
  } catch (e) {}
})();
