// Sterowanie glosnoscia per-aplikacja (Windows WASAPI).
// Uruchamia pomocnika PowerShell (mixer/audio-helper.ps1), ktory co ~750ms
// wypisuje liste sesji audio, a przez stdin przyjmuje komendy "SET <pid> <percent>".

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

let electronApp = null;
try {
  electronApp = require("electron").app;
} catch (e) {
  electronApp = null;
}

class AudioControl {
  constructor() {
    this.sessions = [];
    this.available = null; // null = jeszcze nie wiadomo, true/false
    this.lastError = null;
    this._listeners = new Set();
    this._statusListeners = new Set();
    this._logListeners = new Set();
    this._proc = null;
    this._stopped = false;
    this._restarts = 0;
    this._lastJSON = "";
    this._stderrTail = "";
    this._start();

    // Rejestracja PID-ow aplikacji (glowny + renderery) co 10s
    this._pidTimer = setInterval(() => this._registerSelfPids(), 10000);
    this._registerSelfPids();
  }

  _logFile() {
    try {
      const dir = electronApp
        ? path.join(electronApp.getPath("userData"), "logs")
        : __dirname;
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {}
      return path.join(dir, "mixer-audio.log");
    } catch (e) {
      return null;
    }
  }

  _log(msg) {
    const text = String(msg && msg.stack ? msg.stack : msg);
    const line = "[" + new Date().toISOString() + "] " + text + "\n";
    try {
      const f = this._logFile();
      if (f) fs.appendFileSync(f, line);
    } catch (e) {}
    for (const fn of this._logListeners) {
      try {
        fn(text);
      } catch (e) {}
    }
  }

  onLog(fn) {
    this._logListeners.add(fn);
    return () => this._logListeners.delete(fn);
  }

  _selfPids() {
    const pids = new Set();
    pids.add(process.pid);
    try {
      if (electronApp && typeof electronApp.getAppMetrics === "function") {
        for (const m of electronApp.getAppMetrics()) {
          if (m && m.pid) pids.add(m.pid);
        }
      }
    } catch (e) {}
    return Array.from(pids);
  }

  _registerSelfPids() {
    const pids = this._selfPids();
    if (pids.length) this._write("SELF " + pids.join(","));
  }

  _start() {
    if (process.platform !== "win32") {
      // Poza Windowsem sterowanie per-aplikacja nie jest dostepne;
      // to nie jest blad, wiec nie pokazujemy komunikatu.
      this.available = false;
      this.lastError = null;
      this._emitStatus();
      return;
    }

    const scriptPath = path.join(__dirname, "mixer", "audio-helper.ps1");
    this._log("Uruchamiam pomocnika: " + scriptPath);

    let proc;
    try {
      proc = spawn(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-WindowStyle",
          "Hidden",
          "-File",
          scriptPath,
        ],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
    } catch (e) {
      this._log("Blad spawn powershell: " + (e && e.message));
      this._setStatus(false, "Nie mozna uruchomic PowerShell: " + e.message);
      return;
    }

    this._proc = proc;
    this._stderrTail = "";
    const startLogs = [];
    let gotReady = false;

    proc.on("error", (err) => {
      this._log("Blad procesu pomocnika: " + (err && err.message));
      this._setStatus(false, "Blad uruchomienia pomocnika: " + err.message);
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this._stderrTail = (this._stderrTail + text).slice(-2000);
      const trimmed = text.trim();
      if (trimmed) this._log("[stderr] " + trimmed);
    });

    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        if (line === "READY") {
          gotReady = true;
          this._restarts = 0;
          this._log("Pomocnik gotowy");
          this._setStatus(true, null);
          this._registerSelfPids();
        } else if (line.startsWith("APPS ")) {
          this._handleApps(line.slice(5));
        } else if (line.startsWith("ERR")) {
          const msg = line.slice(3).trim();
          this._log("[helper] " + msg);
          if (!gotReady) startLogs.push("ERR: " + msg);
          else this.lastError = msg;
        } else if (line.startsWith("INFO")) {
          const msg = line.slice(4).trim();
          this._log("[helper] " + msg);
          if (!gotReady) startLogs.push(msg);
        } else {
          this._log("[helper] " + line);
        }
      }
    });

    proc.on("exit", (code) => {
      this._log("Pomocnik zakonczyl dzialanie (kod " + code + ")");
      if (this._stopped) return;

      if (!gotReady) {
        let detail = startLogs.join(" | ");
        const errTail = this._stderrTail.trim();
        if (errTail && !detail) detail = errTail.slice(-400);
        const msg =
          "Pomocnik audio nie wystartowal (kod " +
          code +
          ")" +
          (detail ? ": " + detail.slice(0, 300) : "");
        this._setStatus(false, msg);
      }

      // Restart z narastajacym opoznieniem (max 30s)
      const delay = Math.min(30000, 1000 * Math.pow(2, this._restarts));
      this._restarts += 1;
      this._log("Restart pomocnika za " + delay + " ms");
      setTimeout(() => {
        if (!this._stopped) this._start();
      }, delay);
    });
  }

  _setStatus(ok, error) {
    if (ok) this.lastError = error || null;
    else this.lastError = error || this.lastError || "unknown";

    if (this.available === ok) return;
    this.available = ok;
    this._emitStatus();
  }

  _emitStatus() {
    const payload = { ok: !!this.available, error: this.lastError };
    for (const fn of this._statusListeners) {
      try {
        fn(payload);
      } catch (e) {}
    }
  }

  _handleApps(json) {
    let apps;
    try {
      apps = JSON.parse(json);
    } catch (e) {
      this._log("Blad parsowania JSON: " + json.slice(0, 200));
      return;
    }

    this.sessions = apps
      .filter((a) => a && typeof a.pid === "number")
      .map((a) => ({
        pid: a.pid,
        name: String(a.name || ""),
        volume:
          typeof a.vol === "number" && isFinite(a.vol)
            ? Math.max(0, Math.min(1, a.vol))
            : 1,
        muted: !!a.muted,
        self: !!a.self,
      }));

    const serialized = JSON.stringify(this.sessions);
    if (serialized === this._lastJSON) return;
    this._lastJSON = serialized;

    for (const fn of this._listeners) {
      try {
        fn(this.sessions);
      } catch (e) {}
    }
  }

  _write(cmd) {
    try {
      if (this._proc && this._proc.stdin && !this._proc.stdin.destroyed) {
        this._proc.stdin.write(cmd + "\n");
      }
    } catch (e) {}
  }

  setVolume(pid, percent) {
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    this._write(`SET ${pid} ${p}`);

    // Optymistyczna aktualizacja UI (kolejny poll to potwierdzi)
    const s = this.sessions.find((x) => x.pid === pid);
    if (s) {
      s.volume = p / 100;
      this._lastJSON = "";
      for (const fn of this._listeners) {
        try {
          fn(this.sessions);
        } catch (e) {}
      }
    }
  }

  onUpdate(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  onStatus(fn) {
    this._statusListeners.add(fn);
    // od razu wyslij biezacy stan
    try {
      fn({ ok: !!this.available, error: this.lastError });
    } catch (e) {}
    return () => this._statusListeners.delete(fn);
  }

  getStatus() {
    return { ok: !!this.available, error: this.lastError };
  }

  stop() {
    this._stopped = true;
    try {
      clearInterval(this._pidTimer);
    } catch (e) {}
    if (this._proc) {
      try {
        this._write("QUIT");
      } catch (e) {}
      try {
        this._proc.kill();
      } catch (e) {}
    }
  }
}

module.exports = { AudioControl };
