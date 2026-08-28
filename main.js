const {
  app,
  BrowserWindow,
  BrowserView,
  globalShortcut,
  ipcMain,
  nativeTheme,
  session,
  desktopCapturer,
} = require("electron");

const path = require("path");
const fs = require("fs");
const RPC = require("discord-rpc");
const { AudioControl } = require("./audio-control");

nativeTheme.themeSource = "dark";

let mainWindow;
let discordView;

let overlayWindow;
let soundcloudView;
// Ostatnia ustawiona glosnosc SoundClouda (0..100, null = domyslna 100).
// Sterujemy nia bezposrednio na stronie (wspolna sesja audio z Discordem).
let soundcloudVolume = null;

let overlayVisible = false;

let mixerWindow = null;
let mixerVisible = false;
let audioControl = null;

// JS wstrzykiwany do Discorda: uzytkownicy kanalu glosowego + ich glosnosc
const MIXER_DISCORD_JS = fs.readFileSync(
  path.join(__dirname, "mixer", "discord-mixer-injected.js"),
  "utf8"
);

const TITLEBAR_HEIGHT = 38;
const OVERLAY_HEADER_HEIGHT = 55;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// CSS: suwak głośności + ukrycie scrollbarów
const INJECTED_CSS = `
::-webkit-scrollbar {
  width: 0 !important;
  height: 0 !important;
}

.volume {
  display: flex !important;
  align-items: center !important;
  gap: 8px !important;
  overflow: visible !important;
}

.volume__sliderWrapper {
  display: block !important;
  opacity: 0 !important;
  pointer-events: none !important;
}

.volume__sliderWrapper * {
  opacity: 0 !important;
}

.custom-volume-slider {
  -webkit-appearance: none !important;
  appearance: none !important;
  width: 110px !important;
  height: 4px !important;
  border-radius: 2px !important;
  background: rgba(255, 255, 255, 0.3) !important;
  outline: none !important;
  cursor: pointer !important;
  margin: 0 !important;
  padding: 0 !important;
}

.custom-volume-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.3);
}

.custom-volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none !important;
  width: 12px !important;
  height: 12px !important;
  border-radius: 50% !important;
  background: #ffffff !important;
  border: 2px solid #000000 !important;
  margin-top: -4px !important;
}
`;

