const appsList = document.getElementById("apps-list");
const usersList = document.getElementById("users-list");
const statusHint = document.getElementById("status-hint");
const closeBtn = document.getElementById("close-btn");

closeBtn.addEventListener("click", () => {
  window.electronMixer.closeMixer();
});

// Rozpoznawanie znanych aplikacji po nazwie procesu
const APP_PRESETS = [
  { match: ["discord", "my-discord-client", "electron"], icon: "💬", label: "Discord" },
  { match: ["rust"], icon: "🎮", label: "Rust" },
  { match: ["spotify"], icon: "🎵", label: "Spotify" },
  { match: ["chrome"], icon: "🌐", label: "Chrome" },
  { match: ["msedge"], icon: "🌐", label: "Edge" },
  { match: ["firefox"], icon: "🦊", label: "Firefox" },
  { match: ["opera"], icon: "🔴", label: "Opera" },
  { match: ["brave"], icon: "🦁", label: "Brave" },
  { match: ["steam"], icon: "🎮", label: "Steam" },
  { match: ["cs2", "csgo"], icon: "🔫", label: "Counter-Strike" },
  { match: ["valorant"], icon: "🎯", label: "Valorant" },
  { match: ["league", "lol"], icon: "⚔️", label: "League of Legends" },
  { match: ["minecraft", "javaw"], icon: "🟩", label: "Minecraft" },
  { match: ["fortnite"], icon: "🏗️", label: "Fortnite" },
  { match: ["overwatch"], icon: "🎮", label: "Overwatch" },
  { match: ["teamspeak", "ts3client"], icon: "🎧", label: "TeamSpeak" },
  { match: ["tsl", "teams"], icon: "👥", label: "Teams" },
  { match: ["obs64", "obs32", "obs"], icon: "🎥", label: "OBS" },
  { match: ["vlc"], icon: "🎬", label: "VLC" },
  { match: ["wmplayer", "mediaplayer"], icon: "🎞️", label: "Media Player" },
  { match: ["foobar2000"], icon: "🎶", label: "foobar2000" },
  { match: ["aimp"], icon: "🎶", label: "AIMP" },
  { match: ["slack"], icon: "💼", label: "Slack" },
  { match: ["telegram"], icon: "✈️", label: "Telegram" },
  { match: ["whatsapp"], icon: "📱", label: "WhatsApp" },
  { match: ["signal"], icon: "🔒", label: "Signal" },
  { match: ["mpv"], icon: "🎬", label: "mpv" },
  { match: ["dwm"], icon: "🔊", label: "Menedżer dźwięku" },
];

function presetFor(name) {
  const n = (name || "").toLowerCase();
  for (const p of APP_PRESETS) {
    if (p.match.some((m) => n.includes(m))) return p;
  }
  return null;
}

