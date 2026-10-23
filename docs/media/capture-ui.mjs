// Windows-only offline UI previews: real component output, never a recorded/approved task.
// Run from the source root: bun --no-env-file --no-install --config=src/worker-bunfig.toml --tsconfig-override=tsconfig.json docs/media/capture-ui.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { createHash } from 'node:crypto';

assert.equal(process.platform, 'win32', 'This capture uses existing Windows System.Drawing; no tool/runtime installation.');
assert.equal(process.versions.bun, '1.4.3', 'Use the existing pinned Bun; no runtime fallback.');
const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, '../..');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-ui-preview-'));
const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
assert.ok(system && path.isAbsolute(system));
await fs.mkdir(path.join(work, 'home')); await fs.mkdir(path.join(work, 'agent')); await fs.mkdir(path.join(work, 'tmp'));
// No personal configuration, provider key, shell hook or model request reaches the preview.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: path.dirname(process.execPath), SystemRoot: system,
  HOME: path.join(work, 'home'), USERPROFILE: path.join(work, 'home'), APPDATA: path.join(work, 'home'), LOCALAPPDATA: path.join(work, 'home'),
  TEMP: path.join(work, 'tmp'), TMP: path.join(work, 'tmp'), PI_CODING_AGENT_DIR: path.join(work, 'agent'),
  PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', DO_NOT_TRACK: '1', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Network is forbidden in UI previews.'); };
const sdkEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const sdk = await import(pathToFileURL(sdkEntry).href);
assert.equal(sdk.VERSION, '0.85.1');
const { theme } = await import(new URL('./modes/interactive/theme/theme.js', pathToFileURL(sdkEntry)).href);
const { visibleWidth } = await import(import.meta.resolve('@earendil-works/pi-tui'));
const { renderPlan } = await import('../../src/plan-presentation.ts');
const { confirmNativeTaskReview } = await import('../../src/native-task-review.ts');
const { taskReviewContent } = await import('../../src/task-review-machine.ts');
const { verifyWindows } = await import('../../src/windows-worker-effects.ts');
sdk.initTheme('dark', false);
const columns = 112, frames = [];
const palette = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
function indexed(n) {
  if (n < 16) return palette[n];
  const rgb = n < 232 ? [Math.floor((n - 16) / 36), Math.floor((n - 16) / 6) % 6, (n - 16) % 6].map(v => v ? 55 + v * 40 : 0) : [8 + (n - 232) * 10].flatMap(v => [v, v, v]);
  return '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
}
function segments(line) {
  let fg = '#d8dee9', bg = '#111827', bold = false, dim = false;
  const parts = [];
  line = line.replace(/\x1b[_\]][^\x07]*(?:\x07|\x1b\\)/g, '');
  for (const token of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (!token) continue;
    if (!token.startsWith('\x1b[')) {
      const text = stripVTControlCharacters(token); assert.ok(!text.includes('\x1b'));
      parts.push({ text, width: visibleWidth(text), fg, bg, bold, dim }); continue;
    }
    const codes = token.slice(2, -1).split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const n = codes[i];
      if (n === 0) { fg = '#d8dee9'; bg = '#111827'; bold = false; dim = false; }
      else if (n === 1) bold = true;
      else if (n === 2) dim = true;
      else if (n === 22) { bold = false; dim = false; }
      else if (n === 39) fg = '#d8dee9';
      else if (n === 49) bg = '#111827';
      else if ((n === 38 || n === 48) && codes[i + 1] === 2) {
        const color = '#' + codes.slice(i + 2, i + 5).map(v => v.toString(16).padStart(2, '0')).join('');
        if (n === 38) fg = color; else bg = color; i += 4;
      } else if ((n === 38 || n === 48) && codes[i + 1] === 5) {
        if (n === 38) fg = indexed(codes[i + 2]); else bg = indexed(codes[i + 2]); i += 2;
      } else if (n >= 30 && n <= 37) fg = palette[n - 30];
      else if (n >= 90 && n <= 97) fg = palette[n - 90 + 8];
    }
  }
  assert.equal(parts.reduce((sum, p) => sum + p.width, 0), visibleWidth(stripVTControlCharacters(line)));
  return parts;
}
assert.equal(segments('\x1b[38;2;10;20;30mhi\x1b[39m!')[0].fg, '#0a141e');
assert.equal(segments('<source>')[0].text, '<source>');