// JS: logika suwaka
const INJECTED_JS = `
(() => {
  function dispatchPointerSequence(target, x, y) {
    const common = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    try {
      if (window.PointerEvent) {
        target.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', ...common }));
      }
    } catch (e) {}

    target.dispatchEvent(new MouseEvent('mousedown', common));

    try {
      if (window.PointerEvent) {
        target.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse', ...common }));
      }
    } catch (e) {}

    target.dispatchEvent(new MouseEvent('mouseup', common));
    target.dispatchEvent(new MouseEvent('click', common));
  }

  function simulateNativeVolumeChange(volumeEl, valueNormalized) {
    const wrapper = volumeEl.querySelector('.volume__sliderWrapper');
    if (!wrapper) return;

    const bg = wrapper.querySelector('.volume__sliderBackground') || wrapper;
    const rect = bg.getBoundingClientRect();
    if (!rect.height || !rect.width) return;

    valueNormalized = Math.max(0, Math.min(1, valueNormalized));

    const x = rect.left + rect.width / 2;
    const y = rect.bottom - rect.height * valueNormalized;

    dispatchPointerSequence(bg, x, y);
  }

  function enhanceVolume(volumeEl) {
    if (!volumeEl || volumeEl.dataset.customVolumeDone === '1') return;
    volumeEl.dataset.customVolumeDone = '1';

    const wrapper = volumeEl.querySelector('.volume__sliderWrapper');
    if (!wrapper) return;

    wrapper.style.display = 'block';
    wrapper.style.opacity = '0';
    wrapper.style.pointerEvents = 'none';

    if (volumeEl.querySelector('.custom-volume-slider')) return;

    let initialVolume = 1;
    const ariaNow = parseFloat(wrapper.getAttribute('aria-valuenow'));
    if (!Number.isNaN(ariaNow)) {
      initialVolume = Math.max(0, Math.min(1, ariaNow));
    }

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(Math.round(initialVolume * 100));
    slider.className = 'custom-volume-slider';

    const iconWrapper = volumeEl.querySelector('.volume__iconWrapper');
    if (iconWrapper && iconWrapper.nextSibling) {
      volumeEl.insertBefore(slider, iconWrapper.nextSibling);
    } else if (iconWrapper) {
      volumeEl.appendChild(slider);
    } else {
      volumeEl.appendChild(slider);
    }

    slider.addEventListener('input', () => {
      const percent = parseFloat(slider.value) || 0;
      const normalized = percent / 100;
      simulateNativeVolumeChange(volumeEl, normalized);
    });

    const attrObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'aria-valuenow') {
          const v = parseFloat(wrapper.getAttribute('aria-valuenow'));
          if (Number.isNaN(v)) return;

          const percent = Math.round(Math.max(0, Math.min(1, v)) * 100);
          const current = parseFloat(slider.value);

          if (Number.isNaN(current) || Math.abs(current - percent) >= 1) {
            slider.value = String(percent);
          }
        }
      }
    });

    attrObserver.observe(wrapper, {
      attributes: true,
      attributeFilter: ['aria-valuenow']
    });
  }

  function scanAllVolumes() {
    document.querySelectorAll('.volume').forEach(enhanceVolume);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        if (node.matches('.volume')) {
          enhanceVolume(node);
        } else if (node.querySelectorAll) {
          node.querySelectorAll('.volume').forEach(enhanceVolume);
        }
      }
    }
  });

  function init() {
    if (!document.body) return;
    observer.observe(document.body, { childList: true, subtree: true });
    scanAllVolumes();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;

// JS: tracking utworu do Discord RPC
const RPC_TRACKING_JS = `
(() => {
  function getText(el) {
    return el ? el.textContent.trim() : '';
  }

  function parseTimeToSeconds(str) {
    if (!str) return null;
    str = String(str).trim();
    if (!str) return null;

    var negative = false;
    if (str[0] === '-') {
      negative = true;
      str = str.slice(1).trim();
    }

    var parts = str.split(':').map(function (p) { return Number(p); });
    if (!parts.length || parts.some(function (n) { return Number.isNaN(n); })) return null;

    var seconds;
    if (parts.length === 3) {
      seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      seconds = parts[0] * 60 + parts[1];
    } else {
      seconds = parts[0];
    }

    return negative ? -seconds : seconds;
  }

  function readInfo() {
    var badge = document.querySelector('.playControls__soundBadge, .playbackSoundBadge');
    var isPlaying = !!document.querySelector(
      '.playControl.playControl--playing,' +
      '.playControl.sc-button-play.playing,' +
      '.playControls__control.sc-button-play.playing'
    );

    var titleEl = null;
    var artistEl = null;

    if (badge) {
      titleEl =
        badge.querySelector('.playbackSoundBadge__titleLink, .playbackSoundBadge__title') ||
        badge.querySelector('a[title], span[title]') ||
        badge.querySelector('a, span');

      artistEl =
        badge.querySelector('.playbackSoundBadge__lightLink, .playbackSoundBadge__usernameLink') ||
        badge.querySelector('.playbackSoundBadge__context, .soundTitle__usernameText');
    }

    var title = getText(titleEl);
    var artist = getText(artistEl);

    var passedEl = document.querySelector(
      '.playbackTimeline__timePassed span, .playbackTimeline__timePassed'
    );
    var rightEl = document.querySelector(
      '.playbackTimeline__duration span, .playbackTimeline__duration'
    );

    var passedStr = getText(passedEl);
    var rightStr = getText(rightEl);

    var passedSeconds = parseTimeToSeconds(passedStr);
    var rightSeconds = parseTimeToSeconds(rightStr);
    var durationSeconds = null;

    if (
      typeof passedSeconds === 'number' && !Number.isNaN(passedSeconds) &&
      typeof rightSeconds === 'number' && !Number.isNaN(rightSeconds)
    ) {
      if (rightSeconds < 0) {
        durationSeconds = passedSeconds + (-rightSeconds);
      } else {
        durationSeconds = rightSeconds;
      }
    } else if (typeof rightSeconds === 'number' && !Number.isNaN(rightSeconds)) {
      durationSeconds = rightSeconds;
    }

    if (!title && !artist && !isPlaying) {
      return { isPlaying: false };
    }

    return {
      isPlaying: isPlaying,
      title: title || null,
      artist: artist || null,
      passedSeconds:
        typeof passedSeconds === 'number' && !Number.isNaN(passedSeconds) && passedSeconds >= 0
          ? passedSeconds
          : null,
      durationSeconds:
        typeof durationSeconds === 'number' && !Number.isNaN(durationSeconds) && durationSeconds > 0
          ? durationSeconds
          : null
    };
  }

  function maybeSend() {
    if (!window.electronNowPlaying || typeof window.electronNowPlaying.updatePresence !== 'function') {
      return;
    }

    var info = readInfo();

    try {
      window.electronNowPlaying.updatePresence(info);
    } catch (e) {}
  }

  function init() {
    if (!document.body) return;

    var observer = new MutationObserver(function () {
      maybeSend();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });

    maybeSend();
    setInterval(maybeSend, 5000);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
`;

// Glosnosc SoundClouda: mikser -> IPC -> ten skrypt -> element audio na stronie.
// Electron caly dzwiek odtwarza przez jedna sesje WASAPI, wiec per-widok
// mozna go przycisnac tylko bezposrednio na elemencie <audio>/<video>.
const SOUNDCLOUD_VOLUME_JS = `
(() => {
  if (window.__scVolumeInjected) return;
  window.__scVolumeInjected = true;

  var target = 1; // 0..1

  function apply(el) {
    try {
      if (el && typeof el.volume === "number" && Math.abs(el.volume - target) > 0.005) {
        el.volume = target;
      }
    } catch (e) {}
  }

  function scan(root) {
    try {
      var nodes = (root || document).querySelectorAll
        ? (root || document).querySelectorAll("audio,video")
        : [];
      nodes.forEach(apply);
    } catch (e) {}
  }

  function init() {
    // istniejace elementy
    scan(document);

    // nowe elementy wstawiane przy zmianie utworu/odtwarzacza
    try {
      var obs = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          if (!added) continue;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n && n.nodeType === 1) {
              if (n.tagName === "AUDIO" || n.tagName === "VIDEO") apply(n);
              else scan(n);
            }
          }
        }
        // i na wszelki wypadek wszystko (zmiana utworu bywa bez nowego DOM)
        scan(document);
      });
      obs.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
      });
    } catch (e) {}

    setInterval(function () {
      scan(document);
    }, 800);

    var bridge = window.electronNowPlaying;
    if (bridge && typeof bridge.onSetVolume === "function") {
      try {
        bridge.onSetVolume(function (pct) {
          var p = Number(pct);
          if (!isFinite(p)) return;
          target = Math.max(0, Math.min(100, p)) / 100;
          scan(document);
        });
      } catch (e) {}
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
`;
const DISCORD_CLIENT_ID = "1444730971579748525";

RPC.register(DISCORD_CLIENT_ID);

let rpc;
let rpcReady = false;
let lastPresenceJSON = null;
let lastPresenceTimestamp = 0;

function initDiscordRPC() {
  rpc = new RPC.Client({ transport: "ipc" });

  rpc.on("ready", () => {
    rpcReady = true;
    console.log("Discord RPC: połączono");
  });

  rpc.on("disconnected", () => {
    rpcReady = false;
    console.log("Discord RPC: rozłączono");
  });

  rpc.login({ clientId: DISCORD_CLIENT_ID }).catch((err) => {
    console.error(
      "Discord RPC login error:",
      err && err.message ? err.message : err
    );
  });
}

function formatTime(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) {
    return null;
  }

  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

function updateDiscordPresence(info) {
  if (!rpcReady || !rpc) return;

  const now = Date.now();
  const data = info && typeof info === "object" ? info : {};
  const serialized = JSON.stringify(data);
  const changed = serialized !== lastPresenceJSON;

  if (!changed && now - lastPresenceTimestamp < 10000) return;
  if (changed && now - lastPresenceTimestamp < 1000) return;

  lastPresenceJSON = serialized;
  lastPresenceTimestamp = now;

  const isPlaying = !!data.isPlaying;
  const hasTitle = !!data.title;

  const hasPosition =
    typeof data.passedSeconds === "number" &&
    typeof data.durationSeconds === "number" &&
    data.durationSeconds > 0 &&
    data.durationSeconds >= data.passedSeconds;

  if (!hasTitle && !isPlaying) {
    rpc
      .setActivity({
        details: "SoundCloud",
        state: "Przegląda lub nic nie odtwarza",
        largeImageKey: "soundcloud",
        largeImageText: "SoundCloud",
        instance: false,
      })
      .catch(() => {});
    return;
  }

  if (!isPlaying && hasTitle) {
    const details = String(data.title).slice(0, 128);
    let state = "";

    if (hasPosition) {
      const currentStr = formatTime(data.passedSeconds);
      const totalStr = formatTime(data.durationSeconds);
      const timeStr =
        currentStr && totalStr ? `${currentStr} / ${totalStr}` : null;

      if (data.artist && timeStr) {
        state = `⏸ Pauza • ${data.artist} • ${timeStr}`;
      } else if (timeStr) {
        state = `⏸ Pauza • ${timeStr}`;
      } else if (data.artist) {
        state = `⏸ Pauza • ${data.artist}`;
      } else {
        state = "⏸ Pauza";
      }
    } else {
      state = data.artist ? `⏸ Pauza • ${data.artist}` : "⏸ Pauza";
    }

    rpc
      .setActivity({
        details,
        state: state.slice(0, 128),
        largeImageKey: "soundcloud",
        largeImageText: "SoundCloud",
        instance: false,
      })
      .catch(() => {});
    return;
  }

  const details = hasTitle ? String(data.title).slice(0, 128) : "SoundCloud";

  let state = "";
  if (hasPosition) {
    const currentStr = formatTime(data.passedSeconds);
    const totalStr = formatTime(data.durationSeconds);
    const timeStr =
      currentStr && totalStr ? `${currentStr} / ${totalStr}` : null;

    if (data.artist && timeStr) {
      state = `${data.artist} • ${timeStr}`;
    } else if (data.artist) {
      state = data.artist;
    } else if (timeStr) {
      state = timeStr;
    } else {
      state = "Odtwarza utwór";
    }
  } else {
    state = data.artist || "Odtwarza utwór";
  }

  const activity = {
    details,
    state: state.slice(0, 128),
    largeImageKey: "soundcloud",
    largeImageText: "SoundCloud",
    instance: false,
  };

  if (hasPosition) {
    const startTimestamp = Math.floor(Date.now() / 1000 - data.passedSeconds);
    activity.startTimestamp = startTimestamp;
    activity.endTimestamp = startTimestamp + Math.floor(data.durationSeconds);
  }

  rpc.setActivity(activity).catch(() => {});
}

// RPC tylko od widoku SoundCloud
ipcMain.on("now-playing-update", (event, info) => {
  if (!soundcloudView) return;
  if (event.sender !== soundcloudView.webContents) return;
  updateDiscordPresence(info);
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    title: "Discord",
    backgroundColor: "#313338",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "ui", "index.html"));

  discordView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "discord-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.addBrowserView(discordView);
  updateDiscordBounds();

  // Discord zezwala na wspoldzielenie ekranu tylko dla Chrome/Edge/aplikacji;
  // domyslny UA Electrona (z "Electron/x.y") jest traktowany jak nieobslugiwany.
  discordView.webContents.setUserAgent(USER_AGENT);
  discordView.webContents.loadURL("https://discord.com/app");

  discordView.webContents.on("did-finish-load", () => {
    discordView.webContents.executeJavaScript(MIXER_DISCORD_JS).catch(() => {});
  });

  discordView.webContents.on("did-navigate-in-page", () => {
    discordView.webContents.executeJavaScript(MIXER_DISCORD_JS).catch(() => {});
  });

  // Przyklejenie overlay do Discorda
  mainWindow.on("move", () => {
    if (overlayVisible) {
      centerOverlay();
    }
    if (mixerVisible) {
      centerMixer();
    }
  });

  mainWindow.on("resize", () => {
    updateDiscordBounds();
    if (overlayVisible) {
      centerOverlay();
    }
    if (mixerVisible) {
      centerMixer();
    }
  });

  mainWindow.on("maximize", () => {
    if (overlayVisible) {
      centerOverlay();
    }
    if (mixerVisible) {
      centerMixer();
    }
  });

  mainWindow.on("unmaximize", () => {
    if (overlayVisible) {
      centerOverlay();
    }
    if (mixerVisible) {
      centerMixer();
    }
  });

  mainWindow.on("minimize", () => {
    if (overlayWindow && overlayVisible) {
      overlayWindow.hide();
    }
    if (mixerWindow && mixerVisible) {
      mixerWindow.hide();
    }
  });

  mainWindow.on("restore", () => {
    if (overlayWindow && overlayVisible) {
      centerOverlay();
      overlayWindow.show();
    }
    if (mixerWindow && mixerVisible) {
      centerMixer();
      mixerWindow.show();
    }
  });

  mainWindow.on("closed", () => {
    if (overlayWindow) {
      overlayWindow.close();
    }
    if (mixerWindow) {
      mixerWindow.close();
    }
    mainWindow = null;
  });
}

function updateDiscordBounds() {
  if (!mainWindow || !discordView) return;

  const [width, height] = mainWindow.getContentSize();

  discordView.setBounds({
    x: 0,
    y: TITLEBAR_HEIGHT,
    width: width,
    height: height - TITLEBAR_HEIGHT,
  });
}

function updateSoundcloudBounds() {
  if (!overlayWindow || !soundcloudView) return;

  const [width, height] = overlayWindow.getContentSize();

  soundcloudView.setBounds({
    x: 0,
    y: OVERLAY_HEADER_HEIGHT,
    width: width,
    height: Math.max(1, height - OVERLAY_HEADER_HEIGHT),
  });
}

function createOverlay() {
  overlayWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 750,
    minHeight: 550,
    frame: false,
    transparent: false,
    resizable: true,
    show: false,
    parent: mainWindow,
    modal: false,
    skipTaskbar: true,
    backgroundColor: "#1e1f22",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // lokalny header z X
  overlayWindow.loadFile(path.join(__dirname, "overlay", "index.html"));

  // SoundCloud
  soundcloudView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, "soundcloud-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.addBrowserView(soundcloudView);
  updateSoundcloudBounds();

  const wc = soundcloudView.webContents;
  wc.setUserAgent(USER_AGENT);
  wc.loadURL("https://soundcloud.com");

  wc.setWindowOpenHandler(() => {
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        width: 600,
        height: 700,
        backgroundColor: "#121212",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
    };
  });

  wc.on("did-finish-load", () => {
    wc.insertCSS(INJECTED_CSS).catch(() => {});
    wc.executeJavaScript(INJECTED_JS).catch(() => {});
    wc.executeJavaScript(RPC_TRACKING_JS).catch(() => {});
    wc.executeJavaScript(SOUNDCLOUD_VOLUME_JS).catch(() => {});
    // jesli mikser juz ustawil glosnosc przed zaladowaniem strony
    if (soundcloudVolume != null) {
      sendSoundcloudVolume(soundcloudVolume);
    }
  });

  wc.on("did-navigate", () => {
    wc.executeJavaScript(SOUNDCLOUD_VOLUME_JS).catch(() => {});
  });

  overlayWindow.on("resize", () => {
    updateSoundcloudBounds();
  });

  overlayWindow.on("closed", () => {
    soundcloudView = null;
    overlayWindow = null;
    overlayVisible = false;
  });
}

function centerOverlay() {
  if (!mainWindow || !overlayWindow) return;

  const [mainX, mainY] = mainWindow.getPosition();
  const [mainWidth, mainHeight] = mainWindow.getSize();
  const [overlayWidth, overlayHeight] = overlayWindow.getSize();

  const x = mainX + Math.floor((mainWidth - overlayWidth) / 2);

  const y =
    mainY +
    TITLEBAR_HEIGHT +
    Math.floor((mainHeight - TITLEBAR_HEIGHT - overlayHeight) / 2);

  overlayWindow.setPosition(x, y);
}

function showOverlay() {
  if (!overlayWindow) {
    createOverlay();
  }

  overlayVisible = true;
  centerOverlay();
  updateSoundcloudBounds();
  overlayWindow.show();
  overlayWindow.focus();
}

function hideOverlay() {
  if (!overlayWindow) return;

  overlayVisible = false;
  overlayWindow.hide();

  if (mainWindow) {
    mainWindow.focus();
  }
}

function toggleOverlay() {
  if (overlayVisible) {
    hideOverlay();
  } else {
    showOverlay();
  }
}

// ======== MIKSER GLOSNOSCI ========
function createMixer() {
  mixerWindow = new BrowserWindow({
    width: 430,
    height: 620,
    minWidth: 360,
    minHeight: 300,
    frame: false,
    resizable: true,
    show: false,
    parent: mainWindow,
    modal: false,
    skipTaskbar: true,
    backgroundColor: "#1e1f22",
    webPreferences: {
      preload: path.join(__dirname, "mixer", "mixer-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mixerWindow.loadFile(path.join(__dirname, "mixer", "index.html"));

  mixerWindow.on("closed", () => {
    mixerWindow = null;
    mixerVisible = false;
  });
}

function sendToMixer(channel, payload) {
  if (mixerWindow && !mixerWindow.isDestroyed()) {
    mixerWindow.webContents.send(channel, payload);
  }
}

// Electron/Electron-Chromium kieruje cale audio (Discord + SoundCloud) przez
// JEDNA sesje WASAPI, wiec nie da sie rozdzielic glosnosci po procesach.
// SoundCloud dostaje wiec wlasny, wirtualny suwak: glosnosc ustawiana jest
// bezposrednio na stronie (SOUNDCLOUD_VOLUME_JS), a do miksera dokladamy
// sztuczny wpis.
function soundcloudVirtualApp() {
  const vol = soundcloudVolume == null ? 1 : soundcloudVolume / 100;
  return {
    pid: "__soundcloud__",
    name: "soundcloud",
    volume: vol,
    muted: false,
    self: false,
    virtual: true,
    tag: "soundcloud",
  };
}

function sendAppsToMixer() {
  if (!audioControl) return;
  const sessions = audioControl.sessions.slice();
  try {
    if (soundcloudView && !soundcloudView.isDestroyed()) {
      sessions.push(soundcloudVirtualApp());
    }
  } catch (e) {}
  sendToMixer("mixer-apps", sessions);
}

function sendSoundcloudVolume(pct) {
  try {
    if (soundcloudView && !soundcloudView.isDestroyed()) {
      soundcloudView.webContents.send("soundcloud-set-volume", pct);
    }
  } catch (e) {}
}

ipcMain.on("soundcloud-volume-request", () => {
  if (soundcloudVolume != null) sendSoundcloudVolume(soundcloudVolume);
});

ipcMain.on("mixer-set-soundcloud-volume", (_event, data) => {
  if (!data || typeof data.percent !== "number") return;
  soundcloudVolume = Math.max(0, Math.min(100, Math.round(data.percent)));
  sendSoundcloudVolume(soundcloudVolume);
  sendAppsToMixer();
});

function centerMixer() {
  if (!mainWindow || !mixerWindow) return;

  const [mainX, mainY] = mainWindow.getPosition();
  const [mainWidth, mainHeight] = mainWindow.getSize();
  const [mixerWidth, mixerHeight] = mixerWindow.getSize();

  const x = mainX + Math.floor((mainWidth - mixerWidth) / 2);
  const y =
    mainY +
    TITLEBAR_HEIGHT +
    Math.floor((mainHeight - TITLEBAR_HEIGHT - mixerHeight) / 2);

  mixerWindow.setPosition(x, y);
}

function showMixer() {
  if (!mixerWindow) {
    createMixer();
  }

  mixerVisible = true;
  centerMixer();
  mixerWindow.show();
  mixerWindow.focus();

  // wyslanie swiezego stanu
  if (audioControl && mixerWindow) {
    mixerWindow.webContents.send("mixer-status", audioControl.getStatus());
    sendAppsToMixer();
  }
}

function hideMixer() {
  if (!mixerWindow) return;
  mixerVisible = false;
  mixerWindow.hide();
  if (mainWindow) mainWindow.focus();
}

function toggleMixer() {
  if (mixerVisible) {
    hideMixer();
  } else {
    showMixer();
  }
}

// IPC
ipcMain.on("toggle-overlay", () => {
  toggleOverlay();
});

ipcMain.on("close-overlay", () => {
  hideOverlay();
});

ipcMain.on("window-minimize", () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on("window-maximize", () => {
  if (!mainWindow) return;

  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on("window-close", () => {
  if (mainWindow) mainWindow.close();
});

// IPC miksera
ipcMain.on("toggle-mixer", () => {
  toggleMixer();
});

ipcMain.on("close-mixer", () => {
  hideMixer();
});

ipcMain.on("mixer-get-state", () => {
  if (!mixerWindow) return;
  mixerWindow.webContents.send(
    "mixer-status",
    audioControl ? audioControl.getStatus() : { ok: false, error: null }
  );
  if (audioControl) sendAppsToMixer();
  else mixerWindow.webContents.send("mixer-apps", []);
});

ipcMain.on("mixer-debug", (_event, msg) => {
  const text = String(msg);
  console.log("[mixer-debug]", text);
  sendToMixer("mixer-log", text);
});

ipcMain.on("mixer-set-app-volume", (_event, data) => {
  if (!data || typeof data.pid !== "number") return;
  if (audioControl) audioControl.setVolume(data.pid, data.percent);
});

function sendVolumeToDiscord(channel, data) {
  if (!discordView || !data || !data.userId) return;
  discordView.webContents.send(channel, {
    userId: String(data.userId),
    percent: data.percent,
  });
}

ipcMain.on("mixer-set-user-volume", (_event, data) => {
  sendVolumeToDiscord("discord-set-user-volume", data);
});

ipcMain.on("mixer-set-user-volume-live", (_event, data) => {
  sendVolumeToDiscord("discord-set-user-volume-live", data);
});

ipcMain.on("mixer-set-user-volume-end", (_event, data) => {
  sendVolumeToDiscord("discord-set-user-volume-end", data);
});

ipcMain.on("mixer-users-update", (event, users) => {
  if (!discordView) return;
  if (event.sender !== discordView.webContents) return;
  if (mixerWindow && !mixerWindow.isDestroyed()) {
    mixerWindow.webContents.send("mixer-users", users);
  }
});

function setupScreenCapture() {
  const ses = session.defaultSession;

  // Zezwol na media (mikrofon/kamere) i przechwytywanie ekranu w Discordsie
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    if (
      ["media", "audioCapture", "videoCapture", "display-capture"].includes(
        permission
      )
    ) {
      callback(true);
    } else {
      callback(false);
    }
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    return ["media", "audioCapture", "videoCapture", "display-capture"].includes(
      permission
    );
  });

  // Wspoldzielenie ekranu. Uzywamy NATYWNEGO okna wyboru Windows
  // (useSystemPicker), dzieki czemu uzytkownik wybiera ekran/okno.
  // useSystemPicker: gdy dostepny, Windows sam pokazuje okno wyboru ekranu/okna
  // i NIE woluje naszego handlera. Handler jest wolany tylko jako fallback.
  try {
    ses.setDisplayMediaRequestHandler(
      (_request, callback) => {
        console.log("[screenshare] fallback (brak pickera) - pierwszy ekran");
        desktopCapturer
          .getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 0, height: 0 },
          })
          .then((sources) => {
            callback({
              video: sources[0] || null,
              audio: "loopback",
            });
          })
          .catch((err) => {
            console.error("[screenshare] blad:", err);
            callback({ video: null, audio: undefined });
          });
      },
      { useSystemPicker: true }
    );
    console.log("[screenshare] handler zarejestrowany (system picker wlaczony)");
  } catch (e) {
    console.error("[screenshare] blad rejestracji handlera:", e);
  }
}

app.whenReady().then(() => {
  initDiscordRPC();
  setupScreenCapture();
  createMainWindow();
  createOverlay();

  audioControl = new AudioControl();

  audioControl.onUpdate(() => {
    sendAppsToMixer();
  });

  audioControl.onStatus((available) => {
    sendToMixer("mixer-status", available);
  });

  audioControl.onLog((line) => {
    sendToMixer("mixer-log", "[audio] " + line);
  });

  // PID renderera SoundCloud moze byc znany dopiero po starcie widoku -
  // przepnij tagi po kilku sekundach i potem co 15s.
  setTimeout(sendAppsToMixer, 4000);
  setInterval(sendAppsToMixer, 15000);
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();

  if (audioControl) {
    try {
      audioControl.stop();
    } catch (e) {}
  }

  if (rpc) {
    try {
      rpc.clearActivity();
      rpc.destroy();
    } catch (e) {}
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
