// Copies ffmpeg.wasm into public/vendor. It is the fallback splitter for formats
// mediabunny can't read (e.g. AVI) and must be served from our own origin.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const vendor = join(root, "public", "vendor");

if (!existsSync(join(nm, "@ffmpeg", "core"))) {
  console.warn("ffmpeg.wasm not installed; skipping vendor copy (AVI fallback disabled).");
  process.exit(0);
}
rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });
cpSync(join(nm, "@ffmpeg", "ffmpeg", "dist", "esm"), join(vendor, "ffmpeg"), {
  recursive: true,
  filter: (src) => !src.endsWith(".d.ts") && !src.endsWith(".d.mts"),
});
cpSync(join(nm, "@ffmpeg", "core", "dist", "esm"), join(vendor, "ffmpeg-core"), { recursive: true });
console.log("Vendor files copied to public/vendor");
