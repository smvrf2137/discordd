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

  // BFS po obiekcie (i zagniezdzonych polach) - zwraca pierwszy spelniajacy predykat
  function deepFind(root, pred) {
    const seen = new Set();
    const stack = [{ o: root, d: 0 }];
    while (stack.length) {
      const { o, d } = stack.pop();
      if (!o || seen.has(o)) continue;
      if (typeof o !== "object" && typeof o !== "function") continue;
      seen.add(o);
      let ok = false;
      try {
        ok = pred(o);
      } catch (e) {}
      if (ok) return o;
      if (d >= 4) continue;
      let keys;
      try {
        keys = Object.keys(o);
      } catch (e) {
        continue;
      }
      for (const k of keys) {
        let v;
        try {
          v = o[k];
        } catch (e) {
          continue;
        }
        if (v && (typeof v === "object" || typeof v === "function")) {
          stack.push({ o: v, d: d + 1 });
        }
      }
    }
    return null;
  }

  // Szuka modulu po fragmencie zrodla fabryki (require.m), nastepnie wymaga go
  // i przeszukuje eksporty w poszukiwaniu obiektu spelniajacego predykat.
  function findBySource(marker, pred) {
    if (!webpackRequire || !webpackRequire.m) return null;
    const factories = webpackRequire.m;
    for (const id of Object.keys(factories)) {
      let src = "";
      try {
        src = factories[id] ? factories[id].toString() : "";
      } catch (e) {
        continue;
      }
      if (!src || src.indexOf(marker) === -1) continue;
      let mod;
      try {
        mod = webpackRequire(id);
      } catch (e) {
        continue;
      }
      const found = deepFind(mod, pred);
      if (found) return found;
    }
    return null;
  }

  function scanModules() {
    const cacheCount = webpackRequire && webpackRequire.c ? Object.keys(webpackRequire.c).length : 0;
    const factoryCount = webpackRequire && webpackRequire.m ? Object.keys(webpackRequire.m).length : 0;

    // 1) Najpewniejsze: szukanie po tresci fabryk (leniwe moduly sa w require.m)
    if (!userStore) {
      userStore =
        findBySource("getCurrentUser", (o) => hasFn(o, "getCurrentUser") && hasFn(o, "getUser")) ||
        userStore;
    }
    if (!voiceStateStore) {
      voiceStateStore =
        findBySource("getVoiceStatesForChannel", (o) => hasFn(o, "getVoiceStatesForChannel")) ||
        voiceStateStore;
    }
    if (!volumeModule) {
      volumeModule =
        findBySource("setUserVolume", (o) => hasFn(o, "setUserVolume")) ||
        findBySource("updateUserVolume", (o) => /volume/i.test(Object.keys(o).join(",")) && hasFn(o, "setUserVolume")) ||
        volumeModule;
    }

    // 2) Fallback: skan joca zaladowanego cache
    if (!userStore || !voiceStateStore || !volumeModule) {
      eachCandidate((m) => {
        if (!m || (typeof m !== "object" && typeof m !== "function")) return;
        if (!userStore && hasFn(m, "getCurrentUser") && hasFn(m, "getUser")) userStore = m;
        if (!voiceStateStore && hasFn(m, "getVoiceStatesForChannel")) voiceStateStore = m;
        if (!volumeModule && hasFn(m, "setUserVolume")) volumeModule = m;
      });
    }

    dbg(
      "scan: modCache=" +
        cacheCount +
        " modFactory=" +
        factoryCount +
        " | user=" +
        !!userStore +
        " voice=" +
        !!voiceStateStore +
        " volume=" +
        !!volumeModule
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

  function classOf(el) {
    try {
      return el && el.className && el.className.baseVal !== undefined
        ? el.className.baseVal
        : String((el && el.className) || "");
    } catch (e) {
      return "";
    }
  }

  // ===== React Fiber =====
  function getFiber(el) {
    if (!el) return null;
    const key = Object.keys(el).find(
      (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    return key ? el[key] : null;
  }

  // Szuka w propsach wlokna obiektu uzytkownika ({id, username/globalName...})
  function userFromProps(props) {
    if (!props || typeof props !== "object") return null;
    for (const k of ["user", "author"]) {
      const u = props[k];
      if (u && (u.id || u.Id)) return u;
    }
    // voiceState bywa { userId, nick, mute, ... }
    if (props.voiceState) {
      const vs = props.voiceState;
      if (vs.userId) return { id: vs.userId, _muted: !!(vs.mute || vs.selfMute) };
    }
    // niektre wiersze trzymaja bezposrednio userId
    if (props.userId) return { id: props.userId };
    return null;
  }

  // Przechodzi po wloknie w gore i wydobywa dane uzytkownika + mowi/wyciszony
  function fiberUserInfo(el) {
    let fiber = getFiber(el);
    let hops = 0;
    while (fiber && hops < 20) {
      let p = null;
      try {
        p = fiber.memoizedProps || fiber.pendingProps;
      } catch (e) {}
      if (p) {
        const u = userFromProps(p);
        if (u && u.id) {
          const id = String(u.id);
          const name =
            u.globalName ||
            u.displayName ||
            u.username ||
            u.global_name ||
            (typeof p.name === "string" ? p.name : null) ||
            null;
          let muted = !!u._muted;
          let speaking = false;
          try {
            muted = muted || !!(p.muted || (p.voiceState && (p.voiceState.mute || p.voiceState.selfMute)));
            speaking = !!(p.speaking || (p.voiceState && p.voiceState.speaking));
          } catch (e) {}
          return { id, name, muted, speaking };
        }
      }
      fiber = fiber.return;
      hops++;
    }
    return null;
  }

  // Glowne zrodlo DOM: wiersze osob na kanale glosowym (klasa voiceUser__),
  // z danymi wyciaganymi z wlokien Reacta (dziala tez dla domyslnych awatarow).
  function collectVoiceParticipants(myId) {
    const users = new Map();
    try {
      const rows = document.querySelectorAll('[class*="voiceUser"], [class*="voice-user"]');
      rows.forEach((row) => {
        const info = fiberUserInfo(row);
        if (!info || !info.id) return;
        if (myId && info.id === String(myId)) return;

        // nazwa z DOM jako uzupelnienie
        let domName = null;
        try {
          const span = row.querySelector("span");
          if (span) {
            const t = (span.textContent || "").trim();
            if (t && t.length < 40) domName = t;
          }
        } catch (e) {}

        users.set(info.id, {
          id: info.id,
          name:
            info.name ||
            userName(info.id) ||
            domName ||
            "User " + info.id.slice(-4),
          volume: normalizedVolume(info.id),
          muted: info.muted,
          speaking: info.speaking,
        });
      });

      // Uzupelnienie: kafelki rozmowy w glownym widoku (participant/tile)
      if (users.size === 0) {
        const tiles = document.querySelectorAll(
          '[class*="participant"], [class*="tile_"], [class*="speaker"]'
        );
        tiles.forEach((tile) => {
          const info = fiberUserInfo(tile);
          if (!info || !info.id) return;
          if (myId && info.id === String(myId)) return;
          if (users.has(info.id)) return;
          users.set(info.id, {
            id: info.id,
            name: info.name || userName(info.id) || "User " + info.id.slice(-4),
            volume: normalizedVolume(info.id),
            muted: info.muted,
            speaking: info.speaking,
          });
        });
      }
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
