/**
 * Windows UI Automation (the accessibility API screen readers use), served by one long-lived
 * PowerShell host so assemblies stay loaded and each call costs milliseconds, not seconds.
 *
 * Gives exact names, roles and on-screen boxes of buttons, fields, links, menu items, tabs…
 * in native apps and in browser chrome — far more precise than guessing pixels from a screenshot.
 */
import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Native UI Automation via COM, compiled once inside the host. Sees far more than the legacy
// managed System.Windows.Automation (e.g. every taskbar app button, tray icons, modern controls).
const ENGINE = String.raw`using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace NUia {
  [ComImport, Guid("352ffba8-0973-437c-a61f-f64cafd81df9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationCondition { }

  [ComImport, Guid("b32a92b5-bc25-4078-9c08-d7ee95c48e03"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationCacheRequest {
    void AddProperty(int id);
    void _AddPattern(); void _Clone(); void _GetTreeScope();
    void put_TreeScope(int scope);
  }

  [ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationElementArray {
    int get_Length();
    IUIAutomationElement GetElement(int i);
  }

  [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomationElement {
    void SetFocus();
    void _GetRuntimeId(); void _FindFirst(); void _FindAll(); void _FindFirstBuildCache();
    IUIAutomationElementArray FindAllBuildCache(int scope, IUIAutomationCondition cond, IUIAutomationCacheRequest cr);
    void _BuildUpdatedCache();
    [return: MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValue(int id);
    void _GetCurrentPropertyValueEx();
    [return: MarshalAs(UnmanagedType.Struct)] object GetCachedPropertyValue(int id);
    void _GetCachedPropertyValueEx(); void _GetCurrentPatternAs(); void _GetCachedPatternAs();
    [return: MarshalAs(UnmanagedType.IUnknown)] object GetCurrentPattern(int id);
  }

  [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IUIAutomation {
    void _CompareElements(); void _CompareRuntimeIds(); void _GetRootElement();
    IUIAutomationElement ElementFromHandle(IntPtr hwnd);
    void _ElementFromPoint(); void _GetFocusedElement(); void _GetRootElementBuildCache(); void _ElementFromHandleBuildCache();
    void _ElementFromPointBuildCache(); void _GetFocusedElementBuildCache(); void _CreateTreeWalker();
    void _ControlViewWalker(); void _ContentViewWalker(); void _RawViewWalker(); void _RawViewCondition();
    IUIAutomationCondition get_ControlViewCondition();
    void _ContentViewCondition();
    IUIAutomationCacheRequest CreateCacheRequest();
  }

  [ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IInvoke { void Invoke(); }
  [ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IValue { void SetValue([MarshalAs(UnmanagedType.BStr)] string v); [return: MarshalAs(UnmanagedType.BStr)] string get_CurrentValue(); int get_CurrentIsReadOnly(); }
  [ComImport, Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IToggle { void Toggle(); }
  [ComImport, Guid("a8efa66a-0fda-421a-9194-38021f3578ea"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ISelectionItem { void Select(); }
  [ComImport, Guid("619be086-1f4e-4ee4-bafa-210128738730"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IExpandCollapse { void Expand(); }

  /// Native UI Automation (COM) — sees far more than the legacy managed System.Windows.Automation.
  public static class Engine {
    const int P_RECT = 30001, P_TYPE = 30003, P_NAME = 30005, P_FOCUS = 30008, P_ENABLED = 30010, P_OFF = 30022;
    static IUIAutomation A;
    static List<IUIAutomationElement> Last = new List<IUIAutomationElement>();
    static readonly Dictionary<int, string> Types = new Dictionary<int, string> {
      {50000,"Button"},{50002,"CheckBox"},{50003,"ComboBox"},{50004,"Edit"},{50005,"Hyperlink"},{50006,"Image"},{50007,"ListItem"},
      {50010,"MenuBar"},{50011,"MenuItem"},{50013,"RadioButton"},{50015,"Slider"},{50016,"Spinner"},{50019,"TabItem"},{50020,"Text"},
      {50024,"TreeItem"},{50029,"DataItem"},{50030,"Document"},{50031,"SplitButton"},{50033,"Pane"},{50035,"HeaderItem"}
    };

    static IUIAutomation Get() {
      if (A == null) A = (IUIAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e")));
      return A;
    }

    static void Esc(StringBuilder sb, string s) {
      sb.Append('"');
      foreach (char c in s ?? "") {
        if (c == '"' || c == '\\') { sb.Append('\\').Append(c); }
        else if (c < 32) { sb.Append(' '); }
        else sb.Append(c);
      }
      sb.Append('"');
    }

    static double[] Rect(object v) { var r = v as double[]; return r != null && r.Length == 4 ? r : new double[4]; }

    public static string Scan(long hwnd, int max, bool text) {
      var a = Get();
      var root = a.ElementFromHandle(new IntPtr(hwnd));
      var cr = a.CreateCacheRequest();
      foreach (var p in new[] { P_RECT, P_TYPE, P_NAME, P_FOCUS, P_ENABLED, P_OFF }) cr.AddProperty(p);
      cr.put_TreeScope(1);
      var arr = root.FindAllBuildCache(4, a.get_ControlViewCondition(), cr);
      var rootRect = Rect(root.GetCurrentPropertyValue(P_RECT));
      double rootArea = Math.Max(1, rootRect[2] * rootRect[3]);
      Last = new List<IUIAutomationElement>();
      var sb = new StringBuilder("{\"items\":[");
      int n = arr == null ? 0 : arr.get_Length(), count = 0;
      for (int k = 0; k < n && count < max; k++) {
        var e = arr.GetElement(k);
        string type;
        if (!Types.TryGetValue(Convert.ToInt32(e.GetCachedPropertyValue(P_TYPE)), out type)) continue;
        if (Convert.ToBoolean(e.GetCachedPropertyValue(P_OFF))) continue;
        var r = Rect(e.GetCachedPropertyValue(P_RECT));
        if (r[2] < 3 || r[3] < 3) continue;
        string name = (Convert.ToString(e.GetCachedPropertyValue(P_NAME)) ?? "").Replace('\n', ' ').Replace('\r', ' ').Trim();
        if (name.Length > 80) name = name.Substring(0, 80);
        if ((type == "Text" || type == "Image") && (!text || name.Length == 0)) continue;
        // Panes are containers; keep only small named ones (e.g. Windows 10 taskbar items).
        if (type == "Pane" && (name.Length == 0 || r[2] * r[3] > rootArea / 6)) continue;
        Last.Add(e);
        if (count++ > 0) sb.Append(',');
        sb.Append("{\"i\":").Append(Last.Count - 1).Append(",\"t\":\"").Append(type).Append("\",\"n\":");
        Esc(sb, name);
        sb.Append(",\"x\":").Append((int)r[0]).Append(",\"y\":").Append((int)r[1]).Append(",\"w\":").Append((int)r[2]).Append(",\"h\":").Append((int)r[3]);
        sb.Append(",\"en\":").Append(Convert.ToBoolean(e.GetCachedPropertyValue(P_ENABLED)) ? "true" : "false");
        sb.Append(",\"f\":").Append(Convert.ToBoolean(e.GetCachedPropertyValue(P_FOCUS)) ? "true" : "false").Append('}');
      }
      return sb.Append("],\"total\":").Append(n).Append('}').ToString();
    }

    public static string Act(int i, string action, string text) {
      if (i < 0 || i >= Last.Count) throw new Exception("Element " + i + " not found - scan again");
      var e = Last[i];
      switch (action) {
        case "rect": {
          var r = Rect(e.GetCurrentPropertyValue(P_RECT));
          return "{\"x\":" + (int)r[0] + ",\"y\":" + (int)r[1] + ",\"w\":" + (int)r[2] + ",\"h\":" + (int)r[3] + ",\"off\":" + (Convert.ToBoolean(e.GetCurrentPropertyValue(P_OFF)) ? "true" : "false") + "}";
        }
        case "focus": e.SetFocus(); return "{\"done\":true}";
        case "set_text": {
          var v = e.GetCurrentPattern(10002) as IValue;
          if (v == null || v.get_CurrentIsReadOnly() != 0) return "{\"done\":false}";
          try { e.SetFocus(); } catch {}
          v.SetValue(text);
          return "{\"done\":true,\"via\":\"ValuePattern\"}";
        }
        case "invoke": {
          var inv = e.GetCurrentPattern(10000) as IInvoke; if (inv != null) { inv.Invoke(); return "{\"done\":true,\"via\":\"Invoke\"}"; }
          var tg = e.GetCurrentPattern(10015) as IToggle; if (tg != null) { tg.Toggle(); return "{\"done\":true,\"via\":\"Toggle\"}"; }
          var si = e.GetCurrentPattern(10010) as ISelectionItem; if (si != null) { si.Select(); return "{\"done\":true,\"via\":\"Select\"}"; }
          var ec = e.GetCurrentPattern(10005) as IExpandCollapse; if (ec != null) { ec.Expand(); return "{\"done\":true,\"via\":\"Expand\"}"; }
          return "{\"done\":false}";
        }
      }
      throw new Exception("Unknown action " + action);
    }
  }
}
`;

