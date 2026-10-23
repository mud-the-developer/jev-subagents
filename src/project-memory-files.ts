import cp from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ownWindowsProcess } from "./windows-job.ts";
import { canonicalDirectory } from "./goal-run-effects.ts";
import { MEMORY_DB, MEMORY_JOURNAL, MEMORY_LOCK, MEMORY_MAX_BYTES } from "./project-memory.ts";

export const MEMORY_FILES_ERROR = "Private memory files refused or cleanup unconfirmed; preserve remaining files and locks. No retry.";
export type MemoryRootIdentity = { readonly dev: string; readonly ino: string };
export type MemoryFileLease = { readonly directory: string; readonly check: () => Promise<void>; readonly close: (keep: boolean) => Promise<boolean> };
const fail = (): never => { throw new Error(MEMORY_FILES_ERROR); };
const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;

// Binary metadata only. Paths enter via owned stdin; no facts, SQL or credentials enter native code.
const script = String.raw`
$ErrorActionPreference='Stop'
try {
$d=[Console]::In.ReadLine()|ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class JevMemoryFiles : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Size; public IntPtr Descriptor; public int Inherit; }
 [StructLayout(LayoutKind.Sequential)] struct Info { public uint Flags,CL,CH,AL,AH,WL,WH,Volume,SizeH,SizeL,Links,IndexH,IndexL; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,ref Attributes x,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder b,uint n,uint f);
 [DllImport("kernel32.dll")] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 readonly List<SafeFileHandle> dirs=new List<SafeFileHandle>();
 readonly List<FileStream> files=new List<FileStream>();
 readonly string root; FileStream marker; bool owned;
 static void Need(bool v){if(!v)throw new InvalidOperationException();}
 static SecurityIdentifier User(){var a=WindowsIdentity.GetCurrent();Need(a.User!=null&&!new WindowsPrincipal(a).IsInRole(WindowsBuiltInRole.Administrator));return a.User;}
 static void Private(FileSystemSecurity s){
  var raw=new RawSecurityDescriptor(s.GetSecurityDescriptorBinaryForm(),0);Need((raw.ControlFlags&ControlFlags.DiscretionaryAclPresent)!=0&&raw.DiscretionaryAcl!=null);
  foreach(GenericAce a in raw.DiscretionaryAcl)Need(a is CommonAce&&!((CommonAce)a).IsCallback);
  string u=User().Value;Need(((SecurityIdentifier)s.GetOwner(typeof(SecurityIdentifier))).Value==u);
  foreach(FileSystemAccessRule r in s.GetAccessRules(true,true,typeof(SecurityIdentifier))){if(r.AccessControlType!=AccessControlType.Allow||(r.PropagationFlags&PropagationFlags.InheritOnly)!=0)continue;
   string sid=((SecurityIdentifier)r.IdentityReference).Value;Need(sid==u||sid=="S-1-5-18"||sid=="S-1-5-32-544");}
 }
 static FileSecurity Acl(){var a=new FileSecurity();a.SetOwner(User());a.SetAccessRuleProtection(true,false);foreach(string sid in new string[]{User().Value,"S-1-5-18","S-1-5-32-544"})a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));return a;}
 static Info Bound(SafeFileHandle h,string p,bool directory){var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,b,(uint)b.Capacity,0);Info i=new Info();Need(n>0&&n<b.Capacity&&GetFileInformationByHandle(h,out i));
  string q=b.ToString();if(q.StartsWith(@"\\?\"))q=q.Substring(4);Need(String.Equals(q,p,StringComparison.OrdinalIgnoreCase)&&(i.Flags&0x400)==0&&((i.Flags&0x10)!=0)==directory&&(directory||i.Links==1));return i;}
 static bool Exists(string p){try{File.GetAttributes(p);return true;}catch(FileNotFoundException){return false;}catch(DirectoryNotFoundException){return false;}}
 static FileStream Open(string p){var a=new Attributes();a.Size=Marshal.SizeOf(typeof(Attributes));var h=CreateFile(p,0x80000000,3,ref a,3,0x00200000,IntPtr.Zero);Need(!h.IsInvalid);return new FileStream(h,FileAccess.Read);}
 // SQLite opens without DELETE sharing: pinned guards request read/write only, but deny deletion by their share flags.
 static FileStream Create(string p,string text){byte[] d=Acl().GetSecurityDescriptorBinaryForm();IntPtr m=Marshal.AllocHGlobal(d.Length);try{Marshal.Copy(d,0,m,d.Length);var a=new Attributes();a.Size=Marshal.SizeOf(typeof(Attributes));a.Descriptor=m;
  var h=CreateFile(p,0xC0000000,3,ref a,1,0x00200000,IntPtr.Zero);Need(!h.IsInvalid);var f=new FileStream(h,FileAccess.ReadWrite);Bound(h,p,false);Private(f.GetAccessControl());byte[] v=new UTF8Encoding(false,true).GetBytes(text);f.Write(v,0,v.Length);f.Flush(true);return f;}finally{Marshal.FreeHGlobal(m);}}
 public JevMemoryFiles(string directory,string mode,string nonce,string expectedDev,string expectedIno){
  root=Path.GetFullPath(directory);Need(root.Length>=3&&root[1]==':'&&root[2]=='\\');var drive=new DriveInfo(Path.GetPathRoot(root));Need(drive.DriveType==DriveType.Fixed&&drive.DriveFormat=="NTFS");User();
  for(string p=root;p!=null;p=Path.GetDirectoryName(p)){var a=new Attributes();a.Size=Marshal.SizeOf(typeof(Attributes));var h=CreateFile(p,0x80000000,3,ref a,3,0x02200000,IntPtr.Zero);Need(!h.IsInvalid);Bound(h,p,true);dirs.Add(h);if(p==Path.GetPathRoot(p))break;}
  Private(new DirectoryInfo(root).GetAccessControl());var rootInfo=Bound(dirs[0],root,true);if(expectedDev.Length>0)Need(rootInfo.Volume.ToString()==expectedDev&&(((ulong)rootInfo.IndexH<<32)|rootInfo.IndexL).ToString()==expectedIno);
  Need(!Exists(Path.Combine(root,".jev-memory.lock")));
  if(mode=="create")Need(!Exists(Path.Combine(root,"memory.sqlite"))&&!Exists(Path.Combine(root,"memory.sqlite-journal")));
  Need(mode=="read"||mode=="write"||mode=="create");
  if(mode!="read"){marker=Create(Path.Combine(root,".jev-memory.lock"),nonce);owned=true;}
  foreach(string name in new string[]{"memory.sqlite","memory.sqlite-journal"}){string p=Path.Combine(root,name);var f=mode=="create"?Create(p,""):Open(p);files.Add(f);}
  Check();
 }
 public void Check(){Private(new DirectoryInfo(root).GetAccessControl());for(int n=0;n<dirs.Count;n++){Info i;Need(GetFileInformationByHandle(dirs[n],out i)&&(i.Flags&0x400)==0);}
  for(int n=0;n<files.Count;n++){string p=Path.Combine(root,n==0?"memory.sqlite":"memory.sqlite-journal");Info i=Bound(files[n].SafeFileHandle,p,false);Private(files[n].GetAccessControl());long size=((long)i.SizeH<<32)|i.SizeL;Need(size<=4194304&&(n==0||size==0));}
  Need(!Exists(Path.Combine(root,"memory.sqlite-wal"))&&!Exists(Path.Combine(root,"memory.sqlite-shm")));if(owned){Bound(marker.SafeFileHandle,Path.Combine(root,".jev-memory.lock"),false);Private(marker.GetAccessControl());}
 }
 public void Close(bool keep){Check();foreach(var f in files)f.Dispose();files.Clear();if(marker!=null){marker.Dispose();marker=null;if(!keep)File.Delete(Path.Combine(root,".jev-memory.lock"));}foreach(var h in dirs)h.Dispose();dirs.Clear();}
 public void Dispose(){foreach(var f in files)f.Dispose();if(marker!=null)marker.Dispose();foreach(var h in dirs)h.Dispose();}
}
'@
$lease=[JevMemoryFiles]::new([string]$d.directory,[string]$d.mode,[string]$d.nonce,[string]$d.expectedRoot.dev,[string]$d.expectedRoot.ino)
[Console]::Out.WriteLine('{"id":0,"ok":true}');[Console]::Out.Flush()
while($line=[Console]::In.ReadLine()){$q=$line|ConvertFrom-Json;if($q.op-eq'check'){$lease.Check()}elseif($q.op-eq'close'){$lease.Close([bool]$q.keep)}else{throw 'invalid'}
 [Console]::Out.WriteLine(('{"id":'+[int]$q.id+',"ok":true}'));[Console]::Out.Flush();if($q.op-eq'close'){exit 0}}
throw 'closed'
}catch{[Console]::Out.WriteLine('{"ok":false}');[Console]::Out.Flush();exit 1}
`;
async function windowsLease(directory: string, mode: "read" | "write" | "create", signal?: AbortSignal, expectedRoot?: MemoryRootIdentity): Promise<MemoryFileLease> {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !path.isAbsolute(root)) return fail();
  signal?.throwIfAborted();
  const born = Date.now(), child = cp.spawn(path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: { SystemRoot: root, TEMP: process.env.TEMP ?? root, TMP: process.env.TMP ?? root } });
  let next = 0, buffer = "", stopped = false, ended = false;
  let pending: { id: number; resolve: () => void; reject: () => void } | undefined;
  const stop = () => { stopped = true; pending?.reject(); pending = undefined; child.kill("SIGKILL"); };
  const timer = setTimeout(stop, 20000); timer.unref(); signal?.addEventListener("abort", stop, { once: true });
  const closed = new Promise<number | null>(resolve => child.once("close", code => { ended = true; clearTimeout(timer); signal?.removeEventListener("abort", stop); pending?.reject(); resolve(code); }));
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (text: string) => {
    buffer += text; if (buffer.length > 1024) { stop(); return; }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      try { const value: unknown = JSON.parse(line);
        if (!pending || !value || typeof value !== "object" || Object.keys(value).length !== 2 || !("id" in value) || !("ok" in value) || value.id !== pending.id || value.ok !== true) { stop(); return; }
        const done = pending.resolve; pending = undefined; done();
      } catch { stop(); }
    }
  });
  child.stdin.on("error", stop); child.once("error", stop);
  const call = (payload: Record<string, unknown>, id: number) => new Promise<void>((resolve, reject) => {
    if (pending || stopped || ended || signal?.aborted) { reject(new Error(MEMORY_FILES_ERROR)); return; }
    pending = { id, resolve, reject: () => reject(new Error(MEMORY_FILES_ERROR)) };
    child.stdin.write(JSON.stringify(payload) + "\n", error => { if (error) stop(); });
  });
  let job: Awaited<ReturnType<typeof ownWindowsProcess>> | undefined;
  try {
    job = await ownWindowsProcess(child, born); signal?.throwIfAborted();
    await call({ directory, mode, nonce: randomUUID(), ...(expectedRoot ? { expectedRoot } : {}) }, 0);
    return { directory, check: async () => { await call({ op: "check", id: ++next }, next); }, close: async keep => {
      let acknowledged = false; try { await call({ op: "close", id: ++next, keep }, next); acknowledged = await closed === 0; } catch { stop(); }
      const clean = await job!.close(); return acknowledged && clean && !stopped;
    } };
  } catch { stop(); try { await job?.close(); } catch { /* Retain uncertain native ownership. */ } return fail(); }
}