function view(stage, tick = 0) {
  const done = stage >= 2, finished = stage === 4;
  return { version: 3, entry: 'inspect', display: { maxDepth: 3, animations: true }, phase: ['approval', 'running', 'checking', 'running', 'finished'][stage],
    elapsedMs: [0, 1200 + tick * 120, 4200, 5500 + tick * 120, 8600][stage], seconds: 120,
    modelCalls: [0, 2, 4, 5, 6][stage], ...(stage === 3 ? { currentTool: 'scope_edit' } : {}),
    nodes: [
      { id: 'inspect', kind: 'task', title: 'Inspect the approved module', after: [], state: stage === 0 ? 'pending' : done ? 'completed_unverified' : 'running', agent: 'scout', model: 'demo/scout', thinking: 'low', modelCalls: done ? 2 : stage ? 1 : 0 },
      { id: 'check', kind: 'task', title: 'Read the declared tests', after: [], state: stage === 0 ? 'pending' : done ? 'completed_unverified' : 'running', agent: 'scout', model: 'demo/scout', thinking: 'low', modelCalls: done ? 2 : stage ? 1 : 0 },
      { id: 'edit', kind: 'task', title: 'Apply the declared file-ID edit', after: ['inspect', 'check'], state: finished ? 'completed_unverified' : stage === 3 ? 'running' : 'waiting', agent: 'worker', model: 'demo/worker', thinking: 'low', modelCalls: finished ? 2 : stage === 3 ? 1 : 0 },
      { id: 'notes', kind: 'info', title: 'Reviewed reference', after: [], state: done ? 'ready' : 'pending' },
    ], edges: [
      { from: 'inspect', to: 'edit', kind: 'dependency', status: done ? 'active' : 'pending' },
      { from: 'check', to: 'edit', kind: 'dependency', status: done ? 'active' : 'pending' },
      { from: 'inspect', to: 'notes', kind: 'produced', status: done ? 'active' : 'pending' },
      { from: 'notes', to: 'edit', kind: 'reference', status: done ? 'active' : 'pending' },
    ] };
}
function capture(name, label, lines, height = 720) {
  assert.ok(lines.length && lines.length <= 70);
  for (const line of lines) assert.ok(visibleWidth(line) <= columns, 'Native line must fit the requested columns.');
  const plain = lines.map(stripVTControlCharacters).join('\n');
  assert.doesNotMatch(plain, /C:\\Users|\/home\/|TYPESAFE_API_KEY|Bearer\s|https?:/);
  const frame = { name, label, width: 1280, height: Math.max(height, 168 + lines.length * 24), rows: lines.map(segments) };
  frames.push(frame); return frame;
}
const stages = [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4];
for (const [i, stage] of stages.entries()) capture(`frame-${String(i).padStart(2, '0')}`, ['EXACT SCOPE / REVIEW', 'TWO READ LANES / IN PARALLEL', 'FRESH BOUNDARY CHECKS', 'EXCLUSIVE FILE-ID MUTATION', 'ENDED / STILL UNVERIFIED'][stage], renderPlan(view(stage, i % 8), columns, theme, true, { tick: i % 8 }));
assert.equal(new Set(frames.map(f => f.height)).size, 1, 'Animation canvas must be stable.');
const review = taskReviewContent({ cwd: '/workspace/demo-project', task: 'Inspect the declared file and update only the approved greeting. Do not delegate further.', seconds: 120, maxModelCalls: 2,
  model: { provider: 'demo', id: 'worker' }, agent: { name: 'worker', description: 'Edit only the approved source.', file: '/profiles/worker.md', systemPrompt: 'Use only the explicit scope. Report unverified completion and any uncertainty.', tools: ['read', 'edit'], model: { provider: 'demo', id: 'worker' }, thinking: 'low' } });
