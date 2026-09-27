// Copies the browser builds of ffmpeg.wasm and client-zip into public/vendor
// so the site serves them from its own origin (Vercel runs this as the build step).
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const vendor = join(root, "public", "vendor");

rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });

// @ffmpeg/ffmpeg: ES module wrapper + its worker (must be same-origin).
cpSync(join(nm, "@ffmpeg", "ffmpeg", "dist", "esm"), join(vendor, "ffmpeg"), {
  recursive: true,
  filter: (src) => !src.endsWith(".d.ts") && !src.endsWith(".d.mts"),
});
// @ffmpeg/core: the single-threaded ffmpeg build (no COOP/COEP headers needed).
cpSync(join(nm, "@ffmpeg", "core", "dist", "esm"), join(vendor, "ffmpeg-core"), { recursive: true });
// client-zip: streaming ZIP for "Download all" in browsers without a folder picker.
cpSync(join(nm, "client-zip", "index.js"), join(vendor, "client-zip.js"));

console.log("Vendor files copied to public/vendor");
