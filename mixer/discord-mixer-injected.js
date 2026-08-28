// Wstrzykiwane do widoku Discorda (https://discord.com/app).
// Zbiera uzytkownikow polaczonych na kanale glosowym i ustawia ich glosnosc
// przez wewnetrzne moduly webpacka Discorda.

(() => {
  if (window.__discordMixerInjected) return;
  window.__discordMixerInjected = true;

  const bridge = window.electronMixerBridge;
  function dbg(msg) {
    try {
      if (bridge && bridge.debug) bridge.debug(msg);
      else console.log("[mixer]", msg);
    } catch (e) {}
  }

  dbg("skrypt zaladowany, bridge=" + (bridge ? "tak" : "nie"));
  if (!bridge) return;

  let webpackRequire = null;

  // Znalezione moduly
  let userStore = null;
  let volumeModule = null; // { setUserVolume, getUserVolume? }
  let voiceStateStore = null; // VoiceStateStore
  let speakingStore = null;

  function findWebpack() {
    try {
      const chunks =
        window.webpackChunkdiscord_app ||
        window.webpackChunk_DISCORD ||
        (typeof window.webpackChunkdiscord_app !== "undefined"
          ? window.webpackChunkdiscord_app
          : null);

      if (!chunks || !chunks.push) {
        // sprobuj znalezc po wszystkich wlasciwosciach okna
        for (const key of Object.keys(window)) {
          if (
            key.indexOf("webpackChunk") === 0 &&
            window[key] &&
            typeof window[key].push === "function"
          ) {
            return grabRequire(window[key]);
          }
        }
        return null;
      }
      return grabRequire(chunks);
    } catch (e) {
      dbg("findWebpack blad: " + e.message);
      return null;
    }
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

  // Wywoluje fn(mod) dla kazdego modulu webpacka (rowniez moduly default / nested).
  function eachModule(fn) {
    if (!webpackRequire || !webpackRequire.c) return;
    const cache = webpackRequire.c;
    for (const key of Object.keys(cache)) {
      let mod;
      try {
        mod = cache[key] && cache[key].exports;
      } catch (e) {
        continue;
      }
      if (!mod) continue;

      try {
        fn(mod, key);
      } catch (e) {}

      // czesto modul jest opakowany w { default: ... }
      if (mod.default && mod.default !== mod) {
        try {
          fn(mod.default, key + ".default");
        } catch (e) {}
      }
    }
  }

  function hasFn(obj, name) {
    try {
      return obj && typeof obj[name] === "function";
    } catch (e) {
      return false;
    }
  }

  function scanModules() {
    let foundUser = false;
    let foundVolume = false;
    let foundVoice = false;
    let foundSpeaking = false;

    eachModule((m) => {
      if (!m || typeof m !== "object") return;

      // UserStore
      if (!foundUser && hasFn(m, "getCurrentUser") && hasFn(m, "getUser")) {
        userStore = m;
        foundUser = true;
      }

      // Modul akcji glosnosci (setUserVolume)
      if (!foundVolume && hasFn(m, "setUserVolume")) {
        volumeModule = m;
        foundVolume = true;
      }

      // VoiceStateStore
      if (!foundVoice && hasFn(m, "getVoiceStatesForChannel")) {
        voiceStateStore = m;
        foundVoice = true;
      }

      // SpeakingStore
      if (
        !foundSpeaking &&
        (hasFn(m, "isSpeaking") || hasFn(m, "getSpeakingStates"))
      ) {
        // upewnij sie, ze to sklep zwiazany z mowieniem
        try {
          const keys = Object.keys(m).filter(
            (k) => typeof m[k] === "function" && /speak|voice/i.test(k)
          );
          if (keys.length) {
            speakingStore = m;
            foundSpeaking = true;
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
        foundSpeaking
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
      if (voiceStateStore) {
        if (hasFn(voiceStateStore, "getVoiceChannelId")) {
          const id = voiceStateStore.getVoiceChannelId();
          if (id) return String(id);
        }
        const me = getCurrentUser();
        if (me && hasFn(voiceStateStore, "getVoiceStateForUser")) {
          const st = voiceStateStore.getVoiceStateForUser(me.id);
          if (st && st.channelId) return String(st.channelId);
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
            states = all && all[channelId];
          } catch (e) {}
        }

        if (states) {
          if (states instanceof Map) {
            for (const [k, v] of states) out.set(String(k), v);
          } else if (typeof states.forEach === "function") {
            states.forEach((v, k) => out.set(String(k), v));
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

  // Glosnosc uzytkownika z modulu Discorda
  let volumeScale = 100; // domyslnie 0..100 (aktualny Discord)

  function getUserVolumeRaw(userId) {
    try {
      if (volumeModule) {
        if (hasFn(volumeModule, "getUserVolume")) {
          return volumeModule.getUserVolume(userId);
        }
        // czesc wersji trzyma w getLocalVolume / akcji
        if (hasFn(volumeModule, "getLocalVolume")) {
          return volumeModule.getLocalVolume(userId);
        }
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
        if (hasFn(speakingStore, "isSpeaking")) {
          // rozne sygnatury: isSpeaking(userId) lub isSpeaking(channelId, userId)
          try {
            if (speakingStore.isSpeaking(userId)) return true;
          } catch (e) {}
          try {
            if (channelId && speakingStore.isSpeaking(channelId, userId))
              return true;
          } catch (e) {}
        }
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
  // Zwraca elementy "wierszy" uzytkownikow na kanale glosowym.
  function voiceRowElements() {
    const rows = new Set();
    const selectors = [
      '[class*="voiceUser"]',
      '[class*="voice-user"]',
      'li[class*="voice"]',
      '[class*="container_"][class*="voice"] [class*="avatar"]',
    ];
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          // wspinamy sie do najblizszego "kontenera uzytkownika"
          let container = el;
          if (/avatar/i.test(el.className.baseVal !== undefined ? el.className.baseVal : el.className || "")) {
            container = el.closest('li, [class*="voiceUser"], [class*="voice-user"], [class*="container"]') || el.parentElement;
          }
          if (container) rows.add(container);
        });
      } catch (e) {}
    }
    return Array.from(rows);
  }

  function userIdFromRow(row) {
    // 1) avatar URL
    const img = row.querySelector("img");
    if (img) {
      const src = img.getAttribute("src") || "";
      let m = src.match(/avatars\/(\d{6,})\//);
      if (m) return m[1];
    }
    // 2) link do profilu
    const link = row.querySelector('a[href*="/users/"], a[href*="channels/@me"]');
    if (link) {
      const href = link.getAttribute("href") || "";
      let m = href.match(/users\/(\d{6,})/);
      if (m) return m[1];
      // /channels/@me/<channelId>?<userId> bywa w DM
    }
    // 3) klasa zawierajaca id
    const cls =
      row.className && row.className.baseVal !== undefined
        ? row.className.baseVal
        : String(row.className || "");
    let m = cls.match(/\b(\d{17,20})\b/);
    if (m) return m[1];
    return null;
  }

  function nameFromRow(row) {
    const el =
      row.querySelector('[class*="username"], [class*="userName"], [class*="name_"]') ||
      row.querySelector("span");
    if (el) {
      const t = el.textContent.trim();
      if (t && t.length < 40) return t;
    }
    return null;
  }

  function flagsFromRow(row) {
    let speaking = false;
    let muted = false;
    try {
      const html = row.outerHTML || "";
      if (/speaking/i.test(html) && !/notSpeaking|not-speaking/i.test(html)) {
        // mówienie zwykle ustawia ramkę/klase speaking
        if (/\bspeaking\b|Speaking_/i.test(html)) speaking = true;
      }
      // wyciszenie mikrofonu: ikona mic-Muted / aria-label
      const mic = row.querySelector('[class*="mic"], [aria-label*="uted"]');
      if (mic) {
        const label = mic.getAttribute("aria-label") || "";
        const mcls = String(
          mic.className.baseVal !== undefined ? mic.className.baseVal : mic.className || ""
        );
        if (/muted/i.test(mcls) || /muted/i.test(label)) muted = true;
      }
      if (/muted/i.test(html) && /mic|microphone|MutedMicrophone/i.test(html)) {
        muted = true;
      }
    } catch (e) {}
    return { speaking, muted };
  }

  // ===== GLOWNA PENTLA =====
  let lastPayload = "";

  function collectUsers() {
    const users = new Map(); // id -> user obj
    const me = getCurrentUser();
    const myId = me && me.id ? String(me.id) : null;

    const channelId = getMyVoiceChannelId();

    // 1) Ze sklepu stanow glosowych
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

    // 2) Z DOM (uzupelnienie / glosnosc + status)
    try {
      const rows = voiceRowElements();
      if (rows.length) dbg("DOM: znaleziono wierszy " + rows.length);
      for (const row of rows) {
        const id = userIdFromRow(row);
        if (!id) continue;
        if (myId && id === myId) continue;

        const flags = flagsFromRow(row);
        const name = nameFromRow(row);

        if (users.has(id)) {
          const u = users.get(id);
          if (name && !u.name.startsWith("User ")) {
            // zachowaj nazwe ze sklepu
          } else if (name) {
            u.name = name;
          }
          u.muted = u.muted || flags.muted;
          u.speaking = u.speaking || flags.speaking;
        } else {
          users.set(id, {
            id,
            name: userName(id) || name || "User " + id.slice(-4),
            volume: normalizedVolume(id),
            muted: flags.muted,
            speaking: flags.speaking,
          });
        }
      }
    } catch (e) {
      dbg("DOM fallback blad: " + e.message);
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
      } else if (!volumeModule || !voiceStateStore || !userStore) {
        scanModules();
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
    setTimeout(scanModules, 4000);
    setTimeout(scanModules, 10000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