let reviewCaptured = false;
const accepted = await confirmNativeTaskReview(review, { mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => 'synthetic-preview' }, ui: {
  custom: async factory => {
    const component = factory({ requestRender() {}, terminal: { rows: 34, columns } }, theme, { matches: () => false }, () => {});
    component.render(columns);
    for (let i = 0; i < 10; i++) component.handleInput('\x1b[5~');
    const lines = component.render(columns);
    assert.match(lines.map(stripVTControlCharacters).join('\n'), /Model.*demo/);
    capture('source-review', 'NATIVE EXACT-SOURCE REVIEW / NOT SUBMITTED', lines);
    reviewCaptured = true;
    component.dispose?.();
    return false;
  },
} });
assert.equal(accepted, false); assert.equal(reviewCaptured, true); assert.equal(networkAttempts, 0);

const paint = String.raw`
param([string]$Request)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;using System.Collections.Generic;using System.Drawing;using System.Drawing.Imaging;using System.Runtime.InteropServices;
public static class PreviewGif {
 static readonly List<Color> colors=new List<Color>();static readonly Dictionary<int,byte> cache=new Dictionary<int,byte>();
 public static void Init(string[] declared){foreach(string text in declared){Color c=ColorTranslator.FromHtml(text);if(!colors.Exists(v=>v.ToArgb()==c.ToArgb()))colors.Add(c);}for(int r=0;r<6;r++)for(int g=0;g<6;g++)for(int b=0;b<6;b++)if(colors.Count<256)colors.Add(Color.FromArgb(r*51,g*51,b*51));while(colors.Count<256){int v=(colors.Count*29)%256;colors.Add(Color.FromArgb(v,v,v));}}
 public static void Save(Bitmap input,string file){using(Bitmap output=new Bitmap(input.Width,input.Height,PixelFormat.Format8bppIndexed)){
  ColorPalette p=output.Palette;for(int i=0;i<256;i++)p.Entries[i]=colors[i];output.Palette=p;
  Rectangle rect=new Rectangle(0,0,input.Width,input.Height);BitmapData a=input.LockBits(rect,ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb),z=null;
  try{z=output.LockBits(rect,ImageLockMode.WriteOnly,PixelFormat.Format8bppIndexed);if(a.Stride<0||z.Stride<0)throw new InvalidOperationException();byte[] src=new byte[a.Stride*input.Height],dst=new byte[z.Stride*input.Height];Marshal.Copy(a.Scan0,src,0,src.Length);
   for(int y=0;y<input.Height;y++)for(int x=0;x<input.Width;x++){int n=y*a.Stride+x*4,b=src[n],g=src[n+1],r=src[n+2],key=(r<<16)|(g<<8)|b;byte index;if(!cache.TryGetValue(key,out index)){int best=int.MaxValue;index=0;for(int i=0;i<256;i++){int dr=r-colors[i].R,dg=g-colors[i].G,db=b-colors[i].B,d=dr*dr+dg*dg+db*db;if(d<best){best=d;index=(byte)i;}}cache.Add(key,index);}dst[y*z.Stride+x]=index;}Marshal.Copy(dst,0,z.Scan0,dst.Length);
  }finally{input.UnlockBits(a);if(z!=null)output.UnlockBits(z);}output.Save(file,ImageFormat.Gif);
 }}
}
'@
$data=[IO.File]::ReadAllText($Request,[Text.Encoding]::UTF8)|ConvertFrom-Json
[PreviewGif]::Init([string[]]$data.palette)
$brushes=@{}
function Brush([string]$color){if(-not $brushes.ContainsKey($color)){$brushes[$color]=[Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml($color))};return $brushes[$color]}
$normal=[Drawing.Font]::new('Consolas',17,[Drawing.FontStyle]::Regular,[Drawing.GraphicsUnit]::Pixel)
$bold=[Drawing.Font]::new('Consolas',17,[Drawing.FontStyle]::Bold,[Drawing.GraphicsUnit]::Pixel)
$title=[Drawing.Font]::new('Segoe UI',23,[Drawing.FontStyle]::Bold,[Drawing.GraphicsUnit]::Pixel)
$small=[Drawing.Font]::new('Segoe UI',13,[Drawing.FontStyle]::Regular,[Drawing.GraphicsUnit]::Pixel)
$format=[Drawing.StringFormat]::GenericTypographic.Clone();$format.FormatFlags=$format.FormatFlags -bor [Drawing.StringFormatFlags]::MeasureTrailingSpaces
try{foreach($frame in $data.frames){
 if($frame.width -ne 1280 -or $frame.height -gt 2048 -or $frame.rows.Count -gt 70){throw 'Frame bounds'}
 $bitmap=[Drawing.Bitmap]::new([int]$frame.width,[int]$frame.height)
 $g=[Drawing.Graphics]::FromImage($bitmap)
 try{
 $g.TextRenderingHint=[Drawing.Text.TextRenderingHint]::AntiAliasGridFit
 $g.Clear([Drawing.ColorTranslator]::FromHtml('#080d17'))
 $g.FillRectangle((Brush '#111827'),20,20,1240,($frame.height-40))
 $g.DrawRectangle([Drawing.Pens]::DimGray,20,20,1239,($frame.height-41))
 $g.DrawString('jev-subagents  /  Pi TUI',$title,(Brush '#edf2ff'),42,38)
 $g.DrawString('OFFLINE PREVIEW  /  SYNTHETIC DATA',$small,(Brush '#87cfc6'),933,47)
 $g.DrawString([string]$frame.label,$small,(Brush '#9caecb'),44,80)
 $g.DrawLine([Drawing.Pens]::DimGray,42,109,1236,109)
 $cell=$g.MeasureString('M',$normal,1000,$format).Width
 $y=128
 foreach($row in $frame.rows){$x=44;foreach($part in $row){
   $w=[float]$part.width*$cell
   if($part.bg -ne '#111827'){$g.FillRectangle((Brush $part.bg),$x,$y,$w,24)}
   $color=[string]$part.fg
   if($part.dim){$c=[Drawing.ColorTranslator]::FromHtml($color);$color='#{0:x2}{1:x2}{2:x2}' -f ([int]($c.R*0.85)),([int]($c.G*0.85)),([int]($c.B*0.85))}
   $font=if($part.bold){$bold}else{$normal}
   $g.DrawString([string]$part.text,$font,(Brush $color),[Drawing.PointF]::new($x,$y),$format)
   $x+=$w
 };$y+=24}
 $g.DrawString('Actual component output  /  illustrative counters, not a benchmark  /  no execution authority',$small,(Brush '#8b9bb5'),44,($frame.height-49))
 $bitmap.Save((Join-Path $data.output ($frame.name+'.png')),[Drawing.Imaging.ImageFormat]::Png)
 if($frame.name.StartsWith('frame-')){[PreviewGif]::Save($bitmap,(Join-Path $data.output ($frame.name+'.gif')))}
 }finally{$g.Dispose();$bitmap.Dispose()}
}}finally{foreach($b in $brushes.Values){$b.Dispose()};$normal.Dispose();$bold.Dispose();$title.Dispose();$small.Dispose();$format.Dispose()}
`;
await fs.writeFile(path.join(work, 'paint.ps1'), paint);
const colors = [...new Set(['#080d17', '#111827', '#edf2ff', '#87cfc6', '#9caecb', '#8b9bb5', '#696969', ...frames.flatMap(f => f.rows.flatMap(row => row.flatMap(p => [p.fg, p.bg])))])];
assert.ok(colors.length < 40);
await fs.writeFile(path.join(work, 'frames.json'), JSON.stringify({ output: work, frames, palette: colors }));
const ps = path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const env = { ...process.env, JEV_BUN_EXECUTABLE: process.execPath };
const result = await verifyWindows(root, { command: ps, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(work, 'paint.ps1'), path.join(work, 'frames.json')], description: 'Render only synthetic documentation frames.' }, env, AbortSignal.timeout(60000), 30000);
assert.equal(result.type, 'verified'); assert.equal(result.result?.status, 'passed', `Image rendering/owned cleanup failed; retained ${work}`);

