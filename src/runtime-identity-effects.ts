import fs from "node:fs";
import { fileURLToPath } from "node:url";

export type RuntimeIdentity = { readonly packageRoot: string | null; readonly packageVersion: string | null };

/** Own code metadata only; never an active-tool owner, freshness receipt or grant. */
export function readRuntimeIdentity(moduleUrl: string): RuntimeIdentity {
  let packageRoot: string | null = null, packageVersion: string | null = null, fd: number | undefined;
  try {
    const root = new URL("../", moduleUrl), manifest = new URL("package.json", root);
    packageRoot = fileURLToPath(root);
    if (fs.lstatSync(manifest).isFile()) {
      fd = fs.openSync(manifest, "r");
      const bytes = Buffer.alloc(32769), length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (length <= 32768) {
        const value: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
        const version: unknown = value && typeof value === "object" && !Array.isArray(value)
          ? Object.getOwnPropertyDescriptor(value, "version")?.value : undefined;
        if (typeof version === "string" && version.length <= 64 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) packageVersion = version;
      }
    }
  } catch { /* Missing/invalid own metadata stays unknown; no private filesystem error echo. */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { packageVersion = null; } } }
  return { packageRoot, packageVersion };
}