function prettyName(name) {
  const base = (name || "app").replace(/\.(exe)$/i, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function describeApp(app) {
  if (app.self) {
    return { icon: "💬", label: "Discord" };
  }
  const p = presetFor(app.name);
  if (p) return { icon: p.icon, label: p.label };
  return { icon: "🔊", label: prettyName(app.name) };
}

function paintSlider(slider, percent, color) {
  slider.style.setProperty("--pct", percent + "%");
  if (color) slider.style.setProperty("--fill", color);
}

function makeRow({ icon, name, percent, sliderClass, onCommit }) {
  const row = document.createElement("div");
  row.className = "row";

  const iconEl = document.createElement("span");
  iconEl.className = "icon";
  iconEl.textContent = icon;
  if (!icon) iconEl.style.display = "none";

  const nameEl = document.createElement("span");
  nameEl.className = name.className || "app-name";
  nameEl.textContent = name.text;

  const wrap = document.createElement("div");
  wrap.className = "slider-wrap";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.step = "1";
  slider.className = "slider " + (sliderClass || "");
  slider.value = String(percent);
  paintSlider(slider, percent);

  const pctEl = document.createElement("span");
  pctEl.className = "percent";
  pctEl.textContent = percent + "%";

  wrap.appendChild(slider);

  row.appendChild(iconEl);
  if (name.before) row.appendChild(name.before);
  row.appendChild(nameEl);
  row.appendChild(wrap);
  row.appendChild(pctEl);

  slider.addEventListener("input", () => {
    const v = parseInt(slider.value, 10) || 0;
    paintSlider(slider, v);
    pctEl.textContent = v + "%";
  });

  slider.addEventListener("change", () => {
    const v = parseInt(slider.value, 10) || 0;
    onCommit(v, slider);
  });

  return { row, slider, pctEl };
}

function syncRow(bundle, percent) {
  const p = Math.round(percent * 100);
  bundle.slider.value = String(p);
  paintSlider(bundle.slider, p);
  bundle.pctEl.textContent = p + "%";
}

// ====== APLIKACJE ======
const appBundles = new Map(); // pid -> { row, slider, pctEl }

function renderApps(apps) {
  const sorted = (apps || []).slice().sort((a, b) => {
    if (!!a.self !== !!b.self) return a.self ? -1 : 1;
    const da = describeApp(a).label.toLowerCase();
    const db = describeApp(b).label.toLowerCase();
    return da < db ? -1 : da > db ? 1 : 0;
  });

  const seen = new Set();

  for (const app of sorted) {
    seen.add(app.pid);
    let bundle = appBundles.get(app.pid);

    if (!bundle) {
      const desc = describeApp(app);
      bundle = makeRow({
        icon: desc.icon,
        name: { text: desc.label },
        percent: Math.round(app.volume * 100),
        sliderClass: "",
        onCommit: (v) => {
          window.electronMixer.setAppVolume(app.pid, v);
        },
      });
      appsList.appendChild(bundle.row);
      appBundles.set(app.pid, bundle);
    } else if (document.activeElement !== bundle.slider) {
      syncRow(bundle, app.volume);
    }
  }

  for (const [pid, bundle] of Array.from(appBundles.entries())) {
    if (!seen.has(pid)) {
      bundle.row.remove();
      appBundles.delete(pid);
    }
  }

  const empty = appsList.querySelector(".empty");
  if (appBundles.size === 0) {
    if (!empty) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "Brak aktywnych aplikacji audio…";
      appsList.appendChild(e);
    }
  } else if (empty) {
    empty.remove();
  }
}

// ====== UZYTKOWNICY DISCORDA ======
const userBundles = new Map(); // userId -> { row, slider, pctEl, dot }

function renderUsers(users) {
  const list = (users || []).slice().sort((a, b) => {
    if (!!a.speaking !== !!b.speaking) return a.speaking ? -1 : 1;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  const seen = new Set();

  for (const u of list) {
    seen.add(u.id);
    let bundle = userBundles.get(u.id);

    if (!bundle) {
      bundle = makeRow({
        icon: "",
        name: {
          text: u.name || "Użytkownik",
          className: "user-name",
        },
        percent: Math.round((typeof u.volume === "number" ? u.volume : 1) * 100),
        sliderClass: "users",
        onCommit: (v) => {
          window.electronMixer.setUserVolume(u.id, v);
        },
      });
      bundle.row.querySelector(".icon").classList.add("dot");
      usersList.appendChild(bundle.row);
      userBundles.set(u.id, bundle);
    } else if (document.activeElement !== bundle.slider) {
      syncRow(bundle, typeof u.volume === "number" ? u.volume : 1);
    }

    const dot = bundle.row.querySelector(".dot");
    if (dot) {
      dot.className =
        "icon dot" + (u.muted ? " muted" : u.speaking ? " speaking" : "");
      dot.title = u.muted ? "Wyciszony" : u.speaking ? "Mówi" : "Na kanale";
      dot.textContent = "";
    }

    const nameEl = bundle.row.querySelector(".user-name");
    if (nameEl && u.name && nameEl.textContent !== u.name) {
      nameEl.textContent = u.name;
    }
  }

  for (const [id, bundle] of Array.from(userBundles.entries())) {
    if (!seen.has(id)) {
      bundle.row.remove();
      userBundles.delete(id);
    }
  }

  const empty = usersList.querySelector(".empty");
  if (userBundles.size === 0) {
    if (!empty) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "Nie jesteś na kanale głosowym.";
      usersList.appendChild(e);
    }
  } else if (empty) {
    empty.remove();
  }
}

// ====== STEROWANIE ======
function setStatus(status) {
  // status moze byc boolem (starszy format) lub obiektem { ok, error }
  const ok =
    status && typeof status === "object" ? status.ok !== false : !!status;

  if (ok) {
    statusHint.classList.remove("visible");
    return;
  }

  let msg = null;
  if (status && typeof status === "object" && status.error) {
    msg = "⚠ " + status.error;
  } else if (status === false) {
    // stary format (bool) bez szczegolow
    msg =
      "⚠ Sterowanie głośnością aplikacji jest dostępne tylko na Windowsie (PowerShell + WASAPI).";
  }

  if (msg) {
    statusHint.textContent = msg;
    statusHint.classList.add("visible");
  } else {
    statusHint.classList.remove("visible");
  }
}

window.electronMixer.onApps(renderApps);
window.electronMixer.onUsers(renderUsers);
window.electronMixer.onStatus(setStatus);

// Panel diagnostyki
const debugLog = document.getElementById("debug-log");
const debugToggle = document.getElementById("debug-toggle");
const debugLines = [];

function addLog(line) {
  const text = String(line || "");
  debugLines.push(text);
  if (debugLines.length > 120) debugLines.shift();
  if (debugLog) {
    const esc = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const cls = /ERR|blad|error|nie wystartowal|fail/i.test(text)
      ? "err"
      : /OK|gotowy|READY|znaleziono/i.test(text)
      ? "ok"
      : "";
    const span = document.createElement("div");
    if (cls) span.className = cls;
    span.textContent = text;
    debugLog.appendChild(span);
    while (debugLog.childNodes.length > 120) {
      debugLog.removeChild(debugLog.firstChild);
    }
    debugLog.scrollTop = debugLog.scrollHeight;
  }
}

if (debugToggle) {
  debugToggle.addEventListener("click", () => {
    const hidden = debugLog.hasAttribute("hidden");
    if (hidden) {
      debugLog.removeAttribute("hidden");
      debugToggle.textContent = "▾ Diagnostyka";
    } else {
      debugLog.setAttribute("hidden", "");
      debugToggle.textContent = "▸ Diagnostyka";
    }
  });
}

if (window.electronMixer.onLog) {
  window.electronMixer.onLog(addLog);
} else {
  addLog("Brak kanalu logow (stary preload?).");
}

window.addEventListener("DOMContentLoaded", () => {
  window.electronMixer.getState();
});
