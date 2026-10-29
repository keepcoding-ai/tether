# Start Menu shortcut for tether (user scope only: %APPDATA%\Microsoft\Windows\Start Menu\Programs\tether.lnk).
# Driven by app/install.mjs. Actions:
#   install    create/overwrite the .lnk (target, args, working dir, icon, AppUserModelID)
#   uninstall  delete it (no error when absent)
#   read       print the .lnk fields as JSON (used to verify the install)
# WScript.Shell writes the ordinary fields; the AppUserModelID is a property-store value that only
# IShellLink/IPropertyStore can set, hence the small COM interop below (Windows PowerShell 5.1 or pwsh).
param(
  [Parameter(Mandatory)][ValidateSet('install', 'uninstall', 'read')][string]$Action,
  [string]$Target,
  [string]$Arguments,
  [string]$WorkingDirectory,
  [string]$Icon,
  [string]$Aumid,
  [string]$Description,
  [string]$Name = 'tether'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8 # accented messages survive the npm/console pipe

$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnk = Join-Path $programs "$Name.lnk"

$interop = @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace TetherShortcut {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PropertyKey { public Guid fmtid; public uint pid; public PropertyKey(Guid f, uint p) { fmtid = f; pid = p; } }

  [StructLayout(LayoutKind.Sequential)]
  public struct PropVariant {
    public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    void GetCount(out uint count);
    void GetAt(uint index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
  }

  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int cch, IntPtr fd, uint flags);
    void GetIDList(out IntPtr pidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
    void GetHotkey(out short hotkey);
    void SetHotkey(short hotkey);
    void GetShowCmd(out int showCmd);
    void SetShowCmd(int showCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int cch, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
    void Resolve(IntPtr hwnd, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
  }

  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  public class ShellLink { }

  public static class Aumid {
    static readonly PropertyKey Key = new PropertyKey(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);
    const ushort VT_LPWSTR = 31;
    const ushort VT_EMPTY = 0;

    public static void Set(string lnkPath, string id) {
      var link = (IShellLinkW)new ShellLink();
      ((IPersistFile)link).Load(lnkPath, 2 /* STGM_READWRITE */);
      var store = (IPropertyStore)link;
      var key = Key;
      var v = new PropVariant();
      v.vt = VT_LPWSTR;
      v.p = Marshal.StringToCoTaskMemUni(id);
      try { store.SetValue(ref key, ref v); store.Commit(); }
      finally { Marshal.FreeCoTaskMem(v.p); }
      ((IPersistFile)link).Save(lnkPath, true);
    }

    public static string Get(string lnkPath) {
      var link = (IShellLinkW)new ShellLink();
      ((IPersistFile)link).Load(lnkPath, 0 /* STGM_READ */);
      var store = (IPropertyStore)link;
      var key = Key;
      PropVariant v;
      store.GetValue(ref key, out v);
      if (v.vt == VT_EMPTY) return null;
      if (v.vt != VT_LPWSTR) return "<vt " + v.vt + ">";
      var s = Marshal.PtrToStringUni(v.p);
      Marshal.FreeCoTaskMem(v.p);
      return s;
    }
  }
}
'@

function Load-Interop {
  if (-not ('TetherShortcut.Aumid' -as [type])) { Add-Type -TypeDefinition $interop }
}

switch ($Action) {
  'install' {
    foreach ($p in 'Target', 'Arguments', 'WorkingDirectory', 'Icon', 'Aumid') {
      if (-not (Get-Variable $p -ValueOnly)) { throw "install: parâmetro -$p obrigatório" }
    }
    New-Item -ItemType Directory -Force $programs | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath = $Target
    $sc.Arguments = $Arguments
    $sc.WorkingDirectory = $WorkingDirectory
    $sc.IconLocation = "$Icon,0"
    $sc.Description = $Description
    $sc.WindowStyle = 1
    $sc.Save()
    Load-Interop
    [TetherShortcut.Aumid]::Set($lnk, $Aumid)
    Write-Output $lnk
  }
  'uninstall' {
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force; Write-Output "removido: $lnk" }
    else { Write-Output "já não existia: $lnk" }
  }
  'read' {
    if (-not (Test-Path -LiteralPath $lnk)) { Write-Output 'null'; exit 0 }
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lnk)
    Load-Interop
    [ordered]@{
      path = $lnk
      target = $sc.TargetPath
      arguments = $sc.Arguments
      workingDirectory = $sc.WorkingDirectory
      iconLocation = $sc.IconLocation
      description = $sc.Description
      aumid = [TetherShortcut.Aumid]::Get($lnk)
    } | ConvertTo-Json -Compress
  }
}
