"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { DateTime } from "luxon";
import { api } from "./api";
import Icon from "./Icon";
import type { UploadTarget } from "@/lib/storage";
import { Splitter, SplitCancelled, planRanges, probeDuration, mimeFor, type SplitClip } from "@/lib/splitter-client";
import { captureFrames } from "@/lib/frames-client";

type Account = { id: string; platform: "youtube" | "instagram"; name: string; status: string };
type Prefs = { recommendedClipLength?: number; recommendedFormat?: "original" | "vertical" };
type Mode = "automation" | "manual";
type Format = "original" | "vertical";
type SeoMode = "optimize" | "as_written";
type SeoEngine = "claude" | "gemini" | "rules";
const ENGINE_LABEL: Record<SeoEngine, string> = { claude: "Claude AI", gemini: "Gemini AI", rules: "built-in writer" };

type ClipItem = SplitClip & {
  url: string;
  clipId?: string;
  uploaded?: boolean;
  postState?: "choosing" | "posting" | "done" | "error";
  postResult?: { platform: string; status: string; permalink: string | null; last_error: string | null }[];
  postError?: string;
  selectedAccounts?: string[];
  seoTitle?: string;
  seoHashtags?: string[];
};

type AccountPlan = {
  accountId: string;
  platform: string;
  accountName: string;
  hoursLabel: string;
  basis: string;
  slots: { clipIndex: number; at: string }[];
  firstAt: string | null;
  lastAt: string | null;
};

const CLIP_LENGTHS = [
  { v: 15, label: "15 seconds" },
  { v: 30, label: "30 seconds" },
  { v: 45, label: "45 seconds" },
  { v: 60, label: "60 seconds (Shorts & Reels)" },
  { v: 90, label: "90 seconds (Reels)" },
  { v: 120, label: "2 minutes" },
  { v: 180, label: "3 minutes (Shorts & Reels max)" },
];

function fmtBytes(n: number) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtTime(sec: number) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function fmtSpan(sec: number) {
  if (sec < 10) return `${sec.toFixed(1)}s`;
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}

