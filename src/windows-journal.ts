import cp from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ownWindowsProcess, type WindowsJob } from "./windows-job.ts";
import { applyGoalRecord, GoalHeadSchema, GoalRecordSchema, MAX_GOAL_RECORDS, type GoalHead, type GoalStorageEffect } from "./goal-machine.ts";
import { decodeGoalJournal, GOAL_JOURNAL_ERROR, MAX_GOAL_JOURNAL_BYTES, MAX_GOAL_RECORD_BYTES, type GoalJournal } from "./goal-journal.ts";

// Fixed NTFS storage code only. Named directories/record bytes arrive as data after Job ownership.
const script = String.raw`
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
try {
$firstLine=[Console]::In.ReadLine();if($null -eq $firstLine -or $firstLine.Length -gt 100000){throw 'idle'}
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class JevNativeJournal {
 [StructLayout(LayoutKind.Sequential)] struct Attr { public int Size; public IntPtr Security; public int Inherit; }
 [StructLayout(LayoutKind.Sequential)] struct Info { public uint Flags,CL,CH,AL,AH,WL,WH,Volume,High,Low,Links,IH,IL; }
 [StructLayout(LayoutKind.Sequential)] struct DeleteInfo { public int Delete; }
 [StructLayout(LayoutKind.Sequential)] struct Name { public ushort Length,Max; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)] struct Objects { public int Length; public IntPtr Root,Name; public uint Flags; public IntPtr Security,Qos; }
 [StructLayout(LayoutKind.Sequential)] struct Status { public IntPtr Result; public UIntPtr Information; }
 [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr h,uint access,ref Objects o,out Status s,IntPtr allocation,uint attributes,uint share,uint disposition,uint options,IntPtr ea,uint length);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,ref Attr sa,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder s,uint n,uint f);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(SafeFileHandle h,byte[] b,uint n,out uint read,IntPtr o);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle h,byte[] b,uint n,out uint written,IntPtr o);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle h,long p,out long result,uint method);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int kind,ref DeleteInfo info,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle h,int type,uint flags,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr p);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 readonly List<SafeFileHandle> dirs=new List<SafeFileHandle>();
 SafeFileHandle root,owner,file; string directory; Info rootId,ownerId,fileId; bool active,closed;
 static void Check(bool ok) { if(!ok)throw new InvalidOperationException(); }
 static string User() { using(var a=WindowsIdentity.GetCurrent()) { Check(a.User!=null&&!new WindowsPrincipal(a).IsInRole(WindowsBuiltInRole.Administrator)); return a.User.Value; } }
 static bool Trusted(string s,string u) { return s==u||s=="S-1-5-18"||s=="S-1-5-32-544"; }
 static void Private(SafeFileHandle h) {
  IntPtr o,g,d,s,p; Check(GetSecurityInfo(h,1,5,out o,out g,out d,out s,out p)==0&&p!=IntPtr.Zero&&d!=IntPtr.Zero);
  try {
   byte[] b=new byte[GetSecurityDescriptorLength(p)];Marshal.Copy(p,b,0,b.Length);var raw=new RawSecurityDescriptor(b,0);
   string u=User();Check(raw.Owner!=null&&raw.Owner.Value==u&&raw.DiscretionaryAcl!=null&&(raw.ControlFlags&ControlFlags.DiscretionaryAclPresent)!=0);
   foreach(GenericAce ace in raw.DiscretionaryAcl) {
    var q=ace as QualifiedAce;
    if(q!=null&&q.AceQualifier==AceQualifier.AccessAllowed&&(q.AceFlags&AceFlags.InheritOnly)==0)Check(Trusted(q.SecurityIdentifier.Value,u));
    // Object/callback/custom ACEs are not silently treated as private authority.
    Check(ace is CommonAce&&!(ace is CommonAce&&((CommonAce)ace).IsCallback));
   }
  } finally { LocalFree(p); }
 }
 static Attr Attributes() { return new Attr { Size=Marshal.SizeOf(typeof(Attr)) }; }
 static SafeFileHandle Open(string p,uint access,uint creation,IntPtr descriptor,bool dir) {
  Attr a=Attributes();a.Security=descriptor;
  var h=CreateFile(p,access,dir?3u:0u,ref a,creation,dir?0x02200000u:0x80200000u,IntPtr.Zero);
  Check(!h.IsInvalid);return h;
 }
 SafeFileHandle Child(string name,uint access,bool create,IntPtr descriptor) {
  AssertRoot();IntPtr text=Marshal.StringToHGlobalUni(name),value=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Name)));
  try {
   var n=new Name { Length=(ushort)(name.Length*2),Max=(ushort)((name.Length+1)*2),Buffer=text };Marshal.StructureToPtr(n,value,false);
   var o=new Objects { Length=Marshal.SizeOf(typeof(Objects)),Root=root.DangerousGetHandle(),Name=value,Flags=0x1040,Security=descriptor };
   IntPtr h;Status s;Check(NtCreateFile(out h,access|0x00100000u,ref o,out s,IntPtr.Zero,0x80,name=="goal.jsonl"?1u:0u,create?2u:1u,0x00200062,IntPtr.Zero,0)==0);
   return new SafeFileHandle(h,true);
  } finally {Marshal.FreeHGlobal(value);Marshal.FreeHGlobal(text);}
 }
 void AssertRoot(){Check(Same(rootId,Bound(root,directory,true)));Private(root);}
 static Info Bound(SafeFileHandle h,string expected,bool dir) {
  Info i;Check(GetFileInformationByHandle(h,out i)&&(i.Flags&0x400)==0&&((i.Flags&0x10)!=0)==dir&&(dir||i.Links==1));
  var s=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,s,(uint)s.Capacity,0);Check(n>0&&n<s.Capacity);
  string actual=s.ToString();if(actual.StartsWith(@"\\?\"))actual=actual.Substring(4);
  Check(String.Equals(actual.TrimEnd('\\'),expected.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase));return i;
 }
 static bool Same(Info a,Info b) { return a.Volume==b.Volume&&a.IH==b.IH&&a.IL==b.IL; }
 static IntPtr Descriptor() {
  var a=new FileSecurity();a.SetOwner(new SecurityIdentifier(User()));a.SetAccessRuleProtection(true,false);
  foreach(string s in new string[]{User(),"S-1-5-18","S-1-5-32-544"})a.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(s),FileSystemRights.FullControl,AccessControlType.Allow));
  byte[] b=a.GetSecurityDescriptorBinaryForm();IntPtr p=Marshal.AllocHGlobal(b.Length);Marshal.Copy(b,0,p,b.Length);return p;
 }
 static void Close(SafeFileHandle h) { if(h==null||h.IsInvalid||h.IsClosed)return;Check(CloseHandle(h.DangerousGetHandle()));h.SetHandleAsInvalid(); }
 void AssertOwner() {
  Check(active&&!closed);AssertRoot();
  Check(Same(ownerId,Bound(owner,Path.Combine(directory,"owner.lock"),false)));Private(owner);
  Check(Same(fileId,Bound(file,Path.Combine(directory,"goal.jsonl"),false)));Private(file);
 }
 public string Start(string name,string mode) {
  User();Check(mode=="create"||mode=="open");Check(!String.IsNullOrEmpty(name)&&name.Length<=32700);
  foreach(char c in name)Check(c>=32&&c!=127);
  directory=Path.GetFullPath(name).TrimEnd('\\');Check(directory.Length>3&&directory[1]==':'&&directory[2]=='\\'&&directory.IndexOf(':',2)<0);
  var drive=new DriveInfo(Path.GetPathRoot(directory));Check(drive.DriveType==DriveType.Fixed&&drive.DriveFormat=="NTFS");
  var names=new List<string>();for(string p=directory;;p=Path.GetDirectoryName(p)){names.Add(p);if(p==Path.GetPathRoot(p))break;}
  names.Reverse();foreach(string p in names){var h=Open(p,p==directory?0xC0000000u:0x80000000u,3,IntPtr.Zero,true);dirs.Add(h);Bound(h,p,true);}
  root=dirs[dirs.Count-1];rootId=Bound(root,directory,true);Private(root);Check(FlushFileBuffers(root));
  IntPtr descriptor=Descriptor();try {
   owner=Child("owner.lock",0xC0010000,true,descriptor);ownerId=Bound(owner,Path.Combine(directory,"owner.lock"),false);Private(owner);
   Check(FlushFileBuffers(owner)&&FlushFileBuffers(root));
   file=Child("goal.jsonl",0xC0000000,mode=="create",descriptor);fileId=Bound(file,Path.Combine(directory,"goal.jsonl"),false);Private(file);
   Check(FlushFileBuffers(file)&&FlushFileBuffers(root));active=true;return Read();
  } finally { Marshal.FreeHGlobal(descriptor); }
 }
 public string Read() {
  AssertOwner();Info before=Bound(file,Path.Combine(directory,"goal.jsonl"),false);long length=((long)before.High<<32)|before.Low;Check(length<=4194304);
  long pos;Check(SetFilePointerEx(file,0,out pos,0));byte[] bytes=new byte[(int)length];int offset=0;
  while(offset<bytes.Length){byte[] chunk=new byte[Math.Min(65536,bytes.Length-offset)];uint n;Check(ReadFile(file,chunk,(uint)chunk.Length,out n,IntPtr.Zero)&&n>0);Buffer.BlockCopy(chunk,0,bytes,offset,(int)n);offset+=(int)n;}
  Info after=Bound(file,Path.Combine(directory,"goal.jsonl"),false);Check(Same(before,after)&&before.High==after.High&&before.Low==after.Low&&before.WL==after.WL&&before.WH==after.WH);AssertOwner();return Convert.ToBase64String(bytes);
 }
 public string Append(string prior,string body) {
  byte[] old=Convert.FromBase64String(Read());using(var sha=SHA256.Create())Check(BitConverter.ToString(sha.ComputeHash(old)).Replace("-","").ToLowerInvariant()==prior);
  byte[] b=Convert.FromBase64String(body);Check(b.Length>0&&b.Length<=65536&&old.Length+b.Length<=4194304);AssertOwner();long p;Check(SetFilePointerEx(file,0,out p,2)&&p==old.Length);
  int offset=0;while(offset<b.Length){byte[] chunk=new byte[b.Length-offset];Buffer.BlockCopy(b,offset,chunk,0,chunk.Length);uint n;Check(WriteFile(file,chunk,(uint)chunk.Length,out n,IntPtr.Zero)&&n>0);offset+=(int)n;}
  Check(FlushFileBuffers(file)&&FlushFileBuffers(root));string current=Read();byte[] actual=Convert.FromBase64String(current);Check(actual.Length==old.Length+b.Length);
  for(int i=0;i<old.Length;i++)Check(actual[i]==old[i]);for(int i=0;i<b.Length;i++)Check(actual[old.Length+i]==b[i]);return current;
 }
 public void Finish() {
  AssertOwner();Close(file);var info=new DeleteInfo { Delete=1 };Check(SetFileInformationByHandle(owner,4,ref info,4));Close(owner);Check(FlushFileBuffers(root));
  for(int i=dirs.Count-1;i>=0;i--)Close(dirs[i]);closed=true;active=false;
 }
 public void Abandon() { active=false;foreach(var h in new SafeFileHandle[]{file,owner}){try{Close(h);}catch{}}for(int i=dirs.Count-1;i>=0;i--){try{Close(dirs[i]);}catch{}} }
}
'@
$store=New-Object JevNativeJournal; $last=0
try {
while($true) {
 $line=if($last -eq 0){$firstLine}else{[Console]::In.ReadLine()}; if($null -eq $line){throw 'closed'}
 if($line.Length -gt 100000){throw 'bounds'}
 $data=$line|ConvertFrom-Json; if($data.id -ne $last+1 -or $data.id -gt 16384){throw 'order'}; $last=$data.id
 $result=$null
 if($last -eq 1 -and $data.op -eq 'open'){$result=$store.Start([string]$data.directory,[string]$data.mode)}
 elseif($last -gt 1 -and $data.op -eq 'read'){$result=$store.Read()}
 elseif($last -gt 1 -and $data.op -eq 'append'){$result=$store.Append([string]$data.prior,[string]$data.body)}
 elseif($last -gt 1 -and $data.op -eq 'close'){$store.Finish()}
 else {throw 'op'}
 $out=@{id=$last;ok=$true};if($null -ne $result){$out.data=$result}
 [Console]::Out.WriteLine(($out|ConvertTo-Json -Compress));[Console]::Out.Flush()
 if($data.op -eq 'close'){break}
}
}finally{$store.Abandon()}
}catch{[Console]::Out.WriteLine('{"ok":false}');[Console]::Out.Flush();exit 1}
`;