const HOST = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8
Add-Type -Path $args[0]
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $cmd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    $r = Invoke-Expression $cmd
    [Console]::Out.WriteLine('@@{"ok":true,"data":' + $r + '}')
  } catch {
    $ex = $_.Exception
    while ($ex.InnerException) { $ex = $ex.InnerException }
    [Console]::Out.WriteLine('@@' + (ConvertTo-Json -InputObject @{ ok = $false; error = $ex.Message } -Compress))
  }
  [Console]::Out.Flush()
}
`;

export interface UiaElement {
  i: number; // index inside the host's last scan
  t: string; // control type
  n: string; // accessible name
  x: number; y: number; w: number; h: number; // physical screen pixels
  en: boolean;
  f: boolean;
}

class UiaHost {
  private proc?: ChildProcessWithoutNullStreams;
  private buf = '';
  private waiters: { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  private start() {
    if (this.proc && this.proc.exitCode === null) return;
    const dir = app.getPath('userData');
    const file = path.join(dir, 'uia-host.ps1');
    const engine = path.join(dir, 'uia-engine.cs');
    fs.writeFileSync(file, '﻿' + HOST, 'utf8');
    fs.writeFileSync(engine, ENGINE, 'utf8');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, engine], {
      windowsHide: true,
    });
    this.buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line.startsWith('@@')) continue;
        const w = this.waiters.shift();
        if (!w) continue;
        clearTimeout(w.timer);
        try {
          const msg = JSON.parse(line.slice(2));
          msg.ok ? w.resolve(msg.data) : w.reject(new Error(msg.error));
        } catch (e: any) {
          w.reject(e);
        }
      }
    });
    this.proc.on('exit', () => {
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error('UI Automation host exited'));
      }
    });
  }

  /** Commands run strictly one at a time (the host is single-threaded). */
  call<T = any>(ps: string, timeoutMs = 15000): Promise<T> {
    const run = () =>
      new Promise<T>((resolve, reject) => {
        this.start();
        const timer = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w.timer !== timer);
          this.proc?.kill(); // a hung UIA call (frozen app) — restart fresh next time
          reject(new Error('UI Automation timed out (the app may be busy or frozen)'));
        }, timeoutMs);
        this.waiters.push({ resolve, reject, timer });
        this.proc!.stdin.write(Buffer.from(ps, 'utf8').toString('base64') + '\n');
      });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  warm() {
    if (process.platform === 'win32') this.call('1', 30000).catch(() => {});
  }

  stop() {
    this.proc?.kill();
  }
}

export const uia = new UiaHost();

export async function scanWindow(hwnd: number, max = 200, includeText = false): Promise<UiaElement[]> {
  const r = await uia.call<{ items: UiaElement[] }>(`[NUia.Engine]::Scan(${hwnd}, ${max}, ${includeText ? '$true' : '$false'})`);
  return r?.items ?? [];
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function actOn(i: number, action: 'set_text' | 'invoke' | 'focus' | 'rect', text = '') {
  return uia.call<any>(`[NUia.Engine]::Act(${i}, ${q(action)}, ${q(text)})`);
}
