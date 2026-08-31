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
  dbg(
    "UA=" +
      navigator.userAgent.slice(0, 120) +
      " | getDisplayMedia=" +
      (!!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia)
  );
  if (!bridge) return;

  let webpackRequire = null;

  // Znalezione moduly
  let userStore = null;
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

  // BFS po obiekcie (i zagniezdzonych polach) - zwraca pierwszy spelniajacy predykat.
  // maxDepth i maxNodes chronia przed przegladaniem wielkich kolekcji (np. GuildStore).
  function deepFind(root, pred, maxDepth, maxNodes) {
    const seen = new Set();
    const stack = [{ o: root, d: 0 }];
    let nodes = 0;
    maxDepth = maxDepth || 5;
    maxNodes = maxNodes || 20000;
    while (stack.length) {
      const { o, d } = stack.pop();
      if (!o || seen.has(o)) continue;
      if (typeof o !== "object" && typeof o !== "function") continue;
      seen.add(o);
      if (++nodes > maxNodes) break;
      let ok = false;
      try {
        ok = pred(o);
      } catch (e) {}
      if (ok) return o;
      if (d >= maxDepth) continue;
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

  // Gleboki skan ZALADOWANYCH modulow (require.c) - bez filtrowania nazw kluczy.
  // Znajduje obiekty po rzeczywistych (zachowanych w runtime) nazwach metod.
  function findInLoadedCache(pred) {
    if (!webpackRequire || !webpackRequire.c) return null;
    const cache = webpackRequire.c;
    for (const id of Object.keys(cache)) {
      let ex;
      try {
        ex = cache[id] && cache[id].exports;
      } catch (e) {
        continue;
      }
      if (!ex) continue;
      const found = deepFind(ex, pred, 5, 4000);
      if (found) return found;
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
      const found = deepFind(mod, pred, 5, 20000);
      if (found) return found;
    }
    return null;
  }

  function scanModules() {
    const cacheCount = webpackRequire && webpackRequire.c ? Object.keys(webpackRequire.c).length : 0;
    const factoryCount = webpackRequire && webpackRequire.m ? Object.keys(webpackRequire.m).length : 0;

    // Uwaga: akcji per-user glosnosci NIE MA w sklepach Flux (jest w silniku
    // rozmowy). Glosnosc ustawiamy przez natywne menu kontekstowe (setUserVolumeDOM).
    if (!userStore) {
      userStore =
        findInLoadedCache((o) => hasFn(o, "getCurrentUser") && hasFn(o, "getUser")) ||
        findBySource("getCurrentUser", (o) => hasFn(o, "getCurrentUser") && hasFn(o, "getUser")) ||
        userStore;
    }
    if (!voiceStateStore) {
      voiceStateStore =
        findInLoadedCache((o) => hasFn(o, "getVoiceStatesForChannel")) ||
        findBySource("getVoiceStatesForChannel", (o) => hasFn(o, "getVoiceStatesForChannel")) ||
        voiceStateStore;
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
        " glosnosc=DOM"
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

  // Pamietamy ustawione przez nas glosnosci (0..1), bo natywnej wartosci nie
  // da sie odczytac bez otwierania menu.
  const userVolumes = {};

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

  // Glosnosc uzytkownika 0..1 (1 = domyslna). Wartosci natywnej nie czytamy
  // w locie (menu kontekstowe) — zwracamy ostatnio ustawiona przez nas.
  function normalizedVolume(userId) {
    const id = String(userId);
    if (typeof userVolumes[id] === "number") return userVolumes[id];
    return 1;
  }

  // ===== USTAWIANIE GLOSNOSCI PRZEZ NATYWNE MENU DISCORDA =====
  // Znajduje element wiersza osoby na kanale glosowym po jej ID.
  function findVoiceRow(userId) {
    const id = String(userId);
    const rows = document.querySelectorAll(
      '[class*="voiceUser"], [class*="voice-user"], [class*="userSmall"]'
    );
    for (const row of rows) {
      const info = fiberUserInfo(row);
      if (info && String(info.id) === id) return row;
      // fallback po URL awatara
      const img = row.querySelector ? row.querySelector('img[src*="avatars/"]') : null;
      if (img) {
        const m = (img.getAttribute("src") || "").match(/avatars\/(\d{6,})\//);
        if (m && m[1] === id) return row;
      }
    }
    return null;
  }

  function openContextMenu(row) {
    try {
      const ev = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 2,
        buttons: 2,
      });
      row.dispatchEvent(ev);
    } catch (e) {}
  }

  function closeContextMenu() {
    try {
      const esc = new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(esc);
      document.body.dispatchEvent(esc);
      // kliknij w pustke
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, clientX: 5, clientY: 5 })
      );
    } catch (e) {}
  }

  // Wyslanie klawisza do suwaka (keydown + keyup).
  function fireKey(el, key, code, keyCode) {
    const opt = {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      view: window,
    };
    try {
      el.dispatchEvent(new KeyboardEvent("keydown", opt));
      el.dispatchEvent(new KeyboardEvent("keyup", opt));
    } catch (e) {}
  }

  // ===== NA ZYWO: maszyna stanu przeciagania =====
  // Suwak nasz i natywny maja te sama skale 0..100 (100 = domyslna).
  // Menu kontekstowe otwieramy raz przy rozpoczeciu przeciagania; samopedzaca
  // sie petla async na biezaco sciga cel: PageUp/PageDown = skok o 10,
  // strzalki = skok o 1, z ~18ms odstepem (kazdy klawisz jest commitowany
  // przez Reacta). Po puszczeniu suwaka petla dogania DOKLADNIE wartosc
  // koncowa i dopiero wtedy zamyka menu.
  const live = {
    userId: null,
    target: 100,
    state: "idle", // idle | opening | open | closing
    ending: false,
    slider: null,
    gen: 0,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getVolumeSlider() {
    return document.querySelector("#user-context-user-volume [role='slider']");
  }

  function sliderValue(slider) {
    const v = parseFloat(slider && slider.getAttribute("aria-valuenow"));
    return isFinite(v) ? v : 100;
  }

  function finishLive(gen) {
    if (gen !== live.gen) return;
    const v = live.slider ? sliderValue(live.slider) : null;
    dbg("live end " + live.userId + " -> " + live.target + "% (aria=" + v + ")");
    closeContextMenu();
    live.state = "closing";
    live.ending = false;
    live.slider = null;
    const endedGen = live.gen;
    setTimeout(() => {
      if (live.gen === endedGen && live.state === "closing") {
        live.state = "idle";
        live.userId = null;
      }
    }, 200);
  }

  async function driveLoop(gen) {
    let missCount = 0;
    while (gen === live.gen && live.state !== "idle") {
      const slider = getVolumeSlider();
      if (!slider) {
        missCount++;
        // menu zniknelo w trakcie (Discord przerenderowal / Esc) - otworz ponownie
        if (missCount === 12 && live.userId && !live.ending) {
          const row = findVoiceRow(live.userId);
          if (row) {
            live.state = "opening";
            openContextMenu(row);
          }
        }
        await sleep(25);
        continue;
      }
      missCount = 0;
      live.slider = slider;
      live.state = "open";
      try {
        slider.focus();
      } catch (e) {}

      const cur = sliderValue(slider);
      const diff = Math.round(live.target - cur);
      userVolumes[live.userId] = live.target / 100;

      if (diff === 0) {
        if (live.ending) {
          finishLive(gen);
          return;
        }
        await sleep(35);
        continue;
      }

      // duze skoki: PageUp/PageDown (+/-10), drobne: strzalki (+/-1)
      const up = diff > 0;
      const big = Math.floor(Math.abs(diff) / 10);
      const small = Math.abs(diff) % 10;
      for (let i = 0; i < big; i++) {
        if (gen !== live.gen || live.state === "idle") return;
        fireKey(slider, up ? "PageUp" : "PageDown", up ? "PageUp" : "PageDown", up ? 33 : 34);
        await sleep(18);
      }
      for (let i = 0; i < small; i++) {
        if (gen !== live.gen || live.state === "idle") return;
        fireKey(slider, up ? "ArrowRight" : "ArrowLeft", up ? "ArrowRight" : "ArrowLeft", up ? 39 : 37);
        await sleep(18);
      }
      // krotka pauza by Discord zacommitowal, potem czytamy nowa wartosc
      await sleep(live.ending ? 10 : 5);
    }
  }

  function startLiveVolume(userId, percent) {
    const id = String(userId);
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    userVolumes[id] = p / 100;

    if (live.userId === id && (live.state === "open" || live.state === "opening")) {
      // ten sam uzytkownik, menu w trakcie: tylko aktualizuj cel
      live.target = p;
      live.ending = false;
      return;
    }

    // nowa sesja (inny uzytkownik / bez menu): zamknij stare, nowa generacja
    if (live.state === "open" || live.state === "opening") closeContextMenu();
    live.gen++;
    live.userId = id;
    live.target = p;
    live.ending = false;
    live.slider = null;

    const row = findVoiceRow(id);
    if (!row) {
      dbg("live: brak wiersza osoby " + id);
      live.state = "idle";
      return;
    }
    try {
      row.scrollIntoView && row.scrollIntoView({ block: "center" });
    } catch (e) {}
    live.state = "opening";
    openContextMenu(row);
    driveLoop(live.gen);
  }

  function endLiveVolume(userId, percent) {
    const id = String(userId);
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    userVolumes[id] = p / 100;

    if (live.userId !== id || live.state === "idle" || live.state === "closing") {
      // brak aktywnej sesji - wystartuj ja, by moc ustawic wartosc
      startLiveVolume(id, p);
    }
    live.target = p;
    live.ending = true; // petla dogona dokladnie cel i zamknie menu (finishLive)

    // bezpienik: gdyby menu nie dotarlo do celu (np. zniknelo), zamknij po 1.2s
    const gen = live.gen;
    setTimeout(() => {
      if (gen === live.gen && live.ending) finishLive(gen);
    }, 1200);
  }

  // Zgodnosc: jednorazowe ustawienie = live start+end
  function setUserVolume(userId, percent) {
    startLiveVolume(userId, percent);
    endLiveVolume(userId, percent);
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

  // Czy "cos" wyglada jak obiekt uzytkownika Discorda (musi miec sensowne id)
  function looksLikeUser(o) {
    try {
      if (!o || typeof o !== "object") return null;
      const id = o.id || o.Id || o.user_id;
      if (id === undefined || id === null) return null;
      const s = String(id);
      if (!/^\d{6,}$/.test(s)) return null;
      // upewnij sie ze to "uzytkownik" a nie np. rola/emoji: musi miec pola tekstowe
      const hasUserLike =
        typeof o.username === "string" ||
        typeof o.globalName === "string" ||
        typeof o.displayName === "string" ||
        typeof o.global_name === "string" ||
        typeof o.tag === "string" ||
        typeof o.bot === "boolean";
      if (!hasUserLike) return null;
      return {
        id: s,
        globalName: o.globalName || o.global_name || o.displayName || o.username || null,
      };
    } catch (e) {
      return null;
    }
  }

  // Przeszukuje plaski obiekt props w poszukiwaniu obiektu uzytkownika / voiceState
  function userFromProps(props) {
    if (!props || typeof props !== "object") return null;

    // bezposrednie pola uzytkownika
    for (const k of ["user", "author", "profileUser"]) {
      const u = looksLikeUser(props[k]);
      if (u) return u;
    }
    // voiceState: { userId, nick, mute, selfMute, speaking, ... }
    const vs = props.voiceState || props.voice || props.state;
    if (vs && typeof vs === "object") {
      const vid = vs.userId || vs.user_id || vs.id;
      if (vid && /^\d{6,}$/.test(String(vid))) {
        return {
          id: String(vid),
          globalName: vs.nick || vs.nickname || vs.username || null,
          _muted: !!(vs.mute || vs.selfMute || vs.self_mute),
          _speaking: !!vs.speaking,
        };
      }
    }
    // bezposrednie userId + nazwa
    if (props.userId && /^\d{6,}$/.test(String(props.userId))) {
      return { id: String(props.userId), globalName: typeof props.name === "string" ? props.name : null };
    }
    // przejrzyj plytkie wartosci props (moga byc w "record"/"item")
    for (const k of Object.keys(props)) {
      try {
        const v = props[k];
        if (!v || typeof v !== "object") continue;
        const u = looksLikeUser(v);
        if (u) return u;
        if (v.user) {
          const u2 = looksLikeUser(v.user);
          if (u2) return { ...u2, _muted: !!(v.mute || v.selfMute), _speaking: !!v.speaking };
        }
      } catch (e) {}
    }
    return null;
  }

  // Przechodzi po wloknie w gore (a takze przez memoizedState/hooki) i zwraca
  // dane uzytkownika + mowi/wyciszony.
  function fiberUserInfo(el) {
    let fiber = getFiber(el);
    let hops = 0;
    while (fiber && hops < 30) {
      const candidates = [];
      try {
        if (fiber.memoizedProps) candidates.push(fiber.memoizedProps);
        if (fiber.pendingProps) candidates.push(fiber.pendingProps);
      } catch (e) {}

      let muted = false;
      let speaking = false;
      for (const p of candidates) {
        const u = userFromProps(p);
        if (u && u.id) {
          try {
            muted = muted || !!u._muted || !!p.muted;
            speaking = speaking || !!u._speaking || !!p.speaking;
            if (p.voiceState) {
              muted = muted || !!(p.voiceState.mute || p.voiceState.selfMute);
              speaking = speaking || !!p.voiceState.speaking;
            }
          } catch (e) {}
          return { id: u.id, name: u.globalName || u.displayName || u.username || null, muted, speaking };
        }
      }

      // hooki (memoizedState) - np. memoizowane {user, voiceState}
      try {
        let hook = fiber.memoizedState;
        let hh = 0;
        while (hook && hh < 8) {
          const ms = hook.memoizedState;
          if (ms && typeof ms === "object") {
            const u = userFromProps(ms);
            if (u && u.id) {
              return {
                id: u.id,
                name: u.globalName || u.displayName || u.username || null,
                muted: !!u._muted,
                speaking: !!u._speaking,
              };
            }
          }
          hook = hook.next;
          hh++;
        }
      } catch (e) {}

      fiber = fiber.return;
      hops++;
    }
    return null;
  }

  // Glowne zrodlo DOM: wiersze osob na kanale glosowym (klasa voiceUser__),
  // z danymi wyciaganymi z wlokien Reacta (dziala tez dla domyslnych awatarow).
  let rowDumpDone = false;

  function collectVoiceParticipants(myId) {
    const users = new Map();
    try {
      const rows = document.querySelectorAll(
        '[class*="voiceUser"], [class*="voice-user"], [class*="userSmall"]'
      );
      if (!rowDumpDone && rows.length) {
        rowDumpDone = true;
        rows.forEach((row, i) => {
          const info = fiberUserInfo(row);
          const cls = classOf(row).slice(0, 60);
          dbg(
            "wiersz " +
              i +
              ": klasa='" +
              cls +
              "'" +
              " id=" +
              (info ? info.id : "BRAK") +
              " nazwa=" +
              (info ? info.name || "-" : "-")
          );
        });
      }
      rows.forEach((row) => {
        let info = fiberUserInfo(row);
        if (!info || !info.id) {
          // fallback: id z URL awatara w tym wierszu
          const img = row.querySelector ? row.querySelector('img[src*="avatars/"]') : null;
          if (img) {
            const m = (img.getAttribute("src") || "").match(/avatars\/(\d{6,})\//);
            if (m) info = { id: m[1], name: null, muted: false, speaking: false };
          }
        }
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
  let lastParticipantCount = -1;
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

  // ===== LIVE TWITCH W KANALE #transmisja =====
  // Gdy uzytkownik jest na kanale tekstowym o nazwie zawierajacej "transmisja",
  // mierzymy obszar listy wiadomosci (nad polem pisania) i wysylamy jego
  // wspolrzedne do maina, by nakladac na niego player Twitcha.
  // Mapa kanal Discorda -> login Twitcha (z maina, do odczytu w rendererze).
  let twitchChannelMap = {};

  // Id i nazwa BIEZACEGO kanalu tekstowego. Id z linku kanalu
  // (data-list-item-id="channels___<id>" / href="/channels/<guild>/<channel>").
  function currentChannelInfo() {
    try {
      let id = null;
      let name = "";
      // zaznaczony watek na liscie kanalow
      const sel = document.querySelector(
        '[aria-current="page"][data-list-item-id^="channels___"], ' +
          'a[aria-current="page"][href*="/channels/"]'
      );
      if (sel) {
        const dli = sel.getAttribute("data-list-item-id") || "";
        const m = dli.match(/channels___(\d+)/);
        if (m) id = m[1];
        if (!id) {
          const hm = (sel.getAttribute("href") || "").match(/\/channels\/\d+\/(\d+)/);
          if (hm) id = hm[1];
        }
        const al = sel.getAttribute("aria-label") || "";
        const cm = al.match(/^\s*(.*?)\s*\(kanał tekstowy\)/i) || al.match(/^(.*?)\s*\(/);
        name = cm ? cm[1] : sel.textContent || "";
      }
      // fallback: tytul kanalu w naglowku
      if (!name) {
        const h1 = document.querySelector(
          "section[aria-label=\"Nagłówek kanału\"] h1, h1[class*=\"title__\"]"
        );
        if (h1) name = h1.textContent || "";
      }
      // fallback id z URL-a
      if (!id) {
        const um = (location.hash || location.pathname || "").match(/\/channels\/\d+\/(\d+)/);
        if (um) id = um[1];
      }
      return { id: id, name: name.trim() };
    } catch (e) {
      return { id: null, name: "" };
    }
  }

  // Analogiczna logika jak w mainie: mapa ma pierwszenstwo, potem nazwa
  // zawierajaca "transmisja" (domyslny streamer), inaczej brak.
  function loginForChannel(info) {
    try {
      const id = info && info.id ? String(info.id) : null;
      if (id && Object.prototype.hasOwnProperty.call(twitchChannelMap, id)) {
        const l = twitchChannelMap[id];
        return l ? String(l) : null;
      }
      const nm = String((info && info.name) || "").toLowerCase();
      if (nm.indexOf("transmisja") !== -1) return "vanqubix";
    } catch (e) {}
    return null;
  }

  // Czy na biezacym kanale ma byc osadzony live? (jest przypisany streamer)
  function isTransmisjaChannel() {
    try {
      return loginForChannel(currentChannelInfo()) !== null;
    } catch (e) {}
    return false;
  }

  // Pelny obszar "kina": live i czat wypelniaja cala prawa strone czatu -
  // od gornej krawedzi naglowka kanalu (pasek "#nazwa-kanalu") az po sam
  // dol okna (wlacznie z paskiem pisania). Player = kolumna wiadomosci,
  // czat = miejsce listy czlonkow (tez siegajace gornego naglowka).
  function measureTransmisjaAreas() {
    try {
      const chatMain = document.querySelector("main[class*=\"chatContent\"]");
      if (!chatMain) return null;
      const mr = chatMain.getBoundingClientRect();
      if (mr.width < 200) return null;

      // gora: naglowek kanalu (pasek nad wiadomosciami ORAZ nad lista czlonkow)
      let topY = mr.top;
      const header =
        document.querySelector("section[aria-label=\"Nagłówek kanału\"]") ||
        document.querySelector("div[class*=\"subtitleContainer\"]");
      if (header) {
        const hr = header.getBoundingClientRect();
        if (hr.top >= 0 && hr.top < topY) topY = hr.top;
      }

      // player: cala kolumna wiadomosci od naglowka do dolu okna
      const player = {
        x: Math.round(mr.left),
        y: Math.round(topY),
        width: Math.round(mr.width),
        height: Math.round(mr.bottom - topY),
      };
      if (player.height < 150) return null;

      // czat: szerokosc od listy czlonkow, ale od gornego naglowka do dolu
      let chat = null;
      const aside = document.querySelector("aside[class*=\"membersWrap\"]");
      if (aside) {
        const ar = aside.getBoundingClientRect();
        if (ar.width >= 150 && ar.bottom - topY >= 200) {
          chat = {
            x: Math.round(ar.left),
            y: Math.round(topY),
            width: Math.round(ar.width),
            height: Math.round(ar.bottom - topY),
          };
        }
      }
      return { player: player, chat: chat };
    } catch (e) {
      return null;
    }
  }

  // Prawy panel: lista czlonkow (miejsce na czat Twitcha). Gdy jest
  // schowany (klasa hiddenMembers), wymuszamy jego widocznosc CSS-em.
  const MEMBERS_FORCE_CSS =
    "aside[class*='membersWrap']{" +
    "display:flex !important; visibility:visible !important; opacity:1 !important;" +
    "width:240px !important; min-width:240px !important; max-width:240px !important;" +
    "flex:0 0 240px !important;}";

  function setMembersForced(on) {
    try {
      let style = document.getElementById("__twitchChatForce");
      if (on) {
        if (!style) {
          style = document.createElement("style");
          style.id = "__twitchChatForce";
          (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = MEMBERS_FORCE_CSS;
      } else if (style) {
        style.remove();
      }
    } catch (e) {}
  }

  let lastTwitchRectSig = "";
  let lastChannelKey = "";
  function detectTransmisja() {
    try {
      const info = currentChannelInfo();
      const key = String(info.id || info.name || "");
      if (key !== lastChannelKey) {
        lastChannelKey = key;
        lastTwitchRectSig = ""; // zmiana kanalu = wymus nowy pomiar
        setChannelLiveTile();
      }

      if (!isTransmisjaChannel()) {
        setMembersForced(false);
        if (lastTwitchRectSig !== "none") {
          lastTwitchRectSig = "none";
          bridge.pushTwitchEmbed({ channelId: info.id, channelName: info.name, player: null });
        }
        return;
      }
      // panel czlonkow ma byc widoczny (tam wyladuje czat Twitcha)
      setMembersForced(true);

      const areas = measureTransmisjaAreas();
      if (!areas || !areas.player) return;
      const payload = {
        channelId: info.id,
        channelName: info.name,
        player: areas.player,
        chat: areas.chat,
      };
      const sig = JSON.stringify(payload);
      if (sig !== lastTwitchRectSig) {
        lastTwitchRectSig = sig;
        bridge.pushTwitchEmbed(payload);
      }
    } catch (e) {}
  }

  // main prosi o ponowny pomiar (zmiana rozmiaru okna / zamkniecie okna Twitcha)
  if (bridge.onTwitchEmbedMeasure) {
    bridge.onTwitchEmbedMeasure(() => {
      lastTwitchRectSig = ""; // wymus wyslanie swiezego rect
      detectTransmisja();
    });
  }

  // ===== Animacja kafla kanalu #transmisja, gdy Twitch nadaje =====
  // Oznaczamy pozycje na liscie kanalow (lewy pasek) klasa __twLive, ktora
  // daje subtelny czerwony "oddech" + przesuwajacy sie blysk (shimmer).
  const CHANNEL_LIVE_CSS = `
.__twLive{position:relative !important;}
.__twLive > *{position:relative;z-index:1;}
.__twLive::before{
  content:"";position:absolute;inset:0;z-index:0;border-radius:6px;pointer-events:none;
  background:linear-gradient(100deg,rgba(232,22,42,0.16) 0%,rgba(232,22,42,0.30) 50%,rgba(232,22,42,0.16) 100%);
  animation:twLiveGlow 2.0s ease-in-out infinite;
}
.__twLive::after{
  content:"";position:absolute;inset:0;z-index:2;border-radius:6px;pointer-events:none;
  background:linear-gradient(110deg,transparent 0%,transparent 38%,rgba(255,255,255,0.22) 50%,transparent 62%,transparent 100%);
  background-size:260% 100%;
  animation:twLiveShimmer 2.6s linear infinite;
}
@keyframes twLiveGlow{
  0%,100%{opacity:.55;box-shadow:inset 0 0 0 1px rgba(232,22,42,.25);}
  50%{opacity:1;box-shadow:inset 0 0 0 1px rgba(255,70,90,.75),0 0 12px rgba(232,22,42,.35);}
}
@keyframes twLiveShimmer{
  0%{background-position:160% 0;}
  100%{background-position:-60% 0;}
}
.__twLive [class*="linkTop"],
.__twLive [class*="name"]{color:#ff4d5e !important;}
`;

  function ensureChannelLiveStyle() {
    try {
      let s = document.getElementById("__twLiveStyle");
      if (!s) {
        s = document.createElement("style");
        s.id = "__twLiveStyle";
        (document.head || document.documentElement).appendChild(s);
      }
      if (s.textContent !== CHANNEL_LIVE_CSS) s.textContent = CHANNEL_LIVE_CSS;
    } catch (e) {}
  }

  // Znajduje wiersz kanalu na liscie (lewy pasek) po jego ID.
  function channelItemById(id) {
    if (!id) return null;
    try {
      return (
        document.querySelector('[data-list-item-id="channels___' + id + '"]') ||
        document.querySelector('a[href*="/channels/' + id + '"]')
      );
    } catch (e) {}
    return null;
  }

  let twLiveOn = false;
  // Oznacza kafl BIEZACEGO kanalu (jesli jest live). Klasa __twLive daje anim.
  function setChannelLiveTile() {
    try {
      document.querySelectorAll(".__twLive").forEach((el) => el.classList.remove("__twLive"));
      if (!twLiveOn) return;
      const info = currentChannelInfo();
      if (!loginForChannel(info)) return; // biezacy kanal nie ma streamera
      let li = channelItemById(info.id);
      if (li) {
        li = li.closest("li") || li;
        ensureChannelLiveStyle();
        if (!li.classList.contains("__twLive")) li.classList.add("__twLive");
      }
    } catch (e) {}
  }

  if (bridge.onTwitchLive) {
    bridge.onTwitchLive((live) => {
      twLiveOn = !!live;
      setChannelLiveTile();
    });
  }

  // mapa kanal->login z maina
  if (bridge.onTwitchChannelMap) {
    bridge.onTwitchChannelMap((map) => {
      twitchChannelMap = map || {};
      lastTwitchRectSig = "";
      detectTransmisja();
      setChannelLiveTile();
      ensureSettingsButton();
    });
  }
  if (bridge.requestTwitchChannelMap) bridge.requestTwitchChannelMap();
  if (bridge.requestTwitchLive) bridge.requestTwitchLive();

  // ===== Przycisk ustawien live na gornym pasku (otwiera NATYWNE okno maina) =====
  // Okno ustawien jest osobnym oknem procesu glownego, bo modal DOM w stronie
  // Discorda chowalby sie pod nakladkowymi widokami playera/czatu Twitcha.
  const SETTINGS_CSS = `
.__twTopWrap{display:inline-flex;align-items:center;justify-content:center;margin:0 2px;}
.__twTopBtn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;color:#b5bac1;cursor:pointer;background:transparent;border:none;}
.__twTopBtn:hover{color:#fff;background:rgba(255,255,255,.08);}
.__twTopBtn svg{width:18px;height:18px;}
.__twTopBtn.__twActive{color:#a06cff;}
.__twTopBtn.__twActive:hover{color:#b993ff;}
.__twTopBtn.__twActive .__twDot{position:absolute;top:3px;right:3px;width:8px;height:8px;border-radius:50%;background:#e0162a;box-shadow:0 0 0 2px #1e1f22;animation:twTopDot 1.4s ease-in-out infinite;}
@keyframes twTopDot{0%,100%{opacity:1;}50%{opacity:.3;}}
`;

  function ensureSettingsStyle() {
    try {
      let s = document.getElementById("__twCfgStyle");
      if (!s) {
        s = document.createElement("style");
        s.id = "__twCfgStyle";
        (document.head || document.documentElement).appendChild(s);
      }
      s.textContent = SETTINGS_CSS;
    } catch (e) {}
  }

  // Gorny pasek okna: kontener prawej grupy ikon (skrzynka odbiorcza, pomoc).
  // Przycisk ustawien live dokladamy wlasnie tam, by byl dostepny na kazdym
  // kanale (dziala na biezacy kanal tekstowy).
  function topBarTrailing() {
    try {
      const bar =
        document.querySelector('div[data-window-chrome="true"] [class*="trailing"]') ||
        document.querySelector('[class*="bar_"][data-window-chrome="true"] [class*="trailing"]');
      if (bar) return bar;
      // fallback: po ikonie "Pomoc" / "Skrzynka odbiorcza"
      const help = document.querySelector('[aria-label="Pomoc"]');
      if (help) {
        const wrap = help.closest('[class*="trailing"]') || help.parentElement;
        return wrap;
      }
    } catch (e) {}
    return null;
  }

  function ensureSettingsButton() {
    try {
      const trailing = topBarTrailing();
      if (!trailing) return;
      let wrap = trailing.querySelector("#__twCfgWrap");
      if (!wrap) {
        ensureSettingsStyle();
        wrap = document.createElement("div");
        wrap.id = "__twCfgWrap";
        wrap.className = "__twTopWrap";
        wrap.innerHTML =
          '<button id="__twTopBtn" class="__twTopBtn" type="button" aria-label="Stream Twitch dla kanału" title="Stream Twitch dla kanału">' +
          '<svg aria-hidden="true" role="img" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M4 3l-1 2v13h4v3l3-3h5l5-5V3H4zm14 9l-3 3H9l-3 3v-3H5V5h13v7z"/><circle cx="10" cy="10" r="1.4"/><circle cx="14" cy="10" r="1.4"/></svg>' +
          '<span class="__twDot"></span>' +
          "</button>";
        const btn = wrap.querySelector("#__twTopBtn");
        const open = (e) => {
          if (e) e.stopPropagation();
          const info = currentChannelInfo();
          if (info.id && bridge.openTwitchSettings) {
            bridge.openTwitchSettings(String(info.id), info.name || "");
          }
        };
        btn.addEventListener("click", open);
        trailing.insertBefore(wrap, trailing.firstChild);
      }
      const btn = wrap.querySelector("#__twTopBtn");
      if (btn) {
        const info = currentChannelInfo();
        const login = loginForChannel(info);
        btn.classList.toggle("__twActive", !!login);
        btn.title = login
          ? "Live: " + login + " — kliknij, aby zmienić/odłączyć"
          : "Przypnij live Twitch do tego kanału";
      }
    } catch (e) {}
  }

  // React przerysowuje pasek/liscie - ponawiaj przycisk i oznaczenie kafla
  setInterval(() => {
    ensureSettingsButton();
    if (twLiveOn) setChannelLiveTile();
  }, 1500);



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
    if (participants.size && participants.size !== lastParticipantCount) {
      lastParticipantCount = participants.size;
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
      } else if (!userStore || !voiceStateStore) {
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

      // osadzenie live Twitcha w kanale #transmisja
      detectTransmisja();

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
            " glosnosc=DOM" +
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
    setUserVolume(userId, percent);
  });

  if (bridge.onSetUserVolumeLive) {
    bridge.onSetUserVolumeLive((userId, percent) => {
      startLiveVolume(userId, percent);
    });
  }

  if (bridge.onSetUserVolumeEnd) {
    bridge.onSetUserVolumeEnd((userId, percent) => {
      endLiveVolume(userId, percent);
    });
  }

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
