import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { open, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

// Public binary downloads only; bounded, anonymous, no retries, no raw URLs/errors in diagnostics.
export function allowedGpuDownload(url: URL): boolean {
  const host = url.hostname;
  return url.protocol === "https:" && !url.username && !url.password && !url.hash && (!url.port || url.port === "443") &&
    (host === "github.com" || host === "codeload.github.com" || host === "release-assets.githubusercontent.com" || host === "objects.githubusercontent.com" ||
      host === "huggingface.co" || host === "cdn-lfs.huggingface.co" || host === "cdn-lfs-us-1.hf.co" || host === "us.aws.cdn.hf.co" || host === "cas-bridge.xethub.hf.co");
}
function gpuDownloadURL(value: string, base?: URL): URL {
  try { const url = new URL(value, base); if (!allowedGpuDownload(url)) throw new Error(); return url; }
  catch { throw new Error("Unsupported download target."); }
}
export async function noLinks(filename: string): Promise<void> {
  let current = path.resolve(filename);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Linked install path."); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new Error("Unsafe install path."); }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
export async function downloadGpuFile(url: string, filename: string, maxBytes: number, signal: AbortSignal, expected?: string): Promise<string> {
  await noLinks(filename);
  await mkdir(path.dirname(filename), { recursive: true });
  await noLinks(filename);
  const parent = await realpath(path.dirname(filename));
  if (path.resolve(parent) !== path.resolve(path.dirname(filename))) throw new Error("Changed install path.");
  let target = gpuDownloadURL(url), response: Response | undefined;
  for (let redirect = 0; redirect <= 5; redirect++) {
    const r = await fetch(gpuDownloadURL(target.href), { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(r.status)) { response = r; break; }
    await r.body?.cancel();
    const location = r.headers.get("location"); if (!location) throw new Error("Download redirect failed.");
    target = gpuDownloadURL(location, target);
  }
  if (!response?.ok || !response.body) { await response?.body?.cancel(); throw new Error("Public download failed."); }
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body.cancel(); throw new Error("Download bound."); }
  let handle;
  try { handle = await open(filename, "wx", 0o600); } catch { await response.body.cancel(); throw new Error("Install file exists or is unavailable; retained for review."); }
  const hash = createHash("sha256"), reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      if (signal.aborted || (bytes += result.value.byteLength) > maxBytes) throw new Error("Download stopped.");
      hash.update(result.value);
      // FileHandle.write may be partial, unlike writeFile.
      let offset = 0;
      while (offset < result.value.byteLength) { const written = await handle.write(result.value, offset, result.value.byteLength - offset); if (!written.bytesWritten) throw new Error("Download write failed."); offset += written.bytesWritten; }
    }
    const digest = hash.digest("hex"); if (!bytes || expected && digest !== expected) throw new Error("Download digest mismatch.");
    await handle.sync(); return digest;
  } finally { await reader.cancel().catch(() => {}); await handle.close(); }
}
/** Decode exactly one uv.exe, not general archive paths. Call only after the whole zip SHA256 matched. */
export function uvExecutable(zip: Buffer): Buffer {
  if (zip.length < 22 || zip.length > 24 * 1024 ** 2) throw new Error("Invalid uv archive.");
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break; }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) throw new Error("Invalid uv archive.");
  const count = zip.readUInt16LE(end + 10), size = zip.readUInt32LE(end + 12); let position = zip.readUInt32LE(end + 16), found: Buffer | undefined;
  if (count < 1 || count > 32 || position + size !== end) throw new Error("Invalid uv archive.");
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || zip.readUInt32LE(position) !== 0x02014b50) throw new Error("Invalid uv archive.");
    const nameLength = zip.readUInt16LE(position + 28), extra = zip.readUInt16LE(position + 30), comment = zip.readUInt16LE(position + 32), next = position + 46 + nameLength + extra + comment;
    if (next > end) throw new Error("Invalid uv archive.");
    const name = zip.subarray(position + 46, position + 46 + nameLength).toString("utf8");
    if (name === "uv.exe" || name === "uv-x86_64-pc-windows-msvc/uv.exe") {
      if (found || zip.readUInt16LE(position + 8) & 1) throw new Error("Invalid uv archive.");
      const method = zip.readUInt16LE(position + 10), compressed = zip.readUInt32LE(position + 20), unpacked = zip.readUInt32LE(position + 24), local = zip.readUInt32LE(position + 42);
      if (local + 30 > end || zip.readUInt32LE(local) !== 0x04034b50 || unpacked > 80 * 1024 ** 2 || unpacked < 2) throw new Error("Invalid uv archive.");
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      if (start + compressed > zip.readUInt32LE(end + 16)) throw new Error("Invalid uv archive.");
      const data = zip.subarray(start, start + compressed);
      found = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data, { maxOutputLength: 80 * 1024 ** 2 }) : undefined;
      if (!found || found.length !== unpacked || found.subarray(0, 2).toString() !== "MZ") throw new Error("Invalid uv executable.");
    }
    position = next;
  }
  if (position !== end || !found) throw new Error("Missing uv executable."); return found;
}
