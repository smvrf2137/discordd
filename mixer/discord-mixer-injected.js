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
    let candidatesScanned = 0;
    const volumeKeys = [];

    const cache = webpackRequire && webpackRequire.c;
    const factory = webpackRequire && webpackRequire.m;
    const cacheCount = cache ? Object.keys(cache).length : 0;
    const factoryCount = factory ? Object.keys(factory).length : 0;

    eachCandidate((m) => {
      candidatesScanned++;
      if (!m || (typeof m !== "object" && typeof m !== "function")) return;

      if (!foundUser && hasFn(m, "getCurrentUser") && hasFn(m, "getUser")) {
        userStore = m;
        foundUser = true;
      }

      if (!foundVoice && hasFn(m, "getVoiceStatesForChannel")) {
        voiceStateStore = m;
        foundVoice = true;
      }

      if (!foundChannel && hasFn(m, "getChannel") && hasFn(m, "getChannels")) {
        channelStore = m;
        foundChannel = true;
      }

      // modul glosnosci: szukaj po nazwie funkcji (setUserVolume i pokrewne)
      try {
        const keys = Object.keys(m);
        for (const k of keys) {
          if (typeof m[k] !== "function") continue;
          if (/set.*volume|setuservolume|setlocalvolume|update.*volume/i.test(k)) {
            if (volumeKeys.length < 12) volumeKeys.push(k);
            if (!foundVolume) {
              volumeModule = m;
              foundVolume = true;
            }
          }
        }
      } catch (e) {}

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
      "scan: modCache=" +
        cacheCount +
        " modFactory=" +
        factoryCount +
        " kandydaci=" +
        candidatesScanned +
        " | user=" +
        foundUser +
        " volume=" +
        foundVolume +
        " voice=" +
        foundVoice +
        (volumeKeys.length ? " volFns=" + volumeKeys.join(",") : "")
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
      // glowny selektor
      document
        .querySelectorAll('[data-list-item-id^="voice-"]')
        .forEach((el) => items.push(el));

      // fallback: ludzie na kanale glosowym bywaja w kontenerach z avatarem
      if (items.length === 0) {
        const voicePanel =
          document.querySelector('[class*="voiceUsers"], [class*="voice-users"], [class*="voiceChannel"], [class*="voice-channel"], aside, nav');
        if (voicePanel) {
          voicePanel
            .querySelectorAll('[data-list-item-id]')
            .forEach((el) => {
              const id = el.getAttribute("data-list-item-id") || "";
              if (/voice|user|channel/i.test(id)) items.push(el);
            });
        }
      }
    } catch (e) {}
    return items;
  }

  let domDumpDone = false;
  function dumpVoiceDom() {
    if (domDumpDone) return;
    try {
      // prefiksy wszystkich data-list-item-id
      const prefixes = {};
      let total = 0;
      document.querySelectorAll("[data-list-item-id]").forEach((el) => {
        total++;
        const id = el.getAttribute("data-list-item-id") || "";
        const prefix = id.split("-")[0] + "-" + (id.split("-")[1] || "");
        prefixes[prefix] = (prefixes[prefix] || 0) + 1;
      });
      dbg("DOM data-list-item-id: " + total + " | " + JSON.stringify(prefixes));

      // przykladowe elementy z klasa zawierajaca "voice"
      const vEls = document.querySelectorAll('[class*="voice" i]');
      let count = 0;
      vEls.forEach((el) => {
        if (count >= 6) return;
        const cls =
          el.className && el.className.baseVal !== undefined
            ? el.className.baseVal
            : String(el.className || "");
        const tag = el.tagName.toLowerCase();
        const dli = el.getAttribute("data-list-item-id");
        const txt = (el.textContent || "").trim().slice(0, 30);
        dbg("voice-el <" + tag + " class='" + cls.slice(0, 70) + "'" + (dli ? " dli='" + dli + "'" : "") + "> txt='" + txt + "'");
        count++;
      });
      domDumpDone = true;
    } catch (e) {
      dbg("dumpVoiceDom blad: " + e.message);
    }
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

  // Alternatywne zrodlo: awatary z URL zawierajacym /avatars/<userId>/
  function collectAvatarUsers(myId) {
    const users = new Map();
    try {
      const imgs = document.querySelectorAll('img[src*="avatars/"]');
      imgs.forEach((img) => {
        const src = img.getAttribute("src") || "";
        const m = src.match(/avatars\/(\d{6,})\//);
        if (!m) return;
        const id = m[1];
        if (myId && id === myId) return;
        if (users.has(id)) return;

        // wspinamy sie do "wiersza" uzytkownika
        let scope =
          (img.closest && img.closest('[data-list-item-id^="voice-"]')) ||
          (img.closest && img.closest("li")) ||
          (img.closest &&
            img.closest('[class*="voiceUser"], [class*="voice-user"], [class*="user"], [role="listitem"], [class*="container"]')) ||
          img.parentElement;
        if (!scope) scope = img.parentElement;

        let name = null;
        try {
          const nameEl =
            scope.querySelector('[class*="username"], [class*="userName"], [class*="name_"]') ||
            scope.querySelector("span");
          if (nameEl) {
            const t = nameEl.textContent.trim();
            if (t && t.length < 40 && !/^\d/.test(t)) name = t;
          }
        } catch (e) {}

        users.set(id, {
          id,
          name: userName(id) || name || "User " + id.slice(-4),
          volume: normalizedVolume(id),
          muted: false,
          speaking: false,
        });
      });
    } catch (e) {}
    return users;
  }

  // Moje ID z dolnego panelu konta (awatar na koncu listy znajomych/serwera)
  function getMyIdFromDom() {
    try {
      // panel konta na dole paska kanalow
      const panel =
        document.querySelector('[class*="panels"]') ||
        document.querySelector('section[class*="panel"]');
      if (panel) {
        const img = panel.querySelector('img[src*="avatars/"]');
        if (img) {
          const m = (img.getAttribute("src") || "").match(/avatars\/(\d{6,})\//);
          if (m) return m[1];
        }
      }
    } catch (e) {}
    return null;
  }

  // Glowne zrodlo DOM: uzytkownicy na kanale glosowym. Klasy Discorda maja
  // czytelne prefiksy (np. menu_c1e9c4, slider_a562c8), wiec wiersze/kafelki
  // osob rozmowy maja w klasie "voice"/"tile"/"participant". Dla kazdego awatara
  // wspinamy sie do NAJBLIZSZEGO waskiego kontenera (max 2 awatary) z takim
  // prefiksem - to daje per-uzytkownika, a pomija czat i liste znajomych.
  const VOICE_RE = /voice|tile|participant|stage|connected|speaker/i;
  const NONVOICE_RE = /message|chat|cozy|comment|member|people|friend|privatechannel/i;

  function classOf(el) {
    try {
      return el && el.className && el.className.baseVal !== undefined
        ? el.className.baseVal
        : String((el && el.className) || "");
    } catch (e) {
      return "";
    }
  }

  function nameWithin(scope) {
    if (!scope) return null;
    const candidates = scope.querySelectorAll
      ? scope.querySelectorAll("span, div")
      : [];
    let best = null;
    for (const el of candidates) {
      const cls = classOf(el);
      if (/name|username|displayName/i.test(cls)) {
        const t = (el.textContent || "").trim();
        if (t && t.length < 40 && /[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ0-9]/i.test(t)) return t;
      }
      if (!best) {
        const t = (el.textContent || "").trim();
        if (t && t.length < 32 && /[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/i.test(t)) best = t;
      }
    }
    return best;
  }

  function collectVoiceParticipants(myId) {
    const users = new Map();
    try {
      const imgs = document.querySelectorAll('img[src*="avatars/"]');
      imgs.forEach((img) => {
        const src = img.getAttribute("src") || "";
        const m = src.match(/avatars\/(\d{6,})\//);
        if (!m) return;
        const id = m[1];
        if (myId && id === myId) return;

        // najblizszy waski kontener z prefiksem glosowym
        let best = null;
        let node = img.parentElement;
        for (let hops = 0; hops < 9 && node; hops++) {
          const cls = classOf(node);
          if (NONVOICE_RE.test(cls)) break; // wszedl w kontener czatu/czlonkow
          const avatarCount = node.querySelectorAll
            ? node.querySelectorAll('img[src*="avatars/"]').length
            : 0;
          if (VOICE_RE.test(cls) && avatarCount >= 1 && avatarCount <= 2) {
            best = node;
            break;
          }
          node = node.parentElement;
        }

        if (best) {
          users.set(id, {
            id,
            name:
              nameWithin(best) || userName(id) || "User " + id.slice(-4),
            volume: normalizedVolume(id),
            muted: false,
            speaking: false,
          });
        }
      });
    } catch (e) {
      dbg("collectVoiceParticipants blad: " + e.message);
    }
    return users;
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
    const myId =
      (me && me.id ? String(me.id) : null) || getMyIdFromDom();
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

    // 2) z DOM (data-list-item-id)
    const dom = collectDomUsers(myId);
    for (const [id, u] of dom) {
      if (!users.has(id)) users.set(id, u);
      else {
        const ex = users.get(id);
        ex.muted = ex.muted || u.muted;
        ex.speaking = ex.speaking || u.speaking;
      }
    }

    // 3) z DOM - uczestnicy rozmowy (wiersze w pasku kanalow + kafelki rozmowy)
    const participants = collectVoiceParticipants(myId);
    for (const [id, u] of participants) {
      if (!users.has(id)) users.set(id, u);
      else {
        const ex = users.get(id);
        ex.muted = ex.muted || u.muted;
        ex.speaking = ex.speaking || u.speaking;
        if (ex.name.startsWith("User ") && !u.name.startsWith("User ")) {
          ex.name = u.name;
        }
      }
    }
    if (participants.size) {
      dbg("DOM rozmowa: uczestnikow " + participants.size);
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
        const myId =
          (getCurrentUser() && getCurrentUser().id) || getMyIdFromDom();
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
            " myId=" +
            (myId ? "tak" : "brak") +
            " channel=" +
            (getMyVoiceChannelId() || "brak") +
            " domVoice=" +
            voiceDataItems().length +
            " uczestnicyDOM=" +
            collectVoiceParticipants(myId).size
        );
      }
      // jednorazowy zrzut struktury DOM kanalu glosowego
      if (tickCount === 3) {
        dumpVoiceDom();
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
