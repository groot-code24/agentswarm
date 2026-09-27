import { query, queryOne, newId } from "./db";
import { HttpError } from "./http";
import type { User } from "./session";
import { audit } from "./session";
import { bestTimes, listAccounts } from "./accounts";
import { planSlots, formatHours, type Stage } from "./planner";
import { buildInstagramCaption, buildOptimizedInstagram, buildOptimizedYouTube, buildYouTubeText } from "./captions";
import type { ClipSeo } from "./seo";
import type { AccountRow } from "./platforms/types";
import { storageBackend } from "./storage";
import { memberCount } from "./access";

const MB = 1024 * 1024;
/**
 * Most clip bytes one member may have waiting in storage. Vercel Blob's free plan holds about
 * 1 GB for the whole team, so there the space is shared out between the members.
 */
export async function queueCapBytes(): Promise<number> {
  if (storageBackend() !== "blob") return 1024 * MB;
  return Math.floor((900 * MB) / Math.max(1, await memberCount()));
}
export const ACTIVE_POST_STATUSES = ["queued", "uploading", "processing"];

export type SourceVideo = {
  id: string;
  user_id: string;
  filename: string;
  duration: number;
  mode: "automation" | "manual";
  account_ids: string[];
  clip_length: number;
  format: "original" | "vertical";
  posts_per_day: number | null;
  title: string;
  description: string;
  hashtags: string;
  seo_mode: "optimize" | "as_written";
  topic: string;
  language: string;
};

export type ClipRow = {
  id: string;
  source_video_id: string;
  user_id: string;
  idx: number;
  storage_key: string;
  bytes: number;
  duration: number;
  width: number | null;
  height: number | null;
  start_sec: number;
  content_type: string;
  status: string;
  seo: ClipSeo | null;
};

export async function queueBytes(userId: string): Promise<number> {
  const row = await queryOne<{ total: number }>(
    "SELECT COALESCE(SUM(bytes), 0)::int AS total FROM clips WHERE user_id = $1 AND status IN ('uploading', 'ready', 'scheduled')",
    [userId],
  );
  return Number(row?.total || 0);
}

export async function getSource(user: User, sourceVideoId: string): Promise<SourceVideo> {
  const source = await queryOne<SourceVideo>("SELECT * FROM source_videos WHERE id = $1 AND user_id = $2", [sourceVideoId, user.id]);
  if (!source) throw new HttpError(404, "Upload not found.");
  return source;
}

async function lastActiveSlot(accountId: string): Promise<Date | null> {
  const row = await queryOne<{ last: Date | null }>(
    "SELECT MAX(scheduled_at) AS last FROM posts WHERE account_id = $1 AND status = ANY($2)",
    [accountId, ACTIVE_POST_STATUSES],
  );
  return row?.last ? new Date(row.last) : null;
}

export type AccountPlan = {
  accountId: string;
  platform: string;
  accountName: string;
  hours: number[];
  hoursLabel: string;
  stage: Stage;
  basis: string;
  slots: { clipId: string; clipIndex: number; at: string }[];
  firstAt: string | null;
  lastAt: string | null;
};

function textFor(source: SourceVideo, clip: ClipRow, totalParts: number, platform: string): { title: string; caption: string; tags: string[] | null } {
  const seo = source.seo_mode === "optimize" ? clip.seo : null;
  if (seo) {
    if (platform === "youtube") {
      const yt = buildOptimizedYouTube(seo, { vertical: source.format === "vertical", duration: clip.duration });
      return { title: yt.title, caption: yt.description, tags: yt.tags };
    }
    const caption = buildOptimizedInstagram(seo, { part: clip.idx + 1, totalParts });
    return { title: seo.youtube.title, caption, tags: null };
  }
  const common = {
    title: source.title,
    filename: source.filename,
    description: source.description,
    hashtags: source.hashtags,
    part: clip.idx + 1,
    totalParts,
  };
  if (platform === "youtube") {
    const yt = buildYouTubeText({ ...common, vertical: source.format === "vertical", duration: clip.duration });
    return { title: yt.title, caption: yt.description, tags: yt.tags };
  }
  const caption = buildInstagramCaption(common);
  return { title: caption.split("\n")[0], caption, tags: null };
}

