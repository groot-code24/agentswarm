// Browser-only video splitter (ported from the original Video Clipper page).
// Main engine: mediabunny copies compressed frames without re-encoding (a 1-hour video
// splits in seconds). Vertical 9:16 re-encodes with the device's H.264 encoder.
// Fallback: ffmpeg.wasm (served from /vendor) for formats mediabunny can't read, e.g. AVI.

import * as MB from "mediabunny";

export type SplitOptions = { clipLength: number; format: "original" | "vertical" };

export type SplitClip = {
  index: number;
  start: number;
  end: number;
  blob: Blob;
  ext: string;
  width: number | null;
  height: number | null;
};

export type SplitCallbacks = {
  onDuration?: (seconds: number, expectedClips: number) => void;
  onProgress?: (fraction: number) => void;
  onStatus?: (text: string) => void;
  onClip: (clip: SplitClip) => void;
};

const MIN_TAIL = 3; // a leftover shorter than this joins the last clip
const PARALLEL = 2;

export function planRanges(duration: number, clipLen: number) {
  let n = Math.max(1, Math.ceil(duration / clipLen));
  if (n > 1 && duration - (n - 1) * clipLen < MIN_TAIL) n--;
  return Array.from({ length: n }, (_, i) => ({ index: i, start: i * clipLen, end: i === n - 1 ? duration : (i + 1) * clipLen }));
}

