import cp from "node:child_process";
import path from "node:path";
import { ownWindowsProcess } from "./windows-job.ts";

// Effect-only native profile boundary. No credentials, prompts or paths are inserted into code.
const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class JevProfiles {
  [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Size; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, ref Attributes attributes, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder text, uint length, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  static SecurityIdentifier User() {
    WindowsIdentity actor = WindowsIdentity.GetCurrent();
    if (new WindowsPrincipal(actor).IsInRole(WindowsBuiltInRole.Administrator) || actor.User == null) throw new InvalidOperationException();
    return actor.User;
  }
  public static void Actor() { User(); }
  static bool Trusted(string sid, string user) { return sid == user || sid == "S-1-5-18" || sid == "S-1-5-32-544"; }
  static void Access(FileSystemSecurity security, bool privateFile) {
    // A missing/null DACL grants everyone access; enumerating zero rules is not privacy.
    RawSecurityDescriptor raw = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
    if ((raw.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 || raw.DiscretionaryAcl == null) throw new InvalidOperationException();
    foreach (GenericAce ace in raw.DiscretionaryAcl)
      if (!(ace is CommonAce) || ((CommonAce)ace).IsCallback) throw new InvalidOperationException();
    string user = User().Value;
    if (((SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier))).Value != user) throw new InvalidOperationException();
    const FileSystemRights write = FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
    foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      if (rule.AccessControlType != AccessControlType.Allow || (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
      if (!Trusted(((SecurityIdentifier)rule.IdentityReference).Value, user) && (privateFile || (rule.FileSystemRights & write) != 0)) throw new InvalidOperationException();
    }
  }
  static string Local(string name) {
    string full = Path.GetFullPath(name);
    if (full.Length < 3 || full[1] != ':' || full[2] != '\\') throw new InvalidOperationException();
    DriveInfo drive = new DriveInfo(Path.GetPathRoot(full));
    if (drive.DriveType != DriveType.Fixed || drive.DriveFormat != "NTFS") throw new InvalidOperationException();
    return full;
  }
  static void NoReparse(string full) {
    for (string current = full; current != null; current = Path.GetDirectoryName(current)) {
      if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException();
      if (current == Path.GetPathRoot(current)) break;
    }
  }
  static DirectorySecurity DirectoryAcl() {
    DirectorySecurity acl = new DirectorySecurity(); acl.SetOwner(User()); acl.SetAccessRuleProtection(true, false);
    foreach (string sid in new string[] { User().Value, "S-1-5-18", "S-1-5-32-544" })
      acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    return acl;
  }
  static FileSecurity FileAcl() {
    FileSecurity acl = new FileSecurity(); acl.SetOwner(User()); acl.SetAccessRuleProtection(true, false);
    foreach (string sid in new string[] { User().Value, "S-1-5-18", "S-1-5-32-544" })
      acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, AccessControlType.Allow));
    return acl;
  }
  static void Parent(string directory) {
    if (!Directory.Exists(directory)) {
      string parent = Path.GetDirectoryName(directory);
      if (!Directory.Exists(parent)) Parent(parent);
      NoReparse(parent);
      Directory.CreateDirectory(directory, DirectoryAcl());
    }
    NoReparse(directory); Access(new DirectoryInfo(directory).GetAccessControl(), false);
  }
  static void Bound(SafeFileHandle handle, string expected) {
    StringBuilder text = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandle(handle, text, (uint)text.Capacity, 0);
    Info info;
    if (length == 0 || length >= text.Capacity || !GetFileInformationByHandle(handle, out info) || info.Links != 1 || (info.Attributes & 0x400) != 0) throw new InvalidOperationException();
    string actual = text.ToString(); if (actual.StartsWith(@"\\?\")) actual = actual.Substring(4);
    if (!String.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
  }
  public static void Create(string name, string content) {
    string full = Local(name); string directory = Path.GetDirectoryName(full);
    byte[] bytes = new UTF8Encoding(false, true).GetBytes(content);
    if (bytes.Length > 32768) throw new InvalidOperationException();
    Parent(directory);
    byte[] descriptor = FileAcl().GetSecurityDescriptorBinaryForm(); IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
    try {
      Marshal.Copy(descriptor, 0, memory, descriptor.Length);
      Attributes attributes = new Attributes(); attributes.Size = Marshal.SizeOf(typeof(Attributes)); attributes.Descriptor = memory;
      // Private DACL at atomic CREATE_NEW; no existing file/link is opened or overwritten.
      using (SafeFileHandle handle = CreateFile(full, 0xC0000000, 0, ref attributes, 1, 0x00200000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new InvalidOperationException();
        using (FileStream stream = new FileStream(handle, FileAccess.ReadWrite)) {
          Bound(handle, full); NoReparse(directory); Access(stream.GetAccessControl(), true);
          stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
          Bound(handle, full); NoReparse(directory); Access(stream.GetAccessControl(), true);
        }
      }
    } finally { Marshal.FreeHGlobal(memory); }
  }
  public static bool Private(string name) {
    try {
      string full = Local(name); NoReparse(full);
      using (FileStream stream = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        Bound(stream.SafeFileHandle, full); Access(stream.GetAccessControl(), true); return true;
      }
    } catch { return false; }
  }
}
'@
$data = [Console]::In.ReadLine() | ConvertFrom-Json
[JevProfiles]::Actor()
if ($data.operation -eq 'create') {
  if ($data.profiles.Count -gt 4) { throw 'invalid' }
  foreach ($profile in $data.profiles) { [JevProfiles]::Create([string]$profile.file, [string]$profile.content) }
  [Console]::Out.WriteLine('{"ok":true}')
} elseif ($data.operation -eq 'inspect') {
  if ([JevProfiles]::Private([string]$data.file)) { [Console]::Out.WriteLine('{"ok":true,"private":true}') }
  else { [Console]::Out.WriteLine('{"ok":true,"private":false}') }
} elseif ($data.operation -eq 'actor') { [Console]::Out.WriteLine('{"ok":true}') }
else { throw 'invalid' }
[Console]::Out.Flush()
} catch { [Console]::Out.WriteLine('{"ok":false}'); [Console]::Out.Flush(); exit 1 }
`;

type Operation = { operation: "actor" } | { operation: "inspect"; file: string }
  | { operation: "create"; profiles: readonly { readonly file: string; readonly content: string }[] };
async function invoke(operation: Operation, signal?: AbortSignal): Promise<string> {
  if (process.platform !== "win32") throw new Error("Windows profile boundary unavailable.");
  signal?.throwIfAborted();
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !path.isAbsolute(root)) throw new Error("Windows profile boundary unavailable.");
  const payload = JSON.stringify(operation) + "\n"; // Freeze approval data before any asynchronous ownership wait.
  const started = Date.now();
  const child = cp.spawn(path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: { SystemRoot: root, TEMP: process.env.TEMP ?? root, TMP: process.env.TMP ?? root } });
  return new Promise<string>((resolve, reject) => {
    let output = "", stopped = false;
    const ownership = ownWindowsProcess(child, started);
    const stop = () => { stopped = true; child.kill("SIGKILL"); };
    const timer = setTimeout(stop, 20_000);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => { output += text; if (output.length > 1024) stop(); });
    child.stdin.on("error", stop); child.once("error", stop);
    void ownership.then(async job => {
      if (stopped || signal?.aborted) { await job.close(); return; }
      child.stdin.end(payload);
    }, stop);
    child.once("close", async code => {
      clearTimeout(timer); signal?.removeEventListener("abort", stop);
      let clean = false;
      try { clean = await (await ownership).close(); } catch { /* No authority on unconfirmed ownership. */ }
      if (!stopped && !signal?.aborted && clean && code === 0 && /^\{"ok":true(?:,"private":(?:true|false))?\}$/.test(output.trim())) resolve(output.trim());
      else reject(new Error("Windows profile ownership, ACL, path or creation check failed; partial files are preserved."));
    });
    if (signal?.aborted) stop();
  });
}
export async function checkWindowsActor(signal?: AbortSignal): Promise<void> { await invoke({ operation: "actor" }, signal); }
export async function createWindowsProfiles(profiles: readonly { readonly file: string; readonly content: string }[], signal?: AbortSignal): Promise<void> {
  await invoke({ operation: "create", profiles }, signal);
}
export async function isWindowsPrivateProfile(file: string, signal?: AbortSignal): Promise<boolean> {
  return await invoke({ operation: "inspect", file }, signal) === '{"ok":true,"private":true}';
}