const effectSchema = Type.Object({ type: Type.Literal("append_goal"), expected: GoalHeadSchema, record: GoalRecordSchema }, { additionalProperties: false });
const failure = (): never => { throw new Error(GOAL_JOURNAL_ERROR); };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Trusted effect/test boundary, never worker-supplied callbacks. */
export const windowsJournalIO = { spawn: cp.spawn, own: ownWindowsProcess };

async function transport(directory: string, mode: "create" | "open", signal?: AbortSignal) {
  if (process.platform !== "win32" || !path.isAbsolute(directory) || !["create", "open"].includes(mode) || /[\u0000-\u001f\u007f]/.test(directory)) return failure();
  signal?.throwIfAborted();
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !path.isAbsolute(root)) return failure();
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  if (encoded.length > 31000) return failure();
  const born = Date.now(), child = windowsJournalIO.spawn(path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: { SystemRoot: root, TEMP: process.env.TEMP ?? root, TMP: process.env.TMP ?? root } });
  let job: WindowsJob | undefined, buffer = "", sequence = 0, ended = false, broken = false;
  let pending: { id: number; resolve(data: unknown): void; reject(): void } | undefined;
  const stop = () => { broken = true; pending?.reject(); pending = undefined; child.kill("SIGKILL"); };
  child.stdin.on("error", stop); child.once("error", stop);
  child.once("close", () => { ended = true; if (pending) stop(); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > Math.ceil(MAX_GOAL_JOURNAL_BYTES / 3) * 4 + 1024) { stop(); return; }
    for (;;) {
      const n = buffer.indexOf("\n"); if (n < 0) break;
      const line = buffer.slice(0, n).trim(); buffer = buffer.slice(n + 1);
      try {
        const value: unknown = JSON.parse(line);
        if (!pending || !value || typeof value !== "object" || Array.isArray(value)) { stop(); return; }
        const frame = value as Record<string, unknown>;
        if (frame.ok !== true || frame.id !== pending.id || Object.keys(frame).some(key => !["id", "ok", "data"].includes(key))) { stop(); return; }
        const current = pending; pending = undefined; current.resolve(frame.data);
      } catch { stop(); }
    }
  });
  const call = async (data: Record<string, unknown>, requestSignal?: AbortSignal): Promise<unknown> => {
    if (!job || pending || ended || broken || requestSignal?.aborted) return failure();
    const id = ++sequence, bytes = JSON.stringify({ ...data, id }) + "\n";
    if (Buffer.byteLength(bytes) > 100000 || id > 16384) return failure();
    return new Promise((resolve, reject) => {
      const cancelled = () => stop();
      const timer = setTimeout(cancelled, 20_000);
      const cleanup = () => { clearTimeout(timer); requestSignal?.removeEventListener("abort", cancelled); };
      pending = { id, resolve(value) { cleanup(); resolve(value); }, reject() { cleanup(); reject(new Error(GOAL_JOURNAL_ERROR)); } };
      requestSignal?.addEventListener("abort", cancelled, { once: true });
      if (requestSignal?.aborted) { cancelled(); return; }
      try { child.stdin.write(bytes); } catch { cancelled(); }
    });
  };
  const close = async (clean: boolean): Promise<boolean> => {
    let acknowledged = false;
    if (clean && !broken && !ended) { try { acknowledged = await call({ op: "close" }) === undefined; } catch { /* Keep unknown cleanup unknown. */ } }
    child.stdin.end();
    if (!acknowledged) stop();
    let killed = false;
    try { killed = await job?.close() === true; } catch { /* No ownership fallback. */ }
    if (!ended && !killed) child.kill("SIGKILL");
    return acknowledged && killed;
  };
  try {
    job = await windowsJournalIO.own(child, born);
    signal?.throwIfAborted();
    const first = await call({ op: "open", directory, mode }, signal);
    return { first, call, close };
  } catch {
    stop(); try { await job?.close(); } catch { /* Unknown cleanup, no marker deletion. */ }
    return failure();
  }
}
function bytes(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_GOAL_JOURNAL_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return failure();
  const data = Buffer.from(value, "base64");
  if (data.length > MAX_GOAL_JOURNAL_BYTES || data.toString("base64") !== value) return failure();
  return data;
}