export async function probeDuration(file: File): Promise<number | null> {
  const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  try {
    if (!(await input.canRead())) return null;
    return await input.computeDuration();
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}

export function mimeFor(ext: string) {
  return ({ ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska" } as Record<string, string>)[ext] || "video/mp4";
}

export class SplitCancelled extends Error {}

export class Splitter {
  private cancelled = false;
  private active = new Set<MB.Conversion>();
  private ffmpeg: { terminate: () => void } | null = null;

  cancel() {
    this.cancelled = true;
    for (const c of this.active) c.cancel().catch(() => {});
    this.ffmpeg?.terminate();
  }

  async split(file: File, opts: SplitOptions, cb: SplitCallbacks): Promise<{ duration: number }> {
    const handled = await this.withMediabunny(file, opts, cb);
    if (this.cancelled) throw new SplitCancelled();
    if (handled) return handled;
    if (opts.format === "vertical") {
      throw new Error('Vertical 9:16 works with MP4, MOV, WebM and MKV files. Choose "Original shape" for this file.');
    }
    return this.withFFmpeg(file, opts, cb);
  }

  private async withMediabunny(file: File, opts: SplitOptions, cb: SplitCallbacks): Promise<{ duration: number } | null> {
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    try {
      if (!(await input.canRead().catch(() => false))) return null;
      const videoTrack = await input.getPrimaryVideoTrack().catch(() => null);
      const duration = await input.computeDuration().catch(() => 0);
      if (!videoTrack || !duration) return null;

      const ranges = planRanges(duration, opts.clipLength);
      cb.onDuration?.(duration, ranges.length);
      const vertical = opts.format === "vertical";
      let videoOptions: MB.ConversionVideoOptions | undefined;
      let outW = videoTrack.displayWidth;
      let outH = videoTrack.displayHeight;
      if (vertical) {
        const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
        // Keep the source height (max 1920) and center-crop the width, so nothing is upscaled.
        outH = even(Math.min(1920, videoTrack.displayHeight));
        outW = even((outH * 9) / 16);
        if (!(await MB.canEncodeVideo("avc", { width: outW, height: outH }))) {
          throw new Error("This browser can't encode H.264 video, which vertical mode needs. Try Chrome or Edge, or choose \"Original shape\".");
        }
        videoOptions = { width: outW, height: outH, fit: "cover", codec: "avc", bitrate: new MB.Quality("high"), hardwareAcceleration: "prefer-hardware" };
      }
      const copy: MB.ConversionCopyOptions = vertical ? { shiftTolerance: Infinity } : { mode: "forced", shiftTolerance: Infinity };
      let kinds: ("mp4" | "webm" | "mkv")[] = vertical ? ["mp4"] : /\.webm$/i.test(file.name) ? ["webm", "mkv"] : ["mp4", "mkv"];
      const makeOutput = (kind: string) =>
        new MB.Output({
          format: kind === "mp4" ? new MB.Mp4OutputFormat({ fastStart: "in-memory" }) : kind === "webm" ? new MB.WebMOutputFormat() : new MB.MkvOutputFormat(),
          target: new MB.BufferTarget(),
        });

      const inflight = new Map<number, number>();
      let doneSeconds = 0;
      const report = () => {
        let s = doneSeconds;
        for (const [i, p] of inflight) s += p * (ranges[i].end - ranges[i].start);
        cb.onProgress?.(s / duration);
      };

      const cut = async (range: (typeof ranges)[number]) => {
        for (const kind of kinds) {
          const output = makeOutput(kind);
          const conversion = await MB.Conversion.init({
            input,
            output,
            tracks: "primary",
            video: videoOptions,
            copy,
            showWarnings: false,
            trim: { start: range.start, end: range.end },
          });
          if (!conversion.isValid || !conversion.utilizedTracks.includes(videoTrack)) continue;
          kinds = [kind];
          this.active.add(conversion);
          conversion.onProgress = (p) => {
            inflight.set(range.index, p);
            report();
          };
          try {
            await conversion.execute();
          } finally {
            this.active.delete(conversion);
          }
          return { kind, buffer: (output.target as MB.BufferTarget).buffer! };
        }
        return null;
      };

      const emit = (range: (typeof ranges)[number], kind: string, buffer: ArrayBuffer) => {
        inflight.delete(range.index);
        doneSeconds += range.end - range.start;
        report();
        const ext = `.${kind}`;
        cb.onClip({ index: range.index, start: range.start, end: range.end, blob: new Blob([buffer], { type: mimeFor(ext) }), ext, width: outW, height: outH });
      };

      cb.onStatus?.(`Cutting clip 1 of ${ranges.length}...`);
      const first = await cut(ranges[0]);
      if (this.cancelled) return { duration };
      if (!first) return null;
      emit(ranges[0], first.kind, first.buffer);

      let next = 1;
      let done = 1;
      const worker = async () => {
        while (next < ranges.length && !this.cancelled) {
          const range = ranges[next++];
          const result = await cut(range);
          if (this.cancelled) return;
          if (!result) throw new Error(`Could not cut clip ${range.index + 1}.`);
          emit(range, result.kind, result.buffer);
          cb.onStatus?.(`Cut ${++done} of ${ranges.length} clips...`);
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      return { duration };
    } finally {
      input.dispose();
    }
  }

  private async withFFmpeg(file: File, opts: SplitOptions, cb: SplitCallbacks): Promise<{ duration: number }> {
    cb.onStatus?.("This format needs the full video engine. Downloading it (~30 MB, first time only)...");
    // Loaded at runtime from /vendor (copied by scripts/copy-vendor.mjs), bypassing the bundler.
    const load = new Function("u", "return import(u)") as (u: string) => Promise<{ FFmpeg: new () => FFmpegLike }>;
    const { FFmpeg } = await load(new URL("/vendor/ffmpeg/index.js", location.href).href);
    const ff = new FFmpeg();
    this.ffmpeg = ff;
    let onLog: ((m: string) => void) | null = null;
    ff.on("log", ({ message }: { message: string }) => onLog?.(message));
    await ff.load({
      coreURL: new URL("/vendor/ffmpeg-core/ffmpeg-core.js", location.href).href,
      wasmURL: new URL("/vendor/ffmpeg-core/ffmpeg-core.wasm", location.href).href,
    });
    if (this.cancelled) throw new SplitCancelled();

    await ff.createDir("/input").catch(() => {});
    await ff.createDir("/out").catch(() => {});
    await ff.mount("WORKERFS", { files: [file] }, "/input");
    const inputPath = `/input/${file.name}`;
    const parseTime = (s: string) => {
      const [h, m, sec] = s.split(":");
      return +h * 3600 + +m * 60 + parseFloat(sec);
    };

    let duration = 0;
    onLog = (msg) => {
      const m = msg.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
      if (m && !duration) duration = parseTime(m[1]);
    };
    await ff.exec(["-hide_banner", "-i", inputPath]);
    onLog = null;
    if (!duration) throw new Error("Could not read the video length. The file may be corrupted or unsupported.");

    const clipLen = opts.clipLength;
    const total = Math.max(1, Math.ceil((duration - 0.5) / clipLen));
    cb.onDuration?.(duration, total);
    const perBatch = Math.max(1, Math.min(20, Math.floor((300 * 1024 * 1024) / ((file.size / duration) * clipLen))));
    let index = 0;
    for (let first = 0; first < total && !this.cancelled; first += perBatch) {
      const count = Math.min(perBatch, total - first);
      const batchStart = first * clipLen;
      const batchLen = count * clipLen;
      onLog = (msg) => {
        const m = msg.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/);
        if (m) cb.onProgress?.((batchStart + Math.min(parseTime(m[1]), batchLen)) / duration);
      };
      cb.onStatus?.(`Cutting clips ${first + 1}–${first + count} of ${total}...`);
      await ff.exec([
        "-hide_banner", "-y", "-ss", String(batchStart), "-i", inputPath, "-t", String(batchLen),
        "-map", "0:v:0?", "-map", "0:a?", "-c", "copy",
        "-f", "segment", "-segment_time", String(clipLen), "-reset_timestamps", "1",
        "-segment_format_options", "movflags=+faststart",
        "-segment_list", "/out/list.csv", "-segment_list_type", "csv", "/out/seg_%04d.mp4",
      ]);
      onLog = null;
      const csv = (await ff.readFile("/out/list.csv", "utf8").catch(() => "")) as string;
      await ff.deleteFile("/out/list.csv").catch(() => {});
      const segs = csv.trim().split(/\r?\n/).filter(Boolean).map((line) => {
        const [name, s, e] = line.trim().split(",");
        return { name, start: parseFloat(s), end: parseFloat(e) };
      });
      if (!segs.length) throw new Error(`Could not cut this video (clips ${first + 1}–${first + count}).`);
      for (const seg of segs) {
        const data = (await ff.readFile(`/out/${seg.name}`)) as Uint8Array;
        await ff.deleteFile(`/out/${seg.name}`);
        if (seg.end - seg.start < Math.min(1, clipLen / 20) && segs.length > 1) continue;
        cb.onClip({
          index: index++,
          start: Math.max(0, batchStart + seg.start),
          end: Math.min(duration, batchStart + seg.end),
          blob: new Blob([data as BlobPart], { type: "video/mp4" }),
          ext: ".mp4",
          width: null,
          height: null,
        });
      }
    }
    await ff.unmount("/input").catch(() => {});
    if (this.cancelled) throw new SplitCancelled();
    return { duration };
  }
}

type FFmpegLike = {
  on: (event: "log", cb: (e: { message: string }) => void) => void;
  load: (opts: { coreURL: string; wasmURL: string }) => Promise<unknown>;
  exec: (args: string[]) => Promise<number>;
  createDir: (p: string) => Promise<unknown>;
  mount: (type: string, opts: unknown, p: string) => Promise<unknown>;
  unmount: (p: string) => Promise<unknown>;
  readFile: (p: string, enc?: string) => Promise<Uint8Array | string>;
  deleteFile: (p: string) => Promise<unknown>;
  terminate: () => void;
};