/** Works out when each clip would go out on each selected account. Nothing is saved. */
export async function previewPlan(user: User, source: SourceVideo, now = new Date()): Promise<AccountPlan[]> {
  if (source.mode !== "automation") throw new HttpError(400, "Only Automation mode uploads are scheduled.");
  const clips = await query<ClipRow>(
    "SELECT * FROM clips WHERE source_video_id = $1 AND status = 'ready' ORDER BY idx",
    [source.id],
  );
  if (!clips.length) throw new HttpError(400, "No uploaded clips to schedule yet.");
  const accounts = (await listAccounts(user.id)).filter((a) => source.account_ids.includes(a.id));
  if (!accounts.length) throw new HttpError(400, "The selected accounts are no longer connected.");
  const perDay = source.posts_per_day || 2;

  const plans: AccountPlan[] = [];
  for (const account of accounts) {
    const best = await bestTimes(account, user.timezone, perDay);
    const last = await lastActiveSlot(account.id);
    const after = last && last > now ? last : now;
    const slots = planSlots({
      count: clips.length,
      hours: best.hours,
      timezone: user.timezone,
      after,
      explore: best.stage === "own-results",
      minute: account.platform === "instagram" ? 5 : 0,
    });
    plans.push({
      accountId: account.id,
      platform: account.platform,
      accountName: account.name,
      hours: best.hours,
      hoursLabel: formatHours(best.hours),
      stage: best.stage,
      basis: best.basis,
      slots: slots.map((at, i) => ({ clipId: clips[i].id, clipIndex: clips[i].idx, at: at.toISOString() })),
      firstAt: slots[0]?.toISOString() ?? null,
      lastAt: slots[slots.length - 1]?.toISOString() ?? null,
    });
  }
  return plans;
}

/** Saves the plan as queued posts. Re-running is safe: each clip/account pair is unique. */
export async function commitPlan(user: User, source: SourceVideo, now = new Date()) {
  const plans = await previewPlan(user, source, now);
  const clips = await query<ClipRow>("SELECT * FROM clips WHERE source_video_id = $1 ORDER BY idx", [source.id]);
  const byId = new Map(clips.map((c) => [c.id, c]));
  const total = clips.length;
  let created = 0;
  for (const plan of plans) {
    for (const slot of plan.slots) {
      const clip = byId.get(slot.clipId)!;
      const { title, caption, tags } = textFor(source, clip, total, plan.platform);
      const rows = await query(
        `INSERT INTO posts (id, clip_id, account_id, user_id, platform, scheduled_at, title, caption, tags, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [newId(), clip.id, plan.accountId, user.id, plan.platform, slot.at, title, caption, tags, `${clip.id}:${plan.accountId}`],
      );
      created += rows.length;
    }
  }
  await query("UPDATE clips SET status = 'scheduled' WHERE source_video_id = $1 AND status = 'ready'", [source.id]);
  await audit(user.id, "schedule.created", { sourceVideoId: source.id, posts: created });
  return { created, plans };
}

/** Manual mode: post one clip right away to the chosen accounts. */
export async function createPostNow(user: User, clipId: string, accounts: AccountRow[], now = new Date()) {
  const clip = await queryOne<ClipRow>("SELECT * FROM clips WHERE id = $1 AND user_id = $2", [clipId, user.id]);
  if (!clip) throw new HttpError(404, "Clip not found.");
  if (clip.status === "uploading") throw new HttpError(400, "The clip hasn't finished uploading yet.");
  const source = await getSource(user, clip.source_video_id);
  const ids: string[] = [];
  for (const account of accounts) {
    const { title, caption, tags } = textFor(source, clip, 0, account.platform);
    const rows = await query<{ id: string }>(
      `INSERT INTO posts (id, clip_id, account_id, user_id, platform, scheduled_at, title, caption, tags, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [newId(), clip.id, account.id, user.id, account.platform, now, title, caption, tags, `${clip.id}:${account.id}`],
    );
    if (rows[0]) ids.push(rows[0].id);
  }
  await query("UPDATE clips SET status = 'scheduled' WHERE id = $1 AND status = 'ready'", [clip.id]);
  await audit(user.id, "post.now", { clipId, accounts: accounts.map((a) => a.id) });
  return ids;
}

/** Re-times the given queued posts onto new daily hours, keeping their order. Returns the old times (for undo). */
export async function retimeQueuedPosts(
  account: AccountRow,
  timezone: string,
  hours: number[],
  now = new Date(),
): Promise<{ postId: string; oldAt: string; newAt: string }[]> {
  const posts = await query<{ id: string; scheduled_at: Date }>(
    "SELECT id, scheduled_at FROM posts WHERE account_id = $1 AND status = 'queued' AND scheduled_at > $2 ORDER BY scheduled_at",
    [account.id, now],
  );
  if (!posts.length) return [];
  const slots = planSlots({ count: posts.length, hours, timezone, after: now, minute: account.platform === "instagram" ? 5 : 0 });
  const changes = posts.map((p, i) => ({ postId: p.id, oldAt: new Date(p.scheduled_at).toISOString(), newAt: slots[i].toISOString() }));
  for (const c of changes) {
    await query("UPDATE posts SET scheduled_at = $1 WHERE id = $2 AND status = 'queued'", [c.newAt, c.postId]);
  }
  return changes;
}