/** Only existing private directories; never mkdir/chmod, fallback or stale-lock deletion. */
export async function openMemoryFileLease(directory: string, mode: "read" | "write" | "create", signal?: AbortSignal, expectedRoot?: MemoryRootIdentity): Promise<MemoryFileLease> {
  if (!["read", "write", "create"].includes(mode) || expectedRoot && (!/^[0-9]+$/.test(expectedRoot.dev) || !/^[0-9]+$/.test(expectedRoot.ino))) return fail();
  const canonical = await canonicalDirectory(directory, true, signal);
  if (process.platform === "win32") return windowsLease(canonical, mode, signal, expectedRoot);
  const uid = process.getuid?.(); if (uid === undefined || uid === 0) return fail();
  const root = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const rootInfo = await root.stat(), handles: { name: string; handle: FileHandle }[] = [];
  let owned: { handle: FileHandle; info: Stats } | undefined;
  try {
    if (!rootInfo.isDirectory() || rootInfo.uid !== uid || (rootInfo.mode & 0o077)) fail();
    const rootId = await root.stat({ bigint: true });
    if (expectedRoot && (rootId.dev.toString() !== expectedRoot.dev || rootId.ino.toString() !== expectedRoot.ino)) fail();
    try { await lstat(path.join(canonical, MEMORY_LOCK)); fail(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (mode !== "read") { const handle = await open(path.join(canonical, MEMORY_LOCK), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      owned = { handle, info: await handle.stat() }; await handle.writeFile(randomUUID()); await handle.sync(); }
    for (const name of [MEMORY_DB, MEMORY_JOURNAL]) handles.push({ name, handle: await open(path.join(canonical, name), constants.O_NOFOLLOW |
      (mode === "create" ? constants.O_CREAT | constants.O_EXCL | constants.O_RDWR : constants.O_RDONLY), 0o600) });
    const check = async () => {
      signal?.throwIfAborted(); const currentRoot = await lstat(canonical);
      if (!same(rootInfo, currentRoot) || !currentRoot.isDirectory() || currentRoot.uid !== uid || (currentRoot.mode & 0o077)) fail();
      for (const { name, handle } of handles) {
        const info = await handle.stat(); if (!info.isFile() || info.uid !== uid || info.nlink !== 1 || (info.mode & 0o077) || info.size > MEMORY_MAX_BYTES ||
          name === MEMORY_JOURNAL && info.size !== 0 || !same(info, await lstat(path.join(canonical, name)))) fail();
      }
      for (const name of [`${MEMORY_DB}-wal`, `${MEMORY_DB}-shm`]) try { await lstat(path.join(canonical, name)); fail(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    await check();
    return { directory: canonical, check, close: async keep => {
      let clean = false;
      try { await check(); for (const { handle } of handles) await handle.close(); handles.length = 0;
        if (owned) { const current = await lstat(path.join(canonical, MEMORY_LOCK)); if (!same(owned.info, current)) fail(); await owned.handle.close(); if (!keep) await unlink(path.join(canonical, MEMORY_LOCK)); }
        await root.sync(); clean = true;
      } catch { /* Keep uncertain marker and do not claim rollback. */ }
      finally { for (const { handle } of handles) await handle.close().catch(() => {}); await owned?.handle.close().catch(() => {}); await root.close().catch(() => {}); }
      return clean;
    } };
  } catch { for (const { handle } of handles) await handle.close().catch(() => {}); await owned?.handle.close().catch(() => {}); await root.close().catch(() => {}); return fail(); }
}