/** Standalone NTFS journal only: pinned handles and real directory FlushFileBuffers, not full Windows Goal authority. */
export async function openWindowsGoalJournal(directory: string, mode: "create" | "open", signal?: AbortSignal): Promise<GoalJournal> {
  let io: Awaited<ReturnType<typeof transport>>;
  try { io = await transport(directory, mode, signal); } catch { return failure(); }
  let active = true, busy = false, poisoned = false, closing: Promise<void> | undefined;
  let known: GoalHead;
  try { known = decodeGoalJournal(bytes(io.first)).head; signal?.throwIfAborted(); }
  catch { await io.close(false); return failure(); }
  const read = async () => {
    const raw = bytes(await io.call({ op: "read" }));
    const snapshot = decodeGoalJournal(raw);
    if (!isDeepStrictEqual(snapshot.head, known)) return failure();
    return { raw, snapshot };
  };
  return {
    async load() {
      if (busy || !active || poisoned) return failure();
      busy = true;
      try { return (await read()).snapshot; } catch { poisoned = true; return failure(); } finally { busy = false; }
    },
    async append(input: GoalStorageEffect, appendSignal) {
      if (busy || !active || poisoned) return failure();
      busy = true;
      try {
        if (!Value.Check(effectSchema, input)) return failure();
        const effect = structuredClone(input); appendSignal?.throwIfAborted();
        const { raw, snapshot } = await read();
        if (!isDeepStrictEqual(effect.expected, snapshot.head)) return failure();
        applyGoalRecord(snapshot.ledger, effect.record);
        const sequence = snapshot.head.sequence + 1;
        const envelope = { version: 1, sequence, previous: snapshot.head.hash, record: effect.record };
        const hash = sha(Buffer.from(JSON.stringify(envelope)));
        const line = Buffer.from(JSON.stringify({ ...envelope, checksum: hash }) + "\n");
        if (line.length > MAX_GOAL_RECORD_BYTES || sequence > MAX_GOAL_RECORDS || raw.length + line.length + (effect.record.type === "reserved" ? MAX_GOAL_RECORD_BYTES : 0) > MAX_GOAL_JOURNAL_BYTES) return failure();
        appendSignal?.throwIfAborted();
        const result = bytes(await io.call({ op: "append", prior: sha(raw), body: line.toString("base64") }, appendSignal));
        const head = { sequence, hash };
        if (!result.equals(Buffer.concat([raw, line])) || !isDeepStrictEqual(decodeGoalJournal(result).head, head)) return failure();
        appendSignal?.throwIfAborted(); known = head; return { ...head };
      } catch { poisoned = true; return failure(); } finally { busy = false; }
    },
    async close() {
      if (closing) return closing;
      if (busy) return failure();
      active = false;
      closing = (async () => { if (!await io.close(!poisoned)) return failure(); })();
      return closing;
    },
  };
}
