// Wstrzykiwane do widoku Discorda (https://discord.com/app).
// Zbiera uzytkownikow polaczonych na kanale glosowym i ustawia ich glosnosc
// przez wewnetrzne moduly webpacka Discorda.

(() => {
  if (window.__discordMixerInjected) return;
  window.__discordMixerInjected = true;

  const bridge = window.electronMixerBridge;
  function dbg(msg) {
    try {
      if (bridge && bridge.debug) bridge.debug(String(msg));
      else console.log("[mixer]", String(msg));
    } catch (e) {}
  }

  dbg("skrypt zaladowany, bridge=" + (bridge ? "tak" : "nie"));
  if (!bridge) return;

  let webpackRequire = null;

  // Znalezione moduly
  let userStore = null;
  let volumeModule = null;
  let voiceStateStore = null;
  let speakingStore = null;
  let channelStore = null;

  function findWebpack() {
    try {
      const names = ["webpackChunkdiscord_app", "webpackChunk_DISCORD"];
      for (const n of names) {
        const chunks = window[n];
        if (chunks && typeof chunks.push === "function") return grabRequire(chunks);
      }
      for (const key of Object.keys(window)) {
        if (
          key.indexOf("webpackChunk") === 0 &&
          window[key] &&
          typeof window[key].push === "function"
        ) {
          return grabRequire(window[key]);
        }
      }
    } catch (e) {
      dbg("findWebpack blad: " + e.message);
    }
    return null;
  }

  function grabRequire(chunks) {
    let req = null;
    try {
      chunks.push([
        [Symbol("mixer")],
        {},
        (r) => {
          req = r;
        },
      ]);
    } catch (e) {
      dbg("grabRequire blad: " + e.message);
    }
    return req;
  }

  function hasFn(obj, name) {
    try {
      return !!obj && typeof obj[name] === "function";
    } catch (e) {
      return false;
    }
  }

  // Z modulu webpacka wydobywa kandydatow: sam mod, mod.default oraz
  // zagniezdzone obiekty o malych nazwach (minifikacja: exports.Z, exports.WP...).
  function candidatesFromMod(mod, out, depth) {
    if (!mod || depth > 2) return;
    if (out.has(mod)) return;

    let isCandidate = false;
    try {
      if (typeof mod === "object" || typeof mod === "function") {
        isCandidate = true;
      }
    } catch (e) {}
    if (!isCandidate) return;

    out.add(mod);

    let keys = [];
    try {
      keys = Object.keys(mod);
    } catch (e) {
      return;
    }

    for (const k of keys) {
      // nie wchodzimy w zdarzenia/wewnetrzne pola React/Discorda
      if (
        k === "default" ||
        /^[A-Za-z_$][A-Za-z0-9_$]{0,3}$/.test(k) ||
        /Store|Action|api|Api/i.test(k)
      ) {
        let child;
        try {
          child = mod[k];
        } catch (e) {
          continue;
        }
        if (child && (typeof child === "object" || typeof child === "function")) {
          if (!out.has(child)) candidatesFromMod(child, out, depth + 1);
        }
      }
    }
  }

  // Wywoluje fn(modul) dla wszystkich kandydatow
  function eachCandidate(fn) {
    if (!webpackRequire || !webpackRequire.c) return;
    const cache = webpackRequire.c;
    const seen = new Set();
    for (const key of Object.keys(cache)) {
      let exports;
      try {
        exports = cache[key] && cache[key].exports;
      } catch (e) {
        continue;
      }
      if (!exports) continue;
      const cands = new Set();
      candidatesFromMod(exports, cands, 0);
      for (const c of cands) {
        if (seen.has(c)) continue;
        seen.add(c);
        try {
          fn(c);
        } catch (e) {}
      }
    }
  }

  function scanModules() {
    let foundUser = false;
    let foundVolume = false;
    let foundVoice = false;
    let foundSpeaking = false;
    let foundChannel = false;

    eachCandidate((m) => {
      if (!m || (typeof m !== "object" && typeof m !== "function")) return;

      if (!foundUser && hasFn(m, "getCurrentUser") && hasFn(m, "getUser")) {
        userStore = m;
        foundUser = true;
      }

      if (!foundVolume && hasFn(m, "setUserVolume")) {
        volumeModule = m;
        foundVolume = true;
      }

      if (!foundVoice && hasFn(m, "getVoiceStatesForChannel")) {
        voiceStateStore = m;
        foundVoice = true;
      }

      if (!foundChannel && hasFn(m, "getChannel") && hasFn(m, "getChannels")) {
        channelStore = m;
        foundChannel = true;
      }

      if (!foundSpeaking) {
        try {
          if (
            hasFn(m, "isSpeaking") ||
            (hasFn(m, "getSpeakingStates") && hasFn(m, "subscribe"))
          ) {
            const keys = Object.keys(m).filter(
              (k) => typeof m[k] === "function" && /speak|voice/i.test(k)
            );
            if (keys.length) {
              speakingStore = m;
              foundSpeaking = true;
            }
          }
        } catch (e) {}
      }
    });

    dbg(
      "scan: user=" +
        foundUser +
        " volume=" +
        foundVolume +
        " voice=" +
        foundVoice +
        " speaking=" +
        foundSpeaking +
        " channel=" +
        foundChannel
    );
  }

  // ===== API sklepow =====

  function getCurrentUser() {
    try {
      if (userStore) return userStore.getCurrentUser();
    } catch (e) {}
    return null;
  }

  function getUser(userId) {
    try {
      if (userStore) return userStore.getUser(userId);
    } catch (e) {}
    return null;
  }

  function userName(userId) {
    const u = getUser(userId);
    if (u) {
      return (
        u.globalName ||
        u.displayName ||
        u.username ||
        u.global_name ||
        u.name ||
        null
      );
    }
    return null;
  }

  function getMyVoiceChannelId() {
    try {
      const me = getCurrentUser();
      const meId = me && me.id;

      if (voiceStateStore) {
        if (hasFn(voiceStateStore, "getVoiceChannelId")) {
          const id = voiceStateStore.getVoiceChannelId();
          if (id) return String(id);
        }
        if (meId && hasFn(voiceStateStore, "getVoiceStateForUser")) {
          const st = voiceStateStore.getVoiceStateForUser(meId);
          if (st && (st.channelId || st.channelID)) {
            return String(st.channelId || st.channelID);
          }
        }
      }
    } catch (e) {
      dbg("getMyVoiceChannelId blad: " + e.message);
    }
    return null;
  }

  function channelVoiceStates(channelId) {
    const out = new Map();
    try {
      if (voiceStateStore && channelId) {
        let states = null;
        try {
          states = voiceStateStore.getVoiceStatesForChannel(channelId);
        } catch (e) {}

        if (!states && hasFn(voiceStateStore, "getAllVoiceStates")) {
          try {
            const all = voiceStateStore.getAllVoiceStates();
            if (all) states = all[channelId];
          } catch (e) {}
        }

        if (states) {
          if (states instanceof Map) {
            for (const [k, v] of states) if (v) out.set(String(k), v);
          } else if (typeof states.forEach === "function") {
            states.forEach((v, k) => {
              if (v) out.set(String(k), v);
            });
          } else if (typeof states === "object") {
            for (const k of Object.keys(states)) {
              if (states[k]) out.set(String(k), states[k]);
            }
          }
        }
      }
    } catch (e) {
      dbg("channelVoiceStates blad: " + e.message);
    }
    return out;
  }

  let volumeScale = 100; // aktualny Discord: 0..100

  function getUserVolumeRaw(userId) {
    try {
      if (volumeModule) {
        if (hasFn(volumeModule, "getUserVolume")) return volumeModule.getUserVolume(userId);
        if (hasFn(volumeModule, "getLocalVolume")) return volumeModule.getLocalVolume(userId);
      }
    } catch (e) {}
    return null;
  }

  function normalizedVolume(userId) {
    const v = getUserVolumeRaw(userId);
    if (typeof v !== "number" || !isFinite(v) || v < 0) return 1;
    if (volumeScale === 100) return Math.max(0, Math.min(1, v / 100));
    return Math.max(0, Math.min(1, v));
  }

  function isSpeakingNow(userId, channelId) {
    try {
      if (speakingStore) {
        try {
          if (speakingStore.isSpeaking(userId)) return true;
        } catch (e) {}
        try {
          if (channelId && speakingStore.isSpeaking(channelId, userId)) return true;
        } catch (e) {}
      }
    } catch (e) {}
    return false;
  }

  function setUserVolume(userId, percent) {
    try {
      if (!volumeModule) {
        dbg("setUserVolume: brak modulu glosnosci");
        return false;
      }
      const p = Math.max(0, Math.min(100, Number(percent) || 0));
      const value = volumeScale === 100 ? p : p / 100;
      volumeModule.setUserVolume(String(userId), value);
      return true;
    } catch (e) {
      dbg("setUserVolume blad: " + e.message);
      return false;
    }
  }

  // ===== FALLBACK DOM =====
  function voiceDataItems() {
    const items = [];
    try {
      document
        .querySelectorAll('[data-list-item-id^="voice-"]')
        .forEach((el) => items.push(el));
    } catch (e) {}
    return items;
  }

  function userIdFromElement(el) {
    // data-list-item-id="voice-<channelId>_<userId>"
    try {
      const dli = el.getAttribute && el.getAttribute("data-list-item-id");
      if (dli) {
        const m = dli.match(/voice-(\d+)_(\d{6,})/);
        if (m) return m[2];
        const m2 = dli.match(/_(\d{6,})$/);
        if (m2) return m2[1];
      }
    } catch (e) {}

    // szukaj w poddrzewie / najblizszym rodzicu
    try {
      const scope =
        el.closest && el.closest('[data-list-item-id^="voice-"]')
          ? el.closest('[data-list-item-id^="voice-"]')
          : el;
      const img = scope.querySelector ? scope.querySelector("img") : null;
      if (img) {
        const src = img.getAttribute("src") || "";
        const m = src.match(/avatars\/(\d{6,})\//);
        if (m) return m[1];
      }
      const link = scope.querySelector
        ? scope.querySelector('a[href*="/users/"]')
        : null;
      if (link) {
        const m = (link.getAttribute("href") || "").match(/users\/(\d{6,})/);
        if (m) return m[1];
      }
    } catch (e) {}

    const cls =
      el.className && el.className.baseVal !== undefined
        ? el.className.baseVal
        : String(el.className || "");
    const m = cls.match(/\b(\d{17,20})\b/);
    return m ? m[1] : null;
  }

  function nameFromElement(el) {
    try {
      const scope =
        (el.closest && el.closest('[data-list-item-id^="voice-"]')) || el;
      const nameEl =
        scope.querySelector(
          '[class*="username"], [class*="userName"], [class*="name_"]'
        ) || scope.querySelector("span");
      if (nameEl) {
        const t = nameEl.textContent.trim();
        if (t && t.length < 40) return t;
      }
    } catch (e) {}
    return null;
  }

  function flagsFromElement(el) {
    let speaking = false;
    let muted = false;
    try {
      const scope =
        (el.closest && el.closest('[data-list-item-id^="voice-"]')) || el;
      const html = scope.outerHTML || "";
      if (/\bspeaking\b|Speaking_|borderSpeaking/i.test(html)) speaking = true;
      const mic = scope.querySelector(
        '[class*="mic"], [aria-label*="uted"], [class*="Muted"]'
      );
      if (mic) {
        const label = mic.getAttribute("aria-label") || "";
        const mcls = String(
          mic.className.baseVal !== undefined ? mic.className.baseVal : mic.className || ""
        );
        if (/muted/i.test(mcls) || /muted/i.test(label)) muted = true;
      }
    } catch (e) {}
    return { speaking, muted };
  }

  let lastDomDbg = "";
  function collectDomUsers(myId) {
    const users = new Map();
    const items = voiceDataItems();

    // diagnostyka (tylko gdy sie zmienia)
    const sample = items
      .slice(0, 5)
      .map((el) => el.getAttribute("data-list-item-id"))
      .join(" || ");
    const sig = items.length + "|" + sample;
    if (sig !== lastDomDbg) {
      lastDomDbg = sig;
      dbg("DOM voice-* elementow: " + items.length + (sample ? " np. " + sample : ""));
    }

    for (const el of items) {
      const id = userIdFromElement(el);
      if (!id) continue;
      if (myId && id === myId) continue;
      const flags = flagsFromElement(el);
      users.set(id, {
        id,
        name: userName(id) || nameFromElement(el) || "User " + id.slice(-4),
        volume: normalizedVolume(id),
        muted: flags.muted,
        speaking: flags.speaking,
      });
    }
    return users;
  }

  // ===== GLOWNA PENTLA =====
  let lastPayload = "";
  let tickCount = 0;
  let scanAttempts = 0;

  function collectUsers() {
    const users = new Map();
    const me = getCurrentUser();
    const myId = me && me.id ? String(me.id) : null;
    const channelId = getMyVoiceChannelId();

    // 1) ze sklepu stanow glosowych
    if (channelId) {
      const states = channelVoiceStates(channelId);
      for (const [id, st] of states) {
        if (myId && id === myId) continue;
        if (!st) continue;
        users.set(id, {
          id,
          name: userName(id) || "User " + id.slice(-4),
          volume: normalizedVolume(id),
          muted: !!(st.mute || st.selfMute || st.self_mute || st.suppress),
          speaking: !!(st.speaking || isSpeakingNow(id, channelId)),
        });
      }
    }

    // 2) z DOM
    const dom = collectDomUsers(myId);
    for (const [id, u] of dom) {
      if (!users.has(id)) users.set(id, u);
      else {
        const ex = users.get(id);
        ex.muted = ex.muted || u.muted;
        ex.speaking = ex.speaking || u.speaking;
      }
    }

    return Array.from(users.values());
  }

  function tick() {
    try {
      if (!webpackRequire) {
        webpackRequire = findWebpack();
        if (webpackRequire) {
          dbg("webpack znaleziony");
          scanModules();
        }
      } else if (
        !userStore ||
        !voiceStateStore ||
        !volumeModule
      ) {
        // ponawiaj skan przez pierwsze ~30 s
        if (scanAttempts < 15) {
          scanAttempts++;
          scanModules();
        }
      }

      const users = collectUsers();
      const payload = JSON.stringify(users);
      if (payload !== lastPayload) {
        lastPayload = payload;
        dbg("wysylam uzytkownikow: " + users.length);
        try {
          bridge.pushUsers(users);
        } catch (e) {}
      }

      tickCount++;
      if (tickCount % 7 === 0) {
        dbg(
          "heartbeat: users=" +
            users.length +
            " webpack=" +
            !!webpackRequire +
            " userStore=" +
            !!userStore +
            " voiceStore=" +
            !!voiceStateStore +
            " volumeModule=" +
            !!volumeModule +
            " channel=" +
            (getMyVoiceChannelId() || "brak") +
            " domVoice=" +
            voiceDataItems().length
        );
      }
    } catch (e) {
      dbg("tick blad: " + e.message);
    }
  }

  bridge.onSetUserVolume((userId, percent) => {
    dbg("zadanie glosnosci " + userId + " = " + percent);
    setUserVolume(userId, percent);
  });

  function init() {
    webpackRequire = findWebpack();
    if (webpackRequire) {
      dbg("webpack znaleziony (init)");
      scanModules();
    } else {
      dbg("webpack NIE znaleziony przy starcie");
    }
    tick();
    setInterval(tick, 1500);
    // dodatkowe skany pozniej (moduly laduja sie z opoznieniem)
    setTimeout(scanModules, 5000);
    setTimeout(scanModules, 12000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
