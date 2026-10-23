import cp from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ownWindowsProcess, type WindowsJob } from "./windows-job.ts";
import { GOAL_FILES_ERROR, FileIdentitySchema, GoalFileVersionSchema, MAX_GOAL_FILE_BYTES, MAX_GOAL_FILES_BYTES,
  goalFileDigest, goalTextBytes, goalFileReplacement, validGoalFileInput, validGoalFileScope, validGoalFileRequest,
  type GoalFileInput, type GoalFileScope, type GoalFileIoEffect, type GoalFileIoEvent, type GoalFileVersion } from "./goal-files.ts";
import type { GoalFileProtections } from "./goal-file-effects.ts";
import { DirectoryValidationError, directoryError, directoryReason, type DirectoryReason } from "./directory-diagnostics.ts";

// Effect-only native adapter. Static source crosses stdin only AFTER verified Job ownership.
// No source/path/text from worker arguments is interpolated into executable code.
const bootstrap = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try{$s=[Console]::In.ReadLine();if($null -eq $s -or $s.Length -gt 200000){throw 'bounds'};&([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))))}catch{[Console]::Out.WriteLine('{"id":0,"ok":false,"reason":"helper_setup"}');[Console]::Out.Flush();exit 1}`;
const script = String.raw`
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System;using System.IO;using System.Text;using System.Collections.Generic;using System.Security.AccessControl;using System.Security.Principal;using System.Security.Cryptography;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public sealed class JevFileScope {
 [StructLayout(LayoutKind.Sequential)] struct Attr {public int Size;public IntPtr Security;public int Inherit;}
 [StructLayout(LayoutKind.Sequential)] struct Info {public uint Flags,CL,CH,AL,AH,WL,WH,Volume,High,Low,Links,IH,IL;}
 [StructLayout(LayoutKind.Sequential)] struct Basic {public long Created,Accessed,Written,Changed;public uint Flags;}
 [StructLayout(LayoutKind.Sequential)] struct DeleteInfo {public int Delete;}
 [StructLayout(LayoutKind.Sequential)] struct Name {public ushort Length,Max;public IntPtr Buffer;}
 [StructLayout(LayoutKind.Sequential)] struct Objects {public int Length;public IntPtr Root,Name;public uint Flags;public IntPtr Security,Qos;}
 [StructLayout(LayoutKind.Sequential)] struct Status {public IntPtr Result;public UIntPtr Information;}
 [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr h,uint access,ref Objects o,out Status s,IntPtr allocation,uint attributes,uint share,uint disposition,uint options,IntPtr ea,uint length);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,ref Attr sa,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h,StringBuilder s,uint n,uint f);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int kind,out Basic i,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(SafeFileHandle h,byte[] b,uint n,out uint read,IntPtr o);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle h,byte[] b,uint n,out uint written,IntPtr o);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle h,long p,out long result,uint method);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetEndOfFile(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int kind,ref DeleteInfo info,uint size);
 [DllImport("advapi32.dll",SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle h,int type,uint flags,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr p);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 public sealed class Identity {public double dev;public string ino;}
 public sealed class Version {public Identity identity;public string stamp,digest;public int bytes;}
 public sealed class Row {public string path,body;public Version version;}
 public sealed class Snapshot {public string root;public Identity rootIdentity;public Row[] files;}
 sealed class Leaf {public string path,absolute;public SafeFileHandle handle;public Info identity;public bool privacy;}
 readonly List<SafeFileHandle> dirs=new List<SafeFileHandle>();readonly List<SafeFileHandle> projectDirs=new List<SafeFileHandle>();readonly List<Leaf> leaves=new List<Leaf>();readonly List<string> protectedPaths=new List<string>();
 SafeFileHandle root;Info rootId;string directory,writable,markerStamp;bool active,privateRoot,controlRoot;
 public bool IsMarker {get{return markerStamp!=null;}}
 public static string FailureReason="unknown";
 static void Check(bool ok,string reason="unknown"){if(!ok){if(FailureReason=="unknown")FailureReason=reason;throw new InvalidOperationException();}}
 static string User(){using(var a=WindowsIdentity.GetCurrent()){Check(a.User!=null,"actor_unavailable");Check(!new WindowsPrincipal(a).IsInRole(WindowsBuiltInRole.Administrator),"elevated_actor");return a.User.Value;}}
 static bool Trusted(string s,string u){return s==u||s=="S-1-5-18"||s=="S-1-5-32-544";}
 static string Hash(byte[] b){using(var h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(b)).Replace("-","").ToLowerInvariant();}
 static byte[] Security(SafeFileHandle h,bool privacy){
  IntPtr o,g,d,s,p;Check(GetSecurityInfo(h,1,5,out o,out g,out d,out s,out p)==0&&p!=IntPtr.Zero,"access_denied");
  try {
   Check(d!=IntPtr.Zero,"missing_dacl");byte[] b=new byte[GetSecurityDescriptorLength(p)];Marshal.Copy(p,b,0,b.Length);var raw=new RawSecurityDescriptor(b,0);string u=User();
   Check(raw.Owner!=null&&raw.Owner.Value==u,"owner_mismatch");Check(raw.DiscretionaryAcl!=null&&(raw.ControlFlags&ControlFlags.DiscretionaryAclPresent)!=0,"missing_dacl");
   foreach(GenericAce ace in raw.DiscretionaryAcl){Check(ace is CommonAce&&!((CommonAce)ace).IsCallback,"unsupported_acl");var q=(CommonAce)ace;
    if(q.AceQualifier==AceQualifier.AccessAllowed&&(q.AceFlags&AceFlags.InheritOnly)==0&&!Trusted(q.SecurityIdentifier.Value,u))Check(!privacy&&((uint)q.AccessMask&0x500d0156u)==0,privacy?"unsafe_private_acl":"unsafe_write_acl");
   }return b;
  }finally{LocalFree(p);}
 }
 static string Canonical(SafeFileHandle h){var s=new StringBuilder(32768);uint n=GetFinalPathNameByHandle(h,s,(uint)s.Capacity,0);Check(n>0&&n<s.Capacity);string p=s.ToString();Check(p.StartsWith(@"\\?\"));return p.Substring(4);}
 static Info Bound(SafeFileHandle h,string expected,bool dir,bool exact){Info i;Check(GetFileInformationByHandle(h,out i),"access_denied");Check((i.Flags&0x400)==0,"reparse_path");Check(((i.Flags&0x10)!=0)==dir,dir?"not_directory":"unknown");Check(dir||i.Links==1,"identity_changed");Check(String.Equals(Canonical(h).TrimEnd('\\'),expected.TrimEnd('\\'),exact?StringComparison.Ordinal:StringComparison.OrdinalIgnoreCase),"identity_changed");return i;}
 static bool Same(Info a,Info b){return a.Volume==b.Volume&&a.IH==b.IH&&a.IL==b.IL;}
 static Identity Id(Info i){return new Identity{dev=i.Volume,ino="ntfs:"+i.IH.ToString("x8")+i.IL.ToString("x8")};}
 static string Local(string source){Check(!String.IsNullOrEmpty(source)&&source.Length<=4096,"invalid_path");foreach(char c in source)Check(c>=32&&c!=127,"invalid_path");string p=source.Replace('/','\\');if(p.Length>3)p=p.TrimEnd('\\');Check(p.Length>=3&&p[1]==':'&&p[2]=='\\'&&p.IndexOf(':',2)<0&&Path.GetFullPath(p)==p,"invalid_path");var d=new DriveInfo(Path.GetPathRoot(p));Check(d.IsReady,"missing");Check(d.DriveType==DriveType.Fixed&&d.DriveFormat=="NTFS","unsupported_storage");return p;}
 static string DirectoryName(SafeFileHandle h){string p=Canonical(h);return p.Length==3?p:p.TrimEnd('\\');}
 SafeFileHandle Pin(string source,bool write=false){string name=Local(source);var parts=new List<string>();for(string p=name;;p=Path.GetDirectoryName(p)){parts.Add(p);if(p==Path.GetPathRoot(p))break;}parts.Reverse();SafeFileHandle h=null;
  foreach(string p in parts){var a=new Attr{Size=Marshal.SizeOf(typeof(Attr))};h=CreateFile(p,write&&p==name?0xc0000000u:0x80000000u,3,ref a,3,0x02200000u,IntPtr.Zero);if(h.IsInvalid){int e=Marshal.GetLastWin32Error();Check(false,e==2||e==3?"missing":e==5?"access_denied":e==32?"sharing_violation":"unknown");}dirs.Add(h);Bound(h,p,true,false);}return h;
 }
 static bool Below(string root,string p){return p.Equals(root,StringComparison.OrdinalIgnoreCase)||p.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase);}
 static string[] Parts(string p){Check(!String.IsNullOrEmpty(p)&&p.Length<=512&&p.IndexOf('\\')<0&&p.IndexOf(':')<0);var parts=p.Split('/');foreach(string s in parts){Check(s.Length>0&&s!="."&&s!=".."&&!s.EndsWith(".")&&!s.EndsWith(" ")&&s.IndexOfAny(new char[]{'*','?','<','>','|','"'})<0);foreach(char c in s)Check(c>=32&&c!=127);string b=s.Split('.')[0].ToUpperInvariant();Check(b!="CON"&&b!="PRN"&&b!="AUX"&&b!="NUL"&&!(b.Length==4&&(b.StartsWith("COM")||b.StartsWith("LPT"))&&b[3]>='1'&&b[3]<='9'));}return parts;}
 SafeFileHandle Child(SafeFileHandle parent,string name,bool dir,bool write,bool missing){IntPtr text=Marshal.StringToHGlobalUni(name),value=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Name)));try{
  var n=new Name{Length=(ushort)(name.Length*2),Max=(ushort)((name.Length+1)*2),Buffer=text};Marshal.StructureToPtr(n,value,false);var o=new Objects{Length=Marshal.SizeOf(typeof(Objects)),Root=parent.DangerousGetHandle(),Name=value,Flags=0x1040};IntPtr h;Status status;
  int result=NtCreateFile(out h,(write?0xc0000000u:0x80000000u)|0x00100000u,ref o,out status,IntPtr.Zero,0x80,dir?3u:controlRoot?(name==".jev-goal.lock"?7u:3u):0u,1,0x00200020u|(dir?1u:0x40u)|(write?2u:0u),IntPtr.Zero,0);
  if(missing&&result==unchecked((int)0xc0000034u))return null;Check(result==0);return new SafeFileHandle(h,true);
 }finally{Marshal.FreeHGlobal(value);Marshal.FreeHGlobal(text);}}
 SafeFileHandle CreateMarker(){string name=".jev-goal.lock",u=User();var raw=new RawSecurityDescriptor("O:"+u+"D:P(A;;FA;;;"+u+")(A;;FA;;;SY)(A;;FA;;;BA)");byte[] bytes=new byte[raw.BinaryLength];raw.GetBinaryForm(bytes,0);IntPtr security=Marshal.AllocHGlobal(bytes.Length),text=Marshal.StringToHGlobalUni(name),value=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Name)));
  try{Marshal.Copy(bytes,0,security,bytes.Length);var n=new Name{Length=(ushort)(name.Length*2),Max=(ushort)((name.Length+1)*2),Buffer=text};Marshal.StructureToPtr(n,value,false);var o=new Objects{Length=Marshal.SizeOf(typeof(Objects)),Root=root.DangerousGetHandle(),Name=value,Flags=0x1040,Security=security};IntPtr h;Status status;
   Check(NtCreateFile(out h,0xc0110000u,ref o,out status,IntPtr.Zero,0x80,1,2,0x00200062u,IntPtr.Zero,0)==0);return new SafeFileHandle(h,true);
  }finally{Marshal.FreeHGlobal(value);Marshal.FreeHGlobal(text);Marshal.FreeHGlobal(security);}
 }
 void AssertRoot(){Check(active&&Same(rootId,Bound(root,directory,true,true)));if(!controlRoot)Security(root,privateRoot);foreach(var h in dirs){Info i;Check(GetFileInformationByHandle(h,out i)&&(i.Flags&0x400)==0);}foreach(var h in projectDirs)Security(h,false);}
 static string Stamp(SafeFileHandle h,Info i){Basic b;Check(GetFileInformationByHandleEx(h,0,out b,(uint)Marshal.SizeOf(typeof(Basic))));return Hash(Encoding.UTF8.GetBytes(i.Volume+":"+i.IH+":"+i.IL+":"+i.High+":"+i.Low+":"+i.Flags+":"+b.Created+":"+b.Written+":"+b.Changed+":"+Convert.ToBase64String(Security(h,false))));}
 Row Read(Leaf f){AssertRoot();Info before=Bound(f.handle,f.absolute,false,true);Check(Same(before,f.identity));Security(f.handle,f.privacy);long length=((long)before.High<<32)|before.Low;Check(length<=32768);string stamp=Stamp(f.handle,before);long p;Check(SetFilePointerEx(f.handle,0,out p,0));byte[] bytes=new byte[(int)length];int offset=0;
  while(offset<bytes.Length){byte[] chunk=new byte[bytes.Length-offset];uint n;Check(ReadFile(f.handle,chunk,(uint)chunk.Length,out n,IntPtr.Zero)&&n>0&&n<=chunk.Length);Buffer.BlockCopy(chunk,0,bytes,offset,(int)n);offset+=(int)n;}
  uint extra;Check(ReadFile(f.handle,new byte[1],1,out extra,IntPtr.Zero)&&extra==0);string text=new UTF8Encoding(false,true).GetString(bytes);Check(text.IndexOf('\0')<0);Info after=Bound(f.handle,f.absolute,false,true);Check(stamp==Stamp(f.handle,after));
  return new Row{path=f.path,body=Convert.ToBase64String(bytes),version=new Version{identity=Id(before),stamp=stamp,digest=Hash(bytes),bytes=bytes.Length}};
 }
 public Snapshot Start(string name,string[] files,string write,string[] protectedRoots,bool missing,bool privacy,bool control){Check(!active&&files!=null&&files.Length<=16);User();controlRoot=control;Check(!control||(files.Length==1&&Parts(files[0]).Length==1&&String.IsNullOrEmpty(write)&&!privacy&&protectedRoots.Length==0));root=Pin(name);directory=DirectoryName(root);rootId=Bound(root,directory,true,true);privateRoot=privacy;if(!control)Security(root,privacy);
  foreach(string p in protectedRoots){var h=Pin(p);string canonical=Canonical(h).TrimEnd('\\');Check(!Below(canonical,directory));protectedPaths.Add(canonical);}
  writable=write;active=true;foreach(string file in files){var parts=Parts(file);foreach(string p in protectedPaths)Check(!Below(p,Path.Combine(directory,file.Replace('/','\\'))));SafeFileHandle parent=root;string current=directory;
   for(int k=0;k<parts.Length;k++){current=Path.Combine(current,parts[k]);bool dir=k<parts.Length-1;var h=Child(parent,parts[k],dir,!dir&&file==write,missing&&!dir);if(h==null)continue;
    if(dir){dirs.Add(h);projectDirs.Add(h);Bound(h,current,true,true);Security(h,false);parent=h;}
    else{var f=new Leaf{path=file,absolute=controlRoot?Canonical(h):current,handle=h};leaves.Add(f);f.identity=Bound(h,current,false,!controlRoot);Security(h,false);}
   }
  }return ReadAll();
 }
 public Snapshot StartControls(string[] locations){Check(!active&&locations!=null&&locations.Length>0&&locations.Length<=128);User();controlRoot=true;root=Pin(Path.GetDirectoryName(Local(locations[0])));directory=DirectoryName(root);rootId=Bound(root,directory,true,true);active=true;
  foreach(string location in locations){string full=Local(location),parent=Path.GetDirectoryName(full),name=Path.GetFileName(full);Check(Parts(name).Length==1);var dir=Pin(parent);var h=Child(dir,name,false,false,true);if(h==null)continue;
   var f=new Leaf{path=location,absolute=Canonical(h),handle=h};leaves.Add(f);f.identity=Bound(h,Path.Combine(DirectoryName(dir),name),false,false);Security(h,false);
  }return ReadAll();
 }
 public Snapshot StartMarker(string name,double dev,string ino,string body){Check(!active);User();root=Pin(name,true);directory=DirectoryName(root);Check(directory.Length>3);rootId=Bound(root,directory,true,true);Security(root,false);Identity id=Id(rootId);Check(id.dev==dev&&id.ino==ino);byte[] bytes=Convert.FromBase64String(body);Check(bytes.Length<=32768&&new UTF8Encoding(false,true).GetString(bytes).IndexOf('\0')<0);
  active=true;var f=new Leaf{path=".jev-goal.lock",absolute=Path.Combine(directory,".jev-goal.lock"),handle=CreateMarker(),privacy=true};leaves.Add(f);f.identity=Bound(f.handle,f.absolute,false,true);Security(f.handle,true);writable=f.path;
  Snapshot result=Write(f.path,Read(f).version.stamp,body);Check(FlushFileBuffers(root));markerStamp=result.files[0].version.stamp;return result;
 }
 public bool FinishMarker(bool keep){Check(IsMarker);var f=leaves[0];Check(Read(f).version.stamp==markerStamp);if(!keep){var info=new DeleteInfo{Delete=1};Check(SetFileInformationByHandle(f.handle,4,ref info,(uint)Marshal.SizeOf(typeof(DeleteInfo))));}
  Close(f.handle);Check(FlushFileBuffers(root));for(int i=dirs.Count-1;i>=0;i--)Close(dirs[i]);active=false;return keep;
 }
 public Snapshot ReadAll(){AssertRoot();var rows=new List<Row>();int size=0;foreach(var f in leaves){var row=Read(f);size+=row.version.bytes;Check(size<=131072);rows.Add(row);}return new Snapshot{root=directory,rootIdentity=Id(rootId),files=rows.ToArray()};}
 public Snapshot Write(string path,string prior,string body){AssertRoot();var f=leaves.Find(x=>x.path==path);Check(f!=null&&path==writable&&Read(f).version.stamp==prior);byte[] bytes=Convert.FromBase64String(body);Check(bytes.Length<=32768);string text=new UTF8Encoding(false,true).GetString(bytes);Check(text.IndexOf('\0')<0);long p;Check(SetFilePointerEx(f.handle,0,out p,0));int offset=0;
  while(offset<bytes.Length){byte[] chunk=new byte[bytes.Length-offset];Buffer.BlockCopy(bytes,offset,chunk,0,chunk.Length);uint n;Check(WriteFile(f.handle,chunk,(uint)chunk.Length,out n,IntPtr.Zero)&&n>0&&n<=chunk.Length);offset+=(int)n;}
  Check(SetEndOfFile(f.handle)&&FlushFileBuffers(f.handle));var result=ReadAll();var stored=Array.Find(result.files,x=>x.path==path);Check(stored!=null&&stored.body==body&&Same(f.identity,Bound(f.handle,f.absolute,false,true)));return result;
 }
 static void Close(SafeFileHandle h){if(h==null||h.IsInvalid||h.IsClosed)return;Check(CloseHandle(h.DangerousGetHandle()));h.SetHandleAsInvalid();}
 public void Finish(){AssertRoot();foreach(var f in leaves)Close(f.handle);for(int i=dirs.Count-1;i>=0;i--)Close(dirs[i]);active=false;}
 public void Abandon(){active=false;foreach(var f in leaves){try{Close(f.handle);}catch{}}for(int i=dirs.Count-1;i>=0;i--){try{Close(dirs[i]);}catch{}}}
}
'@
$store=New-Object JevFileScope;$last=0;$opened=$false
try{while($true){$line=[Console]::In.ReadLine();if($null -eq $line -and -not $opened){break};if($null -eq $line -or $line.Length -gt 200000){throw 'bounds'};$data=$line|ConvertFrom-Json;if($data.id -ne $last+1 -or $data.id -gt 1024){throw 'order'};$last=$data.id;$result=$null
 if(-not $opened -and $data.op -eq 'open'){$opened=$true;if($data.controls){$result=$store.StartControls([string[]]$data.files)}elseif($null -ne $data.marker){$result=$store.StartMarker([string]$data.root,[double]$data.marker.identity.dev,[string]$data.marker.identity.ino,[string]$data.marker.body)}else{$result=$store.Start([string]$data.root,[string[]]$data.files,[string]$data.writable,[string[]]$data.protected,[bool]$data.missing,[bool]$data.privacy,[bool]$data.control)}}
 elseif($opened -and $data.op -eq 'read'){$result=$store.ReadAll()}
 elseif($opened -and $data.op -eq 'write'){$result=$store.Write([string]$data.path,[string]$data.prior,[string]$data.body)}
 elseif($opened -and $data.op -eq 'close'){if($store.IsMarker){$result=$store.FinishMarker([bool]$data.keep)}else{$store.Finish()};$opened=$false}
 else{throw 'op'}
 $out=@{id=$last;ok=$true};if($null -ne $result){$out.data=$result};[Console]::Out.WriteLine(($out|ConvertTo-Json -Compress -Depth 16));[Console]::Out.Flush();if($data.op -eq 'close'){if(-not $data.reuse){break};$store=New-Object JevFileScope;[JevFileScope]::FailureReason='unknown'}
}}finally{$store.Abandon()}
}catch{$reason='helper_setup';if('JevFileScope' -as [type]){$reason=[JevFileScope]::FailureReason};$failure=@{id=0;ok=$false;reason=$reason};if($null -ne $last){$failure.id=$last};[Console]::Out.WriteLine(($failure|ConvertTo-Json -Compress));[Console]::Out.Flush();exit 1}
`;
const fail = (): never => { throw new Error(GOAL_FILES_ERROR); };
/** Trusted effect/fault fixture boundary only; never accepted through public worker arguments. */
export const windowsGoalFileIO = { spawn: cp.spawn, own: ownWindowsProcess };
const snapshotSchema = Type.Object({ root: Type.String(), rootIdentity: FileIdentitySchema, files: Type.Array(Type.Object({
  path: Type.String(), body: Type.String({ maxLength: Math.ceil(MAX_GOAL_FILE_BYTES / 3) * 4 }), version: GoalFileVersionSchema,
}, { additionalProperties: false }), { maxItems: 128 }) }, { additionalProperties: false });
type NativeSnapshot = { root: string; rootIdentity: GoalFileScope["rootIdentity"]; files: { path: string; text: string; version: GoalFileVersion }[] };
function snapshot(value: unknown, maximum = 16): NativeSnapshot {
  if (!Value.Check(snapshotSchema, value) || value.files.length > maximum) return fail();
  let sum = 0;
  const files = value.files.map(row => {
    const bytes = Buffer.from(row.body, "base64");
    if (bytes.toString("base64") !== row.body || bytes.length !== row.version.bytes || goalFileDigest(bytes) !== row.version.digest) return fail();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (goalTextBytes(text) !== bytes.length) return fail(); sum += bytes.length;
    return { path: row.path, text, version: structuredClone(row.version) };
  });
  if (sum > MAX_GOAL_FILES_BYTES) return fail();
  return { root: value.root, rootIdentity: structuredClone(value.rootIdentity), files };
}
type BrokerInput = { root: string; files: string[]; protected: string[]; writable?: string; missing?: boolean; privacy?: boolean; control?: boolean;
  marker?: { identity: GoalFileScope["rootIdentity"]; body: string }; controls?: boolean };
type BrokerScope = { first: NativeSnapshot; call(data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>; close(clean: boolean, keep?: boolean): Promise<boolean> };
const readBatch = new AsyncLocalStorage<{ open(input: BrokerInput, signal?: AbortSignal): Promise<BrokerScope> }>();

/** Invocation-local code/Job reuse only; every read reopens handles and final cleanup precedes owner release. */
export async function withWindowsGoalReadBatch<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (process.platform !== "win32" || readBatch.getStore()) return run();
  let transport: ReturnType<typeof startBroker> | undefined, tail = Promise.resolve(), failed = false, uncertain = false, closed = false;
  const batch = { async open(input: BrokerInput, current?: AbortSignal): Promise<BrokerScope> {
    const frozen = structuredClone(input), previous = tail;
    let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (failed || closed) throw new DirectoryValidationError(GOAL_FILES_ERROR, "helper_unavailable");
      current?.throwIfAborted(); signal?.throwIfAborted();
      const channel = await (transport ??= startBroker(signal));
      const scope = await channel.open(frozen, current, true);
      let closing: Promise<boolean> | undefined;
      return { ...scope, close(clean, keep) {
        return closing ??= (async () => {
          try { const confirmed = await scope.close(clean, keep); if (!confirmed) { failed = true; uncertain = true; } return confirmed; }
          catch (error) { failed = true; uncertain = true; throw error; }
          finally { release(); }
        })();
      } };
    } catch (error) { failed = true; uncertain ||= directoryError(error)?.cleanupConfirmed === false; release(); throw error; }
  } };
  try { return await readBatch.run(batch, run); }
  finally {
    closed = true;
    await tail;
    if (transport) {
      const channel = await transport.catch(() => undefined);
      if (channel && !await channel.shutdown()) uncertain = true;
      if (uncertain) throw new DirectoryValidationError(GOAL_FILES_ERROR, "unknown", false);
    }
  }
}
async function broker(input: BrokerInput, signal?: AbortSignal): Promise<BrokerScope> {
  if (process.platform !== "win32" || !path.isAbsolute(input.root)) throw new DirectoryValidationError(GOAL_FILES_ERROR, "invalid_path");
  if (signal?.aborted) throw new DirectoryValidationError(GOAL_FILES_ERROR, "cancelled");
  const frozen = structuredClone(input), batch = readBatch.getStore();
  if (batch && !input.marker && !input.writable) return batch.open(frozen, signal);
  const channel = await startBroker(signal);
  return channel.open(frozen, signal, false);
}
async function startBroker(signal?: AbortSignal) {
  if (process.platform !== "win32") throw new DirectoryValidationError(GOAL_FILES_ERROR, "invalid_path");
  if (signal?.aborted) throw new DirectoryValidationError(GOAL_FILES_ERROR, "cancelled");
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new DirectoryValidationError(GOAL_FILES_ERROR, "system_root_missing");
  const born = Date.now(), child = windowsGoalFileIO.spawn(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(bootstrap, "utf16le").toString("base64")],
    { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: { SystemRoot: systemRoot, TEMP: process.env.TEMP ?? systemRoot, TMP: process.env.TMP ?? systemRoot } });
  let job: WindowsJob | undefined, pending: { id: number; resolve(value: unknown): void; reject(reason: DirectoryReason): void } | undefined;
  let stopped = false, ended = false, buffer = "", sequence = 0, failureReason: DirectoryReason = "unknown";
  const stop = (reason: DirectoryReason = "helper_protocol") => {
    if (failureReason === "unknown") failureReason = reason;
    stopped = true; pending?.reject(reason); pending = undefined; child.kill("SIGKILL");
  };
  child.stdin.on("error", () => stop("helper_unavailable")); child.once("error", () => stop("helper_unavailable"));
  child.once("close", () => { ended = true; if (pending) stop("helper_unavailable"); });
  child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => {
    buffer += chunk; if (buffer.length > 200000) { stop(); return; }
    for (;;) { const end = buffer.indexOf("\n"); if (end < 0) return; const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      try { const frame = JSON.parse(line);
        if (pending && frame && !Array.isArray(frame) && frame.ok === false && directoryReason(frame.reason) &&
          (frame.id === pending.id || pending.id === 1 && frame.id === 0 && frame.reason === "helper_setup") &&
          Object.keys(frame).length === 3 && Object.keys(frame).every(k => ["id", "ok", "reason"].includes(k))) { stop(frame.reason); return; }
        if (!pending || !frame || Array.isArray(frame) || frame.ok !== true || frame.id !== pending.id || Object.keys(frame).some(k => !["id", "ok", "data"].includes(k))) { stop(); return; }
        const next = pending; pending = undefined; next.resolve(frame.data);
      } catch { stop(); return; }
    }
  });
  const call = (data: Record<string, unknown>, requestSignal = signal): Promise<unknown> => {
    if (!job || stopped || ended || pending || requestSignal?.aborted) return Promise.reject(new Error(GOAL_FILES_ERROR));
    const id = ++sequence, payload = JSON.stringify({ ...data, id }) + "\n";
    if (Buffer.byteLength(payload) > 200000 || id > 1024) return Promise.reject(new Error(GOAL_FILES_ERROR));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => stop("helper_timeout"), 20000), cancelled = () => stop("cancelled");
      const done = () => { clearTimeout(timer); requestSignal?.removeEventListener("abort", cancelled); };
      pending = { id, resolve(value) { done(); resolve(value); }, reject(reason) { done(); reject(new DirectoryValidationError(GOAL_FILES_ERROR, reason, false)); } };
      requestSignal?.addEventListener("abort", cancelled, { once: true }); if (requestSignal?.aborted) { stop(); return; }
      try { child.stdin.write(payload); } catch { stop(); }
    });
  };
  let shutdownPromise: Promise<boolean> | undefined;
  const shutdown = (): Promise<boolean> => shutdownPromise ??= (async () => {
    try { child.stdin.end(); } catch { stop(); }
    try { return await job?.close() === true; } catch { return false; }
  })();
  try { job = await windowsGoalFileIO.own(child, born); signal?.throwIfAborted(); child.stdin.write(Buffer.from(script).toString("base64") + "\n"); }
  catch {
    stop("ownership_refused");
    throw new DirectoryValidationError(GOAL_FILES_ERROR, signal?.aborted ? "cancelled" : "ownership_refused", await shutdown());
  }
  return { shutdown, async open(input: BrokerInput, current = signal, reuse = false): Promise<BrokerScope> {
    try {
      if (!path.isAbsolute(input.root)) throw new DirectoryValidationError(GOAL_FILES_ERROR, "invalid_path");
      const first = snapshot(await call({ ...input, op: "open" }, current), input.controls ? 128 : 16);
      if (path.normalize(first.root).replace(/[\\/]$/, "").toLowerCase() !== path.normalize(input.root).replace(/[\\/]$/, "").toLowerCase() ||
        (!input.missing && first.files.length !== input.files.length) || first.files.length > input.files.length ||
        new Set(first.files.map(row => row.path)).size !== first.files.length || first.files.some(row => !input.files.includes(row.path))) return fail();
      let closing: Promise<boolean> | undefined;
      return { first, call, close(clean, keep = true) {
        return closing ??= (async () => {
          let confirmed = false;
          if (clean && !stopped && !ended) { try { const receipt = await call({ op: "close", keep, reuse }, AbortSignal.timeout(10000)); confirmed = input.marker ? receipt === keep : receipt === undefined; } catch { /* Unknown cleanup. */ } }
          if (!confirmed) stop();
          if (reuse && confirmed) return true;
          return await shutdown() && confirmed;
        })();
      } };
    } catch (error) {
      const reason = current?.aborted ? "cancelled" : directoryError(error)?.reason ?? (failureReason !== "unknown" ? failureReason : "helper_protocol");
      stop(reason);
      throw new DirectoryValidationError(GOAL_FILES_ERROR, reason, await shutdown());
    }
  } };
}
function protectedPaths(protections: GoalFileProtections): string[] {
  const values = [protections.journalDirectory, protections.agentDirectory, fileURLToPath(new URL("../", import.meta.url))];
  if (values.some(value => typeof value !== "string" || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/.test(value))) return fail();
  return values;
}
function matches(actual: NativeSnapshot, scope: GoalFileScope): void {
  if (actual.root !== scope.root || !isDeepStrictEqual(actual.rootIdentity, scope.rootIdentity) || actual.files.length !== scope.files.length) return fail();
  for (const file of scope.files) { const entry = actual.files.find(row => row.path === file.path); if (!entry || !isDeepStrictEqual(entry.version, file.version)) return fail(); }
}
/** Named trusted control-file snapshots, one bounded held-handle batch. No discovery/worker tool. */
export async function snapshotWindowsGoalTexts(values: readonly string[], signal?: AbortSignal) {
  if (!Array.isArray(values) || values.length > 128 || values.some(value => typeof value !== "string" || !path.isAbsolute(value))) return fail();
  if (values.length === 0) return [];
  const paths = [...new Set(values)], io = await broker({ root: path.dirname(paths[0]!), files: paths, protected: [], missing: true, controls: true }, signal);
  try { if (!await io.close(true)) return fail(); signal?.throwIfAborted();
    return values.map(value => { const row = io.first.files.find(x => x.path === value); return row ? { text: row.text, version: structuredClone(row.version) } : null; });
  } catch { await io.close(false); return fail(); }
}
/** Trusted project-owner effect only: one fixed private CreateNew marker, never a worker tool. */
export async function openWindowsGoalProjectOwner(root: string, identity: GoalFileScope["rootIdentity"], text: string, signal?: AbortSignal) {
  if (!Value.Check(FileIdentitySchema, identity) || typeof identity.ino !== "string" || goalTextBytes(text) === 0) return fail();
  const expected = structuredClone(identity), body = Buffer.from(text).toString("base64");
  const io = await broker({ root, files: [".jev-goal.lock"], protected: [], marker: { identity: expected, body } }, signal);
  try {
    const row = io.first.files[0];
    if (!row || row.path !== ".jev-goal.lock" || row.text !== text || !isDeepStrictEqual(io.first.rootIdentity, expected)) return fail();
    signal?.throwIfAborted(); const version = structuredClone(row.version); let closing: Promise<boolean> | undefined;
    return { version,
      close(keep: boolean): Promise<boolean> {
        if (closing) return closing;
        closing = (async () => { if (typeof keep !== "boolean" || !await io.close(true, keep)) return fail(); return keep; })();
        return closing;
      },
    };
  } catch { await io.close(false); return fail(); }
}
export async function canonicalWindowsGoalDirectory(value: string, privacy = false, signal?: AbortSignal) {
  try { const io = await broker({ root: value, files: [], protected: [], privacy }, signal);
    if (!await io.close(true)) throw new DirectoryValidationError(GOAL_FILES_ERROR, "unknown", false);
    return io.first.root;
  } catch (error) {
    const detail = directoryError(error);
    throw new DirectoryValidationError(GOAL_FILES_ERROR, signal?.aborted ? "cancelled" : detail?.reason ?? "helper_unavailable", detail?.cleanupConfirmed ?? false);
  }
}
export async function snapshotWindowsGoalText(value: string, signal?: AbortSignal): Promise<{ text: string; version: GoalFileVersion } | null> {
  try { const io = await broker({ root: path.dirname(value), files: [path.basename(value)], protected: [], missing: true, control: true }, signal);
    if (path.join(io.first.root, path.basename(value)) !== value) { await io.close(false); return fail(); }
    if (!await io.close(true)) return fail(); const row = io.first.files[0]; return row ? { text: row.text, version: row.version } : null;
  } catch { return fail(); }
}
export async function prepareWindowsGoalFileScope(input: GoalFileInput, protections: GoalFileProtections, signal?: AbortSignal): Promise<GoalFileScope> {
  try { if (!validGoalFileInput(input)) return fail(); const job = structuredClone(input);
    const io = await broker({ root: job.cwd, files: job.files.map(x => x.path), protected: protectedPaths(structuredClone(protections)) }, signal);
    try {
      const scope: GoalFileScope = { id: randomUUID(), root: io.first.root, rootIdentity: io.first.rootIdentity,
        files: job.files.map((file, index) => { const row = io.first.files.find(x => x.path === file.path); if (!row) return fail(); return { ...file, id: `file-${index + 1}`, version: row.version }; }) };
      if (!validGoalFileScope(scope)) return fail(); matches(snapshot(await io.call({ op: "read" })), scope); if (!await io.close(true)) return fail(); signal?.throwIfAborted(); return scope;
    }
    catch { await io.close(false); return fail(); }
  } catch { return fail(); }
}
export async function checkWindowsGoalFileScope(scope: GoalFileScope, protections: GoalFileProtections, signal?: AbortSignal): Promise<void> {
  try { if (!validGoalFileScope(scope)) return fail(); const frozen = structuredClone(scope);
    const io = await broker({ root: frozen.root, files: frozen.files.map(x => x.path), protected: protectedPaths(structuredClone(protections)) }, signal);
    try { matches(io.first, frozen); if (!await io.close(true)) return fail(); signal?.throwIfAborted(); }
    catch { await io.close(false); return fail(); }
  } catch { return fail(); }
}
export async function executeWindowsGoalFileEffect(effect: GoalFileIoEffect, protections: GoalFileProtections, signal?: AbortSignal): Promise<GoalFileIoEvent> {
  const scopeId = effect.scope.id, requestId = effect.request.id; let mayHaveWritten = false, io: Awaited<ReturnType<typeof broker>> | undefined;
  try { if (effect.type !== "file_io" || !validGoalFileScope(effect.scope) || !validGoalFileRequest(effect.request)) return fail();
    const { scope, request } = structuredClone(effect), file = scope.files.find(x => x.id === request.fileId);
    if (!file || (request.action !== "read" && file.access !== "read_write")) return fail();
    io = await broker({ root: scope.root, files: scope.files.map(x => x.path), protected: protectedPaths(structuredClone(protections)), ...(request.action !== "read" ? { writable: file.path } : {}) }, signal);
    matches(io.first, scope); const row = io.first.files.find(x => x.path === file.path); if (!row) return fail(); let result: GoalFileIoEvent;
    if (request.action === "read") { matches(snapshot(await io.call({ op: "read" })), scope); result = { type: "file_done", scopeId, requestId, version: row.version, reply: { action: "read", text: row.text } }; }
    else { const replacement = goalFileReplacement(row.text, request), bytes = Buffer.from(replacement);
      if (scope.files.reduce((n, x) => n + x.version.bytes, 0) - file.version.bytes + bytes.length > MAX_GOAL_FILES_BYTES) return fail();
      signal?.throwIfAborted(); mayHaveWritten = true;
      const actual = snapshot(await io.call({ op: "write", path: file.path, prior: file.version.stamp, body: bytes.toString("base64") }));
      const stored = actual.files.find(x => x.path === file.path); if (!stored || stored.text !== replacement || !isDeepStrictEqual(stored.version.identity, file.version.identity)) return fail();
      matches(actual, { ...scope, files: scope.files.map(x => x.id === file.id ? { ...x, version: stored.version } : x) });
      result = { type: "file_done", scopeId, requestId, version: stored.version, reply: { action: request.action, bytes: bytes.length } };
    }
    if (!await io.close(true)) return fail(); signal?.throwIfAborted(); return result;
  } catch { if (io) await io.close(false); return { type: "file_failed", scopeId, requestId, cancelled: signal?.aborted === true, mayHaveWritten }; }
}