export default function UploadStudio(props: {
  accounts: Account[];
  prefs: Prefs;
  queueUsed: number;
  queueCap: number;
  timezone: string;
  seoEngine: SeoEngine;
}) {
  const { accounts, prefs, timezone } = props;
  const okAccounts = accounts.filter((a) => a.status === "ok");

  // ----- choices (nothing pre-selected) -----
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [clipLength, setClipLength] = useState<number | null>(null);
  const [format, setFormat] = useState<Format | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [postsPerDay, setPostsPerDay] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [seoMode, setSeoMode] = useState<SeoMode | null>(null);
  const [topic, setTopic] = useState("");
  const [language, setLanguage] = useState("");
  const [seoWarning, setSeoWarning] = useState("");

  // ----- progress -----
  type Phase = "setup" | "splitting" | "split" | "uploading" | "planned" | "scheduled";
  const [phase, setPhase] = useState<Phase>("setup");
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [expected, setExpected] = useState(0);
  const [fraction, setFraction] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [timer, setTimer] = useState({ elapsed: 0, eta: null as number | null, speed: null as number | null, done: false });
  const [uploadInfo, setUploadInfo] = useState({ done: 0, total: 0, skipped: 0 });
  const [plans, setPlans] = useState<AccountPlan[] | null>(null);
  // A ref, not state: the upload steps run inside one async flow and must see the latest value.
  const sourceRef = useRef<string | null>(null);
  const [created, setCreated] = useState(0);
  const splitterRef = useRef<Splitter | null>(null);
  const t0 = useRef(0);
  const fracRef = useRef(0);
  const durRef = useRef(0);
  const dragRef = useRef<HTMLDivElement>(null);
  const clipsRef = useRef<ClipItem[]>([]);
  clipsRef.current = clips;

  const busy = phase === "splitting" || phase === "uploading";
  const ready =
    Boolean(file) &&
    clipLength != null &&
    format != null &&
    mode != null &&
    seoMode != null &&
    (mode === "manual" || (accountIds.length > 0 && postsPerDay != null));

  // Warn before leaving while work would be lost.
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (busy || (clips.length > 0 && phase !== "scheduled")) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [busy, clips.length, phase]);

  // Bring the plan into view when it's ready for review.
  useEffect(() => {
    if (phase === "planned") document.getElementById("plan-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [phase]);

  // Free the in-memory clip previews when leaving the page.
  useEffect(() => () => clipsRef.current.forEach((c) => URL.revokeObjectURL(c.url)), []);

  function chooseFile(f: File | undefined) {
    if (!f || busy) return;
    setFile(f);
    setDuration(null);
    setError("");
    reset();
    probeDuration(f).then(setDuration);
  }

  function reset() {
    clipsRef.current.forEach((c) => URL.revokeObjectURL(c.url));
    setClips([]);
    setPlans(null);
    sourceRef.current = null;
    setPhase("setup");
    setFraction(0);
    setStatus("");
    setCreated(0);
  }

  function chooseMode(m: Mode) {
    setMode(m);
    // Decision: in Automation mode every clip goes to all connected accounts; untick to skip one.
    if (m === "automation" && accountIds.length === 0) setAccountIds(okAccounts.map((a) => a.id));
  }

  // ----- splitting -----
  async function split() {
    if (!file || !ready) return;
    reset();
    setError("");
    setPhase("splitting");
    t0.current = performance.now();
    fracRef.current = 0;
    durRef.current = duration ?? 0;
    const tick = setInterval(() => {
      const elapsed = (performance.now() - t0.current) / 1000;
      const f = fracRef.current;
      setTimer({
        elapsed,
        eta: f > 0.02 && elapsed > 0.5 ? (elapsed / f) * (1 - f) : null,
        speed: f > 0.02 && durRef.current ? (durRef.current * f) / elapsed : null,
        done: false,
      });
    }, 250);
    const splitter = new Splitter();
    splitterRef.current = splitter;
    // Collected synchronously: the steps after splitting must see every clip, even the ones
    // React hasn't rendered yet.
    const collected: ClipItem[] = [];
    try {
      const { duration: d } = await splitter.split(file, { clipLength: clipLength!, format: format! }, {
        onDuration: (sec, n) => {
          durRef.current = sec;
          setDuration(sec);
          setExpected(n);
        },
        onProgress: (f) => {
          fracRef.current = Math.max(fracRef.current, f);
          setFraction(fracRef.current);
        },
        onStatus: setStatus,
        onClip: (c) => {
          collected.push({ ...c, url: URL.createObjectURL(c.blob) });
          collected.sort((a, b) => a.index - b.index);
          clipsRef.current = [...collected];
          setClips(clipsRef.current);
        },
      });
      const took = (performance.now() - t0.current) / 1000;
      setTimer({ elapsed: took, eta: null, speed: d / took, done: true });
      setFraction(1);
      setStatus(`Done! ${collected.length} clips ready in ${fmtSpan(took)}.`);
      setPhase("split");
      if (mode === "automation") await uploadAndPlan(d);
    } catch (err) {
      if (err instanceof SplitCancelled) {
        setStatus("Cancelled.");
        setPhase(clipsRef.current.length ? "split" : "setup");
      } else {
        setError((err as Error).message);
        setPhase(clipsRef.current.length ? "split" : "setup");
      }
    } finally {
      clearInterval(tick);
      splitterRef.current = null;
    }
  }

  // ----- cloud upload -----
  async function ensureSource(totalDuration: number): Promise<string> {
    if (sourceRef.current) return sourceRef.current;
    const { id } = await api<{ id: string }>("/api/sources", "POST", {
      filename: file!.name,
      duration: totalDuration || durRef.current || 1,
      mode,
      accountIds: mode === "automation" ? accountIds : [],
      clipLength,
      format,
      postsPerDay: mode === "automation" ? postsPerDay : null,
      title,
      description,
      hashtags,
      seoMode,
      topic,
      language,
    });
    sourceRef.current = id;
    return id;
  }

  async function uploadClips(source: string, items: ClipItem[], onEach?: () => void): Promise<Map<number, string>> {
    const { clips: registered } = await api<{ clips: { idx: number; clipId: string; upload: UploadTarget }[] }>("/api/clips", "POST", {
      sourceVideoId: source,
      clips: items.map((c) => ({
        idx: c.index,
        bytes: c.blob.size,
        duration: c.end - c.start,
        startSec: c.start,
        width: c.width,
        height: c.height,
        contentType: c.blob.type || mimeFor(c.ext),
        ext: c.ext,
      })),
    });
    const byIdx = new Map(items.map((c) => [c.index, c]));
    const queue = [...registered];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        const clip = byIdx.get(r.idx)!;
        const contentType = clip.blob.type || mimeFor(clip.ext);
        if (r.upload.kind === "vercel-blob") {
          // Vercel Blob: upload with the short-lived token the server issued for exactly this file.
          const { put } = await import("@vercel/blob/client");
          await put(r.upload.pathname, clip.blob, {
            access: "public",
            token: r.upload.token,
            contentType,
            multipart: clip.blob.size > 100 * 1024 * 1024,
          }).catch((err: Error) => {
            throw new Error(`Upload of clip ${r.idx + 1} failed: ${err.message}`);
          });
        } else {
          const res = await fetch(r.upload.url, { method: "PUT", body: clip.blob, headers: { "Content-Type": contentType } });
          if (!res.ok) throw new Error(`Upload of clip ${r.idx + 1} failed (${res.status}). Check the storage CORS settings.`);
        }
        onEach?.();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const confirm = await api<{ ok: boolean; missing: string[] }>("/api/clips/confirm", "POST", { clipIds: registered.map((r) => r.clipId) });
    if (!confirm.ok) throw new Error(`${confirm.missing.length} clip(s) didn't arrive in storage. Try again.`);
    const ids = new Map(registered.map((r) => [r.idx, r.clipId]));
    setClips((prev) => (clipsRef.current = prev.map((c) => (ids.has(c.index) ? { ...c, clipId: ids.get(c.index), uploaded: true } : c))));
    return ids;
  }

  // Optimized titles/descriptions/tags: a few clips per request, each with two small frames.
  async function writeSeo(source: string, items: ClipItem[], ids: Map<number, string>, quiet = false) {
    const todo = items.filter((c) => ids.has(c.index) && !c.seoTitle);
    const BATCH = 6;
    let done = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      if (!quiet) setStatus(`Writing titles, descriptions & tags (${ENGINE_LABEL[props.seoEngine]})… ${done}/${todo.length}`);
      const payload = [];
      for (const c of batch) {
        payload.push({ clipId: ids.get(c.index)!, frames: props.seoEngine === "rules" ? [] : await captureFrames(c.url) });
      }
      const res = await api<{ warning: string | null; clips: { clipId: string; title: string; hashtags: string[] }[] }>("/api/seo", "POST", {
        sourceVideoId: source,
        clips: payload,
      });
      if (res.warning) setSeoWarning(res.warning);
      const byIndex = new Map(batch.map((c) => [c.index, res.clips.find((r) => r.clipId === ids.get(c.index))]));
      setClips(
        (prev) =>
          (clipsRef.current = prev.map((c) => {
            const r = byIndex.get(c.index);
            return r ? { ...c, seoTitle: r.title, seoHashtags: r.hashtags } : c;
          })),
      );
      done += batch.length;
    }
  }

  async function uploadAndPlan(totalDuration: number) {
    setPhase("uploading");
    setError("");
    try {
      const all = clipsRef.current.filter((c) => !c.uploaded);
      // Keep within the per-member storage limit: schedule what fits, in order.
      let room = props.queueCap - props.queueUsed;
      const fits: ClipItem[] = [];
      for (const c of all) {
        if (c.blob.size > room) break;
        fits.push(c);
        room -= c.blob.size;
      }
      if (!fits.length && all.length) throw new Error(`Your clip queue is full (${fmtBytes(props.queueUsed)} of ${fmtBytes(props.queueCap)}). Wait until some clips are posted, then try again.`);
      setUploadInfo({ done: 0, total: fits.length, skipped: all.length - fits.length });
      setStatus(`Uploading ${fits.length} clips to the cloud...`);
      const source = await ensureSource(totalDuration);
      let done = 0;
      const ids = await uploadClips(source, fits, () => setUploadInfo((u) => ({ ...u, done: ++done })));
      if (seoMode === "optimize") await writeSeo(source, fits, ids);
      setStatus("Working out the best posting times...");
      const { plans } = await api<{ plans: AccountPlan[] }>("/api/plan", "POST", { sourceVideoId: source, commit: false });
      setPlans(plans);
      setPhase("planned");
      setStatus("Review the plan below, then confirm.");
    } catch (err) {
      setError((err as Error).message);
      setPhase("split");
    }
  }

  async function confirmPlan() {
    if (!sourceRef.current) return;
    setError("");
    try {
      const res = await api<{ created: number; plans: AccountPlan[] }>("/api/plan", "POST", { sourceVideoId: sourceRef.current, commit: true });
      setCreated(res.created);
      setPlans(res.plans);
      setPhase("scheduled");
      setStatus("Scheduled!");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // ----- manual: post now -----
  const updateClip = useCallback((index: number, patch: Partial<ClipItem>) => {
    setClips((prev) => (clipsRef.current = prev.map((c) => (c.index === index ? { ...c, ...patch } : c))));
  }, []);

  async function postNow(clip: ClipItem) {
    const chosen = clip.selectedAccounts ?? [];
    if (!chosen.length) return;
    updateClip(clip.index, { postState: "posting", postError: undefined });
    try {
      const source = await ensureSource(durRef.current);
      let clipId = clip.clipId;
      if (!clipId) clipId = (await uploadClips(source, [clip])).get(clip.index);
      if (seoMode === "optimize" && !clip.seoTitle && clipId) await writeSeo(source, [clip], new Map([[clip.index, clipId]]), true);
      const { posts } = await api<{ posts: ClipItem["postResult"] }>("/api/post-now", "POST", { clipId, accountIds: chosen });
      updateClip(clip.index, { postState: "done", postResult: posts, clipId });
    } catch (err) {
      updateClip(clip.index, { postState: "error", postError: (err as Error).message });
    }
  }

  function downloadClip(c: ClipItem) {
    const a = document.createElement("a");
    a.href = c.url;
    a.download = `${(file?.name || "video").replace(/\.[^.]+$/, "")}_clip_${String(c.index + 1).padStart(3, "0")}${c.ext}`;
    a.click();
  }

  const accountLabel = (a: Account) => `${a.platform === "youtube" ? "YouTube" : "Instagram"} · ${a.name}`;
  const expectedClips = duration && clipLength ? planRanges(duration, clipLength).length : null;

  return (
    <div className="stack">
      {/* 1. File */}
      <div
        ref={dragRef}
        className="drop-zone"
        role="button"
        tabIndex={0}
        onClick={() => !busy && document.getElementById("file-input")?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && document.getElementById("file-input")?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          dragRef.current?.classList.add("dragover");
        }}
        onDragLeave={() => dragRef.current?.classList.remove("dragover")}
        onDrop={(e) => {
          e.preventDefault();
          dragRef.current?.classList.remove("dragover");
          chooseFile(e.dataTransfer.files[0]);
        }}
      >
        <span className="dz-icon"><Icon name={file ? "film" : "upload"} size={24} /></span>
        {file ? (
          <>
            <div className="dz-title">{file.name}</div>
            <div className="small muted">
              {fmtBytes(file.size)}
              {duration ? ` · ${fmtTime(duration)}` : ""}
              {expectedClips ? ` · ${expectedClips} clips` : ""} · click to choose a different file
            </div>
          </>
        ) : (
          <>
            <div className="dz-title">Drop a video here, or click to browse</div>
            <div className="small muted">MP4, MOV, WebM, MKV or AVI · the full video stays on your device; only clips are uploaded</div>
          </>
        )}
        <input id="file-input" type="file" hidden accept="video/*,.mkv,.avi,.m4v,.mov" onChange={(e) => chooseFile(e.target.files?.[0])} />
      </div>

      {/* 2. Settings */}
      <div className="card">
      <fieldset disabled={busy || phase === "planned" || phase === "scheduled"} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="two-col">
          <label className="field">
            <span>Clip length</span>
            <select value={clipLength ?? ""} onChange={(e) => setClipLength(e.target.value ? Number(e.target.value) : null)} style={{ width: "100%" }}>
              <option value="">Choose…</option>
              {CLIP_LENGTHS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                  {prefs.recommendedClipLength === o.v ? " ★ recommended" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Format</span>
            <div className="choice-row">
              <label className="choice">
                <input type="radio" name="format" checked={format === "original"} onChange={() => setFormat("original")} />
                Original shape (fastest)
                {prefs.recommendedFormat === "original" && <span className="badge rec">recommended</span>}
              </label>
              <label className="choice">
                <input type="radio" name="format" checked={format === "vertical"} onChange={() => setFormat("vertical")} />
                Vertical 9:16 (slower)
                {prefs.recommendedFormat === "vertical" && <span className="badge rec">recommended</span>}
              </label>
            </div>
          </div>
        </div>

        <div className="field">
          <span>Mode</span>
          <div className="choice-row">
            <label className="choice">
              <input type="radio" name="mode" checked={mode === "automation"} onChange={() => chooseMode("automation")} disabled={!okAccounts.length} />
              Automation: schedule and post automatically
            </label>
            <label className="choice">
              <input type="radio" name="mode" checked={mode === "manual"} onChange={() => chooseMode("manual")} />
              Manual: I&apos;ll download or post clips myself
            </label>
          </div>
          {!okAccounts.length && (
            <div className="small muted" style={{ marginTop: 6 }}>
              Automation needs a connected account. <Link href="/settings">Connect YouTube or Instagram</Link>.
            </div>
          )}
        </div>

        {mode === "automation" && (
          <div className="two-col">
            <div className="field">
              <span>Post to</span>
              <div className="choice-row">
                {okAccounts.map((a) => (
                  <label key={a.id} className="choice">
                    <input
                      type="checkbox"
                      checked={accountIds.includes(a.id)}
                      onChange={(e) => setAccountIds((ids) => (e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id)))}
                    />
                    {accountLabel(a)}
                  </label>
                ))}
              </div>
            </div>
            <label className="field">
              <span>Posts per day (at the best times for each account)</span>
              <select value={postsPerDay ?? ""} onChange={(e) => setPostsPerDay(e.target.value ? Number(e.target.value) : null)} style={{ width: "100%" }}>
                <option value="">Choose…</option>
                <option value="2">2 per day</option>
                <option value="3">3 per day</option>
                <option value="4">4 per day</option>
                <option value="5">5 per day</option>
              </select>
              {postsPerDay && expectedClips ? (
                <div className="small muted" style={{ marginTop: 6 }}>
                  {expectedClips} clips at {postsPerDay} per day ≈ {Math.ceil(expectedClips / postsPerDay)} days of posts.
                </div>
              ) : null}
            </label>
          </div>
        )}

        {mode && (
          <div className="field">
            <span>Titles, descriptions &amp; tags</span>
            <div className="choice-row">
              <label className="choice">
                <input type="radio" name="seo" checked={seoMode === "optimize"} onChange={() => setSeoMode("optimize")} />
                Write them for me, optimized for views ({ENGINE_LABEL[props.seoEngine]})
              </label>
              <label className="choice">
                <input type="radio" name="seo" checked={seoMode === "as_written"} onChange={() => setSeoMode("as_written")} />
                Use my title &amp; description as written
              </label>
            </div>
            {seoMode === "optimize" && (
              <div className="small muted" style={{ marginTop: 6 }}>
                {props.seoEngine === "rules" ? (
                  <>
                    Each clip gets its own hook title, description, keyword tags and 3–5 hashtags, built from your topic. For titles written
                    from what&apos;s actually in each clip, add a free Gemini key (SETUP.md, step 5b).
                  </>
                ) : (
                  <>
                    {ENGINE_LABEL[props.seoEngine]} looks at two frames of every clip and writes its own hook title, description, keyword tags
                    and 3–5 hashtags. You can edit any of them on the Schedule page before they go out.
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {mode && seoMode === "optimize" && (
          <div className="two-col">
            <label className="field">
              <span>What is the video about? (names, show, game, niche: helps pick keywords)</span>
              <input type="text" maxLength={200} value={topic} placeholder="e.g. Frozen 2 best scenes, Elsa and Anna" onChange={(e) => setTopic(e.target.value)} />
            </label>
            <label className="field">
              <span>Language of titles &amp; captions (optional)</span>
              <input type="text" maxLength={40} value={language} placeholder="English, Hindi, Hinglish…" onChange={(e) => setLanguage(e.target.value)} />
            </label>
          </div>
        )}

        {mode && (
          <div className="two-col">
            <label className="field">
              <span>
                {seoMode === "optimize" ? "Series title (optional, used as context)" : "Title (optional; \"Part 1, 2, …\" is added automatically)"}
              </span>
              <input type="text" maxLength={80} value={title} placeholder={file ? file.name.replace(/\.[^.]+$/, "") : "Video title"} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label className="field">
              <span>Hashtags (optional, 3–5 specific ones work best)</span>
              <input type="text" value={hashtags} placeholder="#cricket #ipl2026 #highlights" onChange={(e) => setHashtags(e.target.value)} />
            </label>
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              <span>{seoMode === "optimize" ? "Anything the captions should mention? (optional)" : "Description / caption (optional)"}</span>
              <textarea value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>
        )}

      </fieldset>
        <div className="row">
          <button className="primary" disabled={!ready || busy || phase === "planned"} onClick={split}>
            {mode === "automation" ? "Split, upload & plan" : "Split video"}
          </button>
          {phase === "splitting" && <button onClick={() => splitterRef.current?.cancel()}>Cancel</button>}
          {!ready && phase === "setup" && <span className="small muted">Choose a file and every setting to continue.</span>}
        </div>
      </div>

      {/* 3. Progress */}
      {phase !== "setup" && (
        <div className="card stack">
          <div className="progress"><div className={timer.done ? "done" : ""} style={{ width: `${(fraction * 100).toFixed(1)}%` }} /></div>
          <div className="small muted">{status}</div>
          <div className="timing">
            <span>Time taken <b>{fmtSpan(timer.elapsed)}</b></span>
            {!timer.done && <span>Time left <b>{timer.eta != null ? `~${fmtSpan(timer.eta)}` : "estimating…"}</b></span>}
            {timer.speed != null && <span>Speed <b>{timer.speed.toFixed(1)}× real time</b></span>}
            {expected > 0 && <span>Clips <b>{clips.length} / {expected}</b></span>}
          </div>
          {phase === "uploading" && (
            <div className="small">
              Uploading to the cloud: <b>{uploadInfo.done} / {uploadInfo.total}</b>
              <div className="progress" style={{ marginTop: 6 }}><div style={{ width: `${uploadInfo.total ? (uploadInfo.done / uploadInfo.total) * 100 : 0}%` }} /></div>
            </div>
          )}
        </div>
      )}
      {seoWarning && (
        <div className="notice warn">
          <Icon name="alert" size={18} />
          <div>Title writer: {seoWarning}</div>
        </div>
      )}
      {error && (
        <div className="notice error">
          {error}
          {mode === "automation" && phase === "split" && (
            <div style={{ marginTop: 8 }}>
              <button className="small" onClick={() => uploadAndPlan(durRef.current)}>Try the upload again</button>
            </div>
          )}
        </div>
      )}

      {/* 4. Plan (automation) */}
      {plans && (phase === "planned" || phase === "scheduled") && (
        <div className="card stack" id="plan-card">
          <div className="spread">
            <h3 style={{ margin: 0 }}>{phase === "scheduled" ? `Scheduled ${created} posts` : "Posting plan"}</h3>
            {phase === "planned" && <button className="primary" onClick={confirmPlan}>Confirm schedule</button>}
            {phase === "scheduled" && <Link className="btn primary" href="/schedule">Open schedule</Link>}
          </div>
          {uploadInfo.skipped > 0 && (
            <div className="notice warn">
              Only the first {uploadInfo.total} clips fit in your {fmtBytes(props.queueCap)} queue right now. Keep the video: when you get the
              &quot;clips running out&quot; email, upload it again and schedule the remaining {uploadInfo.skipped} clips.
            </div>
          )}
          {plans.map((p) => (
            <div key={p.accountId}>
              <div className="row">
                <span className={`badge ${p.platform}`}>{p.platform === "youtube" ? "YouTube" : "Instagram"}</span>
                <b>{p.accountName}</b>
              </div>
              <div className="small muted" style={{ margin: "4px 0 8px" }}>
                Daily at <b style={{ color: "var(--text)" }}>{p.hoursLabel}</b> ({p.basis}). {p.slots.length} posts from{" "}
                {p.firstAt && DateTime.fromISO(p.firstAt).setZone(timezone).toFormat("ccc d LLL, HH:mm")} to{" "}
                {p.lastAt && DateTime.fromISO(p.lastAt).setZone(timezone).toFormat("ccc d LLL, HH:mm")}.
              </div>
              <details>
                <summary className="small">Show every post time</summary>
                <div className="small" style={{ columns: "220px", marginTop: 6 }}>
                  {p.slots.map((s) => {
                    const t = clips.find((c) => c.index === s.clipIndex)?.seoTitle;
                    return (
                      <div key={s.clipIndex} style={{ breakInside: "avoid", marginBottom: 4 }}>
                        Clip {s.clipIndex + 1}: {DateTime.fromISO(s.at).setZone(timezone).toFormat("ccc d LLL, HH:mm")}
                        {t && <div className="muted">✨ {t}</div>}
                      </div>
                    );
                  })}
                </div>
              </details>
            </div>
          ))}
          {phase === "planned" && <div className="small muted">You can still move or cancel single posts on the Schedule page after confirming.</div>}
        </div>
      )}

      {/* 5. Clips */}
      {clips.length > 0 && (
        <>
          <h2 style={{ marginBottom: 0 }}>Clips ({clips.length})</h2>
          <div className={`clip-grid ${format === "vertical" ? "vertical" : ""}`}>
            {clips.map((c) => (
              <ClipCard
                key={c.index}
                clip={c}
                manual={mode === "manual"}
                accounts={okAccounts}
                accountLabel={accountLabel}
                onDownload={() => downloadClip(c)}
                onChooseAccounts={(ids) => updateClip(c.index, { selectedAccounts: ids })}
                onStartPost={() => updateClip(c.index, { postState: "choosing", selectedAccounts: c.selectedAccounts ?? [] })}
                onCancelPost={() => updateClip(c.index, { postState: undefined })}
                onPost={() => postNow(c)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Only keep a video attached while it's on screen, so hundreds of clips don't exhaust
// the browser's media player limit.
function ClipCard(props: {
  clip: ClipItem;
  manual: boolean;
  accounts: Account[];
  accountLabel: (a: Account) => string;
  onDownload: () => void;
  onChooseAccounts: (ids: string[]) => void;
  onStartPost: () => void;
  onCancelPost: () => void;
  onPost: () => void;
}) {
  const { clip } = props;
  const ref = useRef<HTMLVideoElement>(null);
  const [noPreview, setNoPreview] = useState(false);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (!video.getAttribute("src")) video.src = `${clip.url}#t=0.1`;
        } else if (video.paused && video.getAttribute("src")) {
          video.removeAttribute("src");
          video.load();
        }
      },
      { rootMargin: "400px 0px" },
    );
    obs.observe(video);
    return () => obs.disconnect();
  }, [clip.url]);

  const onPlay = () => {
    document.querySelectorAll<HTMLVideoElement>(".clip video").forEach((v) => v !== ref.current && v.pause());
  };

  return (
    <div className="clip">
      <video
        ref={ref}
        controls
        preload="metadata"
        playsInline
        onPlay={onPlay}
        onError={() => ref.current?.getAttribute("src") && setNoPreview(true)}
        onLoadedMetadata={() => ref.current && !ref.current.videoWidth && setNoPreview(true)}
      />
      {noPreview && <div className="small muted" style={{ padding: "6px 12px 0" }}>Your browser can&apos;t preview this format, but the download works.</div>}
      <div className="meta">
        <div className="spread">
          <div>
            <div style={{ fontWeight: 600, fontSize: ".92rem" }}>Clip {clip.index + 1}</div>
            <div className="small muted">
              {fmtTime(clip.start)} – {fmtTime(clip.end)} · {fmtBytes(clip.blob.size)}
            </div>
          </div>
          {clip.uploaded && <span className="badge ok">in cloud</span>}
        </div>
        {clip.seoTitle && (
          <div className="small" style={{ color: "var(--text-2)" }}>
            ✨ {clip.seoTitle}
            {clip.seoHashtags?.length ? <div className="muted">{clip.seoHashtags.join(" ")}</div> : null}
          </div>
        )}
        <div className="row">
          <button className="small" onClick={props.onDownload}>⬇ Download</button>
          {props.manual && props.accounts.length > 0 && !clip.postState && (
            <button className="small primary" onClick={props.onStartPost}>Post now</button>
          )}
        </div>
        {props.manual && clip.postState === "choosing" && (
          <div className="stack small">
            {props.accounts.map((a) => (
              <label key={a.id} className="row">
                <input
                  type="checkbox"
                  checked={(clip.selectedAccounts ?? []).includes(a.id)}
                  onChange={(e) =>
                    props.onChooseAccounts(e.target.checked ? [...(clip.selectedAccounts ?? []), a.id] : (clip.selectedAccounts ?? []).filter((x) => x !== a.id))
                  }
                />
                {props.accountLabel(a)}
              </label>
            ))}
            <div className="row">
              <button className="small primary" disabled={!(clip.selectedAccounts ?? []).length} onClick={props.onPost}>Post</button>
              <button className="small" onClick={props.onCancelPost}>Cancel</button>
            </div>
          </div>
        )}
        {clip.postState === "posting" && <div className="small muted">Posting… (Instagram can take a minute)</div>}
        {clip.postState === "error" && (
          <div className="small" style={{ color: "var(--danger)" }}>
            {clip.postError} <button className="small" onClick={props.onStartPost}>Try again</button>
          </div>
        )}
        {clip.postState === "done" &&
          clip.postResult?.map((p, i) => (
            <div key={i} className="small">
              <span className={`badge ${p.platform}`}>{p.platform === "youtube" ? "YouTube" : "Instagram"}</span>{" "}
              {p.status === "published" ? (
                p.permalink ? <a href={p.permalink} target="_blank" rel="noreferrer">Published ↗</a> : "Published"
              ) : p.status === "processing" || p.status === "queued" || p.status === "uploading" ? (
                <span className="muted">Still processing; it will finish automatically (see Schedule).</span>
              ) : (
                <span style={{ color: "var(--danger)" }}>{p.last_error || p.status}</span>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
