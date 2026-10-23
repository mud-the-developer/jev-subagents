import childProcess, { type ChildProcess } from "node:child_process";
import path from "node:path";

/** Effect-only Windows ownership. Job closure kills descendants even after the leader exits. */
export interface WindowsJob { close(): Promise<boolean> }

// Static code only: process identifiers arrive as JSON data, never interpolated PowerShell.
const guardianScript = String.raw`
$ErrorActionPreference = 'Stop'
$job = [IntPtr]::Zero
try {
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class JevJob {
  [StructLayout(LayoutKind.Sequential)] public struct Limits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] public struct Extended {
    public Limits Basic; public Io Counters; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Accounting {
    public long A, B, C, D; public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ProcessInfo {
    public IntPtr Reserved, Peb, Reserved2, Reserved3; public UIntPtr Id, Parent;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended data, int length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting data, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, out ProcessInfo info, int length, IntPtr returned);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Own(int pid, int parent, long earliest) {
    IntPtr process = OpenProcess(0x0100 | 0x0200 | 0x0400 | 0x0001, false, pid);
    if (process == IntPtr.Zero) throw new InvalidOperationException();
    IntPtr job = IntPtr.Zero;
    try {
      ProcessInfo info;
      if (NtQueryInformationProcess(process, 0, out info, Marshal.SizeOf(typeof(ProcessInfo)), IntPtr.Zero) != 0 || info.Parent.ToUInt64() != (ulong)parent)
        throw new InvalidOperationException();
      using (Process child = Process.GetProcessById(pid)) {
        long born = (child.StartTime.ToUniversalTime().Ticks - 621355968000000000L) / 10000L;
        if (born < earliest - 2000L || born > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 1000L) throw new InvalidOperationException();
      }
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new InvalidOperationException();
      Extended limits = new Extended(); limits.Basic.Flags = 0x00002000; // KILL_ON_JOB_CLOSE; no breakaway permission.
      if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Extended))) || !AssignProcessToJobObject(job, process))
        throw new InvalidOperationException();
      return job;
    } catch { if (job != IntPtr.Zero) CloseHandle(job); throw; }
    finally { CloseHandle(process); }
  }
  public static bool Stop(IntPtr job) {
    if (!TerminateJobObject(job, 1)) return false;
    for (int attempt = 0; attempt < 100; attempt++) {
      Accounting counts;
      if (!QueryInformationJobObject(job, 1, out counts, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) return false;
      if (counts.Active == 0) return true;
      System.Threading.Thread.Sleep(20);
    }
    return false;
  }
}
'@
  $inputData = [Console]::In.ReadLine() | ConvertFrom-Json
  if ($inputData.pid -le 1 -or $inputData.parent -le 1) { throw 'invalid' }
  $job = [JevJob]::Own([int]$inputData.pid, [int]$inputData.parent, [long]$inputData.earliest)
  [Console]::Out.WriteLine('{"type":"ready"}')
  [Console]::Out.Flush()
  $null = [Console]::In.ReadLine()
  $confirmed = [JevJob]::Stop($job)
  if ($confirmed) { [Console]::Out.WriteLine('{"type":"closed","confirmed":true}') }
  else { [Console]::Out.WriteLine('{"type":"closed","confirmed":false}') }
  [Console]::Out.Flush()
} catch { [Console]::Out.WriteLine('{"type":"failed"}'); [Console]::Out.Flush(); exit 1 }
finally { if ($job -ne [IntPtr]::Zero) { [void][JevJob]::CloseHandle($job) } }
`;

/** The child MUST wait for IPC before doing approved work. Never attach to an executing arbitrary command. */
export async function ownWindowsProcess(child: ChildProcess, earliest: number): Promise<WindowsJob> {
  if (process.platform !== "win32" || !child.pid || child.exitCode !== null || child.signalCode !== null ||
    typeof child.once !== "function" || typeof child.removeListener !== "function" || !Number.isSafeInteger(earliest) || earliest <= 0)
    throw new Error("Windows process ownership unavailable.");
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !path.win32.isAbsolute(root)) throw new Error("Windows process ownership unavailable.");
  const helper = childProcess.spawn(path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(guardianScript, "utf16le").toString("base64")],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "ignore"], env: { SystemRoot: root, TEMP: process.env.TEMP ?? root, TMP: process.env.TMP ?? root } });
  return new Promise((resolve, reject) => {
    let ready = false, ended = false, confirmed = false, buffer = "";
    let closePromise: Promise<boolean> | undefined, settleClose: ((value: boolean) => void) | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (ended) return;
      ended = true;
      clearTimeout(startTimer); clearTimeout(closeTimer);
      child.removeListener("exit", onEarlyExit);
      if (!ready) reject(new Error("Windows process ownership unavailable."));
      settleClose?.(confirmed);
    };
    const job: WindowsJob = { close() {
      if (closePromise) return closePromise;
      if (ended) return Promise.resolve(false);
      closePromise = new Promise<boolean>((done) => { settleClose = done; });
      helper.stdin!.end("close\n");
      closeTimer = setTimeout(() => { helper.kill(); finish(); }, 5_000);
      return closePromise;
    } };
    const onEarlyExit = () => { if (!ready) { helper.kill(); finish(); } };
    const startTimer = setTimeout(() => { helper.kill(); finish(); }, 10_000);
    child.once("exit", onEarlyExit);
    helper.once("error", finish); helper.once("close", finish);
    helper.stdin!.on("error", () => { helper.kill(); finish(); });
    helper.stdout!.setEncoding("utf8");
    helper.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024) { helper.kill(); finish(); return; }
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline < 0) break;
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (line === '{"type":"ready"}' && !ready && !ended) {
          ready = true; clearTimeout(startTimer); child.removeListener("exit", onEarlyExit); resolve(job);
        }
        else if (line === '{"type":"closed","confirmed":true}' && ready) confirmed = true;
        else if (line === '{"type":"closed","confirmed":false}' && ready) confirmed = false;
        else { helper.kill(); finish(); return; }
      }
    });
    helper.stdin!.write(JSON.stringify({ pid: child.pid, parent: process.pid, earliest }) + "\n");
  });
}