function imageBlock(bytes) {
  assert.match(bytes.subarray(0, 6).toString(), /^GIF8[79]a$/);
  let offset = 13;
  const packed = bytes[10], global = packed & 128 ? bytes.subarray(offset, offset += 3 * (1 << ((packed & 7) + 1))) : Buffer.alloc(0);
  const blocks = () => { for (;;) { const n = bytes[offset++]; assert.ok(n !== undefined); if (!n) return; offset += n; assert.ok(offset <= bytes.length); } };
  while (bytes[offset] === 0x21) { offset += 2; blocks(); }
  assert.equal(bytes[offset], 0x2c);
  const descriptor = Buffer.from(bytes.subarray(offset, offset + 10)); offset += 10;
  let colors;
  if (descriptor[9] & 128) { const n = 3 * (1 << ((descriptor[9] & 7) + 1)); colors = bytes.subarray(offset, offset += n); }
  else { assert.ok(global.length); colors = global; descriptor[9] = (descriptor[9] & 0x78) | 128 | (packed & 7); }
  const start = offset; offset++; blocks();
  assert.equal(bytes[offset], 0x3b, 'Exactly one encoded frame is expected.');
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), data: Buffer.concat([descriptor, colors, bytes.subarray(start, offset)]) };
}
const images = await Promise.all(stages.map((_, i) => fs.readFile(path.join(work, `frame-${String(i).padStart(2, '0')}.gif`)).then(imageBlock)));
const screen = Buffer.alloc(7); screen.writeUInt16LE(1280); screen.writeUInt16LE(frames[0].height, 2);
const gif = [Buffer.from('GIF89a'), screen, Buffer.from([0x21, 0xff, 11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3, 1, 0, 0, 0])];
for (const [i, image] of images.entries()) {
  assert.equal(image.width, 1280); assert.equal(image.height, frames[0].height);
  const control = Buffer.from([0x21, 0xf9, 4, 4, 0, 0, 0, 0]); control.writeUInt16LE(i === images.length - 1 ? 160 : 18, 4);
  gif.push(control, image.data);
}
gif.push(Buffer.from([0x3b]));
const animation = Buffer.concat(gif); assert.ok(animation.length < 1024 * 1024);
await fs.writeFile(path.join(work, 'workflow.gif'), animation);
const validate = String.raw`param([string]$Image,[int]$Expected)
$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Drawing
$i=[Drawing.Image]::FromFile($Image)
try{if($i.GetFrameCount([Drawing.Imaging.FrameDimension]::Time) -ne $Expected -or $i.Width -ne 1280){throw 'Invalid animation'};for($n=0;$n -lt $Expected;$n++){$null=$i.SelectActiveFrame([Drawing.Imaging.FrameDimension]::Time,$n)}}finally{$i.Dispose()}`;
await fs.writeFile(path.join(work, 'validate.ps1'), validate);
const decoded = await verifyWindows(root, { command: ps, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(work, 'validate.ps1'), path.join(work, 'workflow.gif'), String(images.length)], description: 'Decode the generated GIF frames only.' }, env, AbortSignal.timeout(60000), 30000);
assert.equal(decoded.type, 'verified'); assert.equal(decoded.result?.status, 'passed'); assert.equal(networkAttempts, 0);
const names = [['task-tree.png', 'frame-06.png'], ['source-review.png', 'source-review.png'], ['ended-unverified.png', 'frame-24.png'], ['workflow.gif', 'workflow.gif']];
const assets = [];
for (const [name, source] of names) {
  const bytes = await fs.readFile(path.join(work, source));
  if (name.endsWith('.png')) { assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); assert.equal(bytes.readUInt32BE(16), 1280); }
  await fs.writeFile(path.join(output, name), bytes);
  assets.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const sources = ['src/plan-presentation.ts', 'src/context-approval.ts', 'src/native-task-review.ts', 'src/task-review-machine.ts'];
const sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
const report = { kind: 'offline_native_ui_previews', sdk: sdk.VERSION, columns, sourceSha256, renderer: 'Actual renderPlan + native exact-source editor, rasterized with Windows System.Drawing/Consolas',
  syntheticData: true, screenRecording: false, liveModels: false, approvalGranted: false, networkAttempts, animationFrames: images.length, systemToolsOnly: true,
  ownershipCleanupConfirmed: true, assets, limitations: ['Illustrative counters/timing, not a benchmark or real task result.', 'Documentation frame is not the full Pi terminal or physical user acceptance.', 'Existing release tag and ZIP are not altered.'] };
await fs.writeFile(path.join(output, 'preview-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
await fs.rm(work, { recursive: true, force: true });
