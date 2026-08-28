# Pomocnik miksera: enumeruje sesje audio per-proces i ustawia ich glosnosc (WASAPI).
# Komendy ze stdin:
#   SET <pid> <0-100>   - ustaw glosnosc procesu
#   SELF <pid[,pid...]> - oznacz pid(y) jako wlasne procesy aplikacji
#   QUIT                - zakoncz
# Linia "READY" oznacza start; sesje wypisywane jako "APPS <json>".
# Linie "INFO ..." / "ERR ..." to diagnostyka.

$ErrorActionPreference = "Continue"

function Write-Line($text) {
  try {
    [Console]::Out.WriteLine($text)
    [Console]::Out.Flush()
  } catch {}
}

# ---- C# / WASAPI ----
$source = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace MixerAudio {

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  }

  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr id, int ctx, out IntPtr ctrl);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr id, int ctx, out IntPtr vol);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator enumr);
  }

  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int idx, out IAudioSessionControl session);
  }

  [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, Guid ctx);
    [PreserveSig] int GetGroupingParam(out Guid param);
    [PreserveSig] int SetGroupingParam(ref Guid param, Guid ctx);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
  }

  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, Guid ctx);
    [PreserveSig] int GetGroupingParam(out Guid param);
    [PreserveSig] int SetGroupingParam(ref Guid param, Guid ctx);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference(bool optOut);
  }

  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, Guid ctx);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute(bool mute, Guid ctx);
    [PreserveSig] int GetMute(out bool mute);
  }

  public delegate void SessionVisitor(uint pid, string procName, ISimpleAudioVolume vol);

  public static class Core {
    static string Esc(string s) {
      if (s == null) return "";
      StringBuilder sb = new StringBuilder();
      foreach (char c in s) {
        if (c == '\\' || c == '"') { sb.Append('\\'); sb.Append(c); }
        else if (c == '\n') sb.Append("\\n");
        else if (c == '\r') sb.Append("\\r");
        else if (c == '\t') sb.Append("\\t");
        else if (c < (char)0x20 || c > (char)0x7E) sb.Append("\\u").Append(((int)c).ToString("x4"));
        else sb.Append(c);
      }
      return sb.ToString();
    }

    static string ProcName(uint pid) {
      try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
      catch { return ""; }
    }

    static void VisitEndpoint(IMMDeviceEnumerator en, int role, SessionVisitor v) {
      IMMDevice dev = null;
      IAudioSessionManager2 mgr = null;
      IAudioSessionEnumerator senum = null;
      try {
        IMMDevice ep;
        if (en.GetDefaultAudioEndpoint(0, role, out ep) != 0 || ep == null) return;
        dev = ep;
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object mgrObj;
        if (ep.Activate(ref iid, 0x17, IntPtr.Zero, out mgrObj) != 0 || mgrObj == null) return;
        mgr = (IAudioSessionManager2)mgrObj;
        if (mgr.GetSessionEnumerator(out senum) != 0 || senum == null) return;
        int count = 0;
        senum.GetCount(out count);
        for (int i = 0; i < count; i++) {
          IAudioSessionControl sc = null;
          try {
            if (senum.GetSession(i, out sc) != 0 || sc == null) continue;
            IAudioSessionControl2 sc2;
            try { sc2 = (IAudioSessionControl2)sc; }
            catch { continue; }
            uint pid = 0;
            if (sc2.GetProcessId(out pid) != 0 || pid == 0) continue;
            if (sc2.IsSystemSoundsSession() == 0) continue;
            ISimpleAudioVolume vol = sc2 as ISimpleAudioVolume;
            if (vol == null) continue;
            v(pid, ProcName(pid), vol);
          } finally {
            if (sc != null) Marshal.ReleaseComObject(sc);
          }
        }
      } catch {
      } finally {
        if (senum != null) Marshal.ReleaseComObject(senum);
        if (mgr != null) Marshal.ReleaseComObject(mgr);
        if (dev != null) Marshal.ReleaseComObject(dev);
      }
    }

    static void VisitSessions(SessionVisitor v) {
      IMMDeviceEnumerator en = null;
      try {
        en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        VisitEndpoint(en, 1, v);
        VisitEndpoint(en, 2, v);
      } catch {
      } finally {
        if (en != null) Marshal.ReleaseComObject(en);
      }
    }

    public static string Poll(uint[] selfPids) {
      HashSet<uint> self = new HashSet<uint>();
      if (selfPids != null) {
        foreach (uint p in selfPids) self.Add(p);
      }
      StringBuilder sb = new StringBuilder();
      sb.Append("[");
      bool first = true;
      HashSet<uint> seen = new HashSet<uint>();
      try {
        VisitSessions(delegate(uint pid, string procName, ISimpleAudioVolume vol) {
          if (seen.Contains(pid)) return;
          seen.Add(pid);
          float level = 1f;
          bool muted = false;
          try { vol.GetMasterVolume(out level); } catch { }
          try { vol.GetMute(out muted); } catch { }
          if (!first) sb.Append(",");
          first = false;
          string name = procName ?? "";
          sb.Append("{\"pid\":").Append(pid.ToString(CultureInfo.InvariantCulture));
          sb.Append(",\"name\":\"").Append(Esc(name)).Append("\"");
          sb.Append(",\"vol\":").Append(level.ToString(CultureInfo.InvariantCulture));
          sb.Append(",\"muted\":").Append(muted ? "true" : "false");
          sb.Append(",\"self\":").Append(self.Contains(pid) ? "true" : "false");
          sb.Append("}");
        });
      } catch { }
      sb.Append("]");
      return sb.ToString();
    }

    public static string SetVolume(uint targetPid, float level) {
      Guid ctx = Guid.Empty;
      bool set = false;
      try {
        VisitSessions(delegate(uint pid, string procName, ISimpleAudioVolume vol) {
          if (pid == targetPid) {
            try { if (vol.SetMasterVolume(level, ctx) == 0) set = true; } catch { }
          }
        });
      } catch { }
      return set ? "ok" : "notfound";
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  Write-Line "INFO add-type OK (PS $($PSVersionTable.PSVersion))"
} catch {
  Write-Line ("ERR add-type: " + $_.Exception.Message)
  if ($_.Exception.InnerException) {
    Write-Line ("ERR add-type inner: " + $_.Exception.InnerException.Message)
  }
  foreach ($ie in $_.Exception.LoaderExceptions) {
    if ($ie) { Write-Line ("ERR loader: " + $ie.Message) }
  }
  exit 1
}

# Wspoldzielony stan. UWAGA: skrypt dla runspace przekazany jako STRING
# (scriptblock jest przywiazany do runspace, w ktorym powstal).
$shared = [hashtable]::Synchronized(@{
  selfPids = @()
  quit     = $false
})

$workerScript = @'
while (-not $shared.quit) {
  $line = $null
  try { $line = [Console]::In.ReadLine() } catch { break }
  if ($null -eq $line) {
    Start-Sleep -Milliseconds 150
    continue
  }
  $line = $line.Trim()
  if ($line -eq "") { continue }
  $parts = $line.Split(" ")
  if ($parts[0] -eq "QUIT") {
    $shared.quit = $true
    break
  } elseif ($parts[0] -eq "SELF" -and $parts.Length -ge 2) {
    $ids = @()
    foreach ($raw in $parts[1].Split(",")) {
      $v = [uint32]0
      if ([uint32]::TryParse($raw.Trim(), [ref]$v)) { $ids += $v }
    }
    $shared.selfPids = $ids
  } elseif ($parts[0] -eq "SET" -and $parts.Length -ge 3) {
    $pidVal = [uint32]0
    $pct = 0
    if ([uint32]::TryParse($parts[1], [ref]$pidVal) -and [int]::TryParse($parts[2], [ref]$pct)) {
      if ($pct -lt 0) { $pct = 0 }
      if ($pct -gt 100) { $pct = 100 }
      try {
        $r = [MixerAudio.Core]::SetVolume($pidVal, [single]($pct / 100.0))
        if ($r -ne "ok") { [Console]::Out.WriteLine("ERR set: nie znaleziono pid " + $pidVal) }
      } catch {
        [Console]::Out.WriteLine("ERR set: " + $_.Exception.Message)
      }
    }
  }
}
'@

$rs = $null
$ps = $null
try {
  $iss = [System.Management.Automation.Runspaces.InitialSessionState]::CreateDefault()
  $iss.Variables.Add((New-Object System.Management.Automation.Runspaces.SessionStateVariableEntry("shared", $shared, "")))

  $rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace($iss)
  $rs.ApartmentState = "MTA"
  $rs.Open()

  $ps = [System.Management.Automation.PowerShell]::Create()
  $ps.Runspace = $rs
  [void]$ps.AddScript($workerScript)
  $async = $ps.BeginInvoke()
  Write-Line "INFO runspace czytajacy stdin wystartowal"
} catch {
  Write-Line ("ERR runspace: " + $_.Exception.Message)
  exit 1
}

Write-Line "READY"

$pollFailures = 0
while (-not $shared.quit -and -not $async.IsCompleted) {
  try {
    $json = [MixerAudio.Core]::Poll([uint32[]]$shared.selfPids)
    Write-Line ("APPS " + $json)
    $pollFailures = 0
  } catch {
    $pollFailures++
    Write-Line ("ERR poll: " + $_.Exception.Message)
    if ($pollFailures -ge 5) { break }
  }
  Start-Sleep -Milliseconds 750
}

# Bledy wykonania w runspace roboczym
if ($ps -and $ps.Streams.Error.Count -gt 0) {
  foreach ($e in $ps.Streams.Error) {
    Write-Line ("ERR worker: " + $e.ToString())
  }
}

try { if ($ps) { $ps.Stop(); $ps.Dispose() } } catch {}
try { if ($rs) { $rs.Close() } } catch {}
