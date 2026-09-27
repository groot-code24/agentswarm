import { DateTime } from "luxon";
import { env } from "./env";
import { newId, query, queryOne } from "./db";
import { sendEmailOnce } from "./email";
import { deleteObject, getObject, presignGet } from "./storage";
import { getAccount, isSimulated, markNeedsReconnect, refreshAccountData } from "./accounts";
import { generateSuggestions } from "./suggestions";
import { dryRunId, dryRunMetrics } from "./platforms/dryrun";
import { type AccountRow, type Metrics, PlatformError } from "./platforms/types";
import { youtubeFindRecentByTitle, youtubeMetrics, youtubeUpload } from "./platforms/youtube";
import {
  instagramContainerStatus,
  instagramCreateReel,
  instagramFindRecentByCaption,
  instagramMetrics,
  instagramPublish,
} from "./platforms/instagram";

// The scheduler runs as a "tick" (every minute via an external cron in production).
// Rules that keep it safe:
//  1. A post is claimed with a lock before work starts, so two ticks never handle the same post.
//  2. The status is saved BEFORE each external call ("uploading"), so after a crash we know a
//     call may have happened and first look for the finished post instead of posting again.
//  3. Only temporary errors are retried (max 3 attempts); everything else asks the member.

type PostRow = {
  id: string;
  clip_id: string;
  account_id: string;
  user_id: string;
  platform: "youtube" | "instagram";
  scheduled_at: Date;
  status: string;
  title: string;
  caption: string;
  external_id: string | null;
  container_id: string | null;
  attempts: number;
  processing_started_at: Date | null;
  published_at: Date | null;
  metrics_stage: number;
  next_metrics_at: Date | null;
};

type Ctx = { now: Date; log: string[] };

export const MAX_ATTEMPTS = 3;
export const METRIC_STAGES_HOURS = [1, 24, 72, 168];
const LOCK_MINUTES = 10;

const minutes = (now: Date, m: number) => new Date(now.getTime() + m * 60_000);

// ---------- claiming ----------

async function claimNextDuePost(now: Date, onlyIds: string[] | undefined, excludeIds: string[]): Promise<PostRow | null> {
  return queryOne<PostRow>(
    `UPDATE posts SET locked_until = $2
      WHERE id = (
        SELECT id FROM posts
         WHERE status IN ('queued', 'uploading', 'processing')
           AND scheduled_at <= $1
           -- "Post now" (onlyIds) skips the short retry wait; the normal tick respects it.
           AND ($3::text[] IS NOT NULL OR next_attempt_at IS NULL OR next_attempt_at <= $1)
           AND (locked_until IS NULL OR locked_until < $1)
           AND ($3::text[] IS NULL OR id = ANY($3::text[]))
           AND NOT (id = ANY($4::text[]))
         ORDER BY scheduled_at
         LIMIT 1
         -- On a real server two ticks can overlap: each skips rows the other is claiming.
         FOR UPDATE SKIP LOCKED
      )
      AND (locked_until IS NULL OR locked_until < $1)
      RETURNING *`,
    [now, minutes(now, LOCK_MINUTES), onlyIds ?? null, excludeIds],
  );
}

async function setPost(id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await query(`UPDATE posts SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => fields[k])]);
}

// ---------- publishing ----------

export async function processDuePosts(ctx: Ctx, opts: { budgetMs: number; onlyIds?: string[] }) {
  const deadline = Date.now() + opts.budgetMs;
  let handled = 0;
  // A post may be handled twice per run (Instagram: create container, then publish), never more.
  const seen = new Map<string, number>();
  while (Date.now() < deadline) {
    const exclude = [...seen].filter(([, n]) => n >= 2).map(([id]) => id);
    const post = await claimNextDuePost(ctx.now, opts.onlyIds, exclude);
    if (!post) break;
    seen.set(post.id, (seen.get(post.id) ?? 0) + 1);
    handled++;
    try {
      await processPost(post, ctx);
    } catch (err) {
      await handleFailure(post, err, ctx);
    } finally {
      await setPost(post.id, { locked_until: null });
    }
  }
  return handled;
}

async function processPost(post: PostRow, ctx: Ctx) {
  const account = await getAccount(post.account_id);
  if (!account) {
    await setPost(post.id, { status: "cancelled", last_error: "Account was disconnected." });
    return;
  }
  if (account.status === "needs_reconnect") {
    // Wait (without using up attempts) until the member reconnects.
    await setPost(post.id, { next_attempt_at: minutes(ctx.now, 15), last_error: "Waiting for the account to be reconnected." });
    await emailReconnect(account, ctx.now);
    return;
  }
  if (post.platform === "youtube") await processYouTube(post, account, ctx);
  else await processInstagram(post, account, ctx);
}

async function processYouTube(post: PostRow, account: AccountRow, ctx: Ctx) {
  const clip = await clipFor(post.clip_id);
  if (isSimulated(account)) {
    await markPublished(post, dryRunId("yt", post.id), null, ctx);
    return;
  }
  if (post.status === "uploading") {
    // A previous attempt may have finished uploading before a crash. Look before re-uploading.
    const found = await youtubeFindRecentByTitle(account, post.title, minutes(new Date(post.scheduled_at), -60));
    if (found) {
      await markPublished(post, found, `https://youtube.com/shorts/${found}`, ctx);
      return;
    }
  }
  await setPost(post.id, { status: "uploading" });
  const bytes = await getObject(clip.storage_key);
  const tags = post.caption.match(/#[\p{L}\p{N}_]+/gu)?.map((t) => t.slice(1)) ?? [];
  const result = await youtubeUpload(account, {
    bytes,
    contentType: clip.content_type,
    title: post.title,
    description: post.caption,
    tags,
  });
  await markPublished(post, result.externalId, result.permalink, ctx);
}

async function processInstagram(post: PostRow, account: AccountRow, ctx: Ctx) {
  const clip = await clipFor(post.clip_id);
  const simulated = isSimulated(account);

  if (post.status === "processing" && post.container_id) {
    const { status, detail } = simulated ? { status: "FINISHED" as const, detail: "" } : await instagramContainerStatus(account, post.container_id);
    if (status === "IN_PROGRESS") {
      // Instagram is still processing the video; check again shortly (give up after 30 min).
      const startedAt = new Date(post.processing_started_at ?? post.scheduled_at);
      if (ctx.now.getTime() - startedAt.getTime() > 30 * 60_000) {
        throw new PlatformError("Instagram took more than 30 minutes to process the video.", "retry");
      }
      await setPost(post.id, { next_attempt_at: minutes(ctx.now, 1) });
      return;
    }
    if (status === "PUBLISHED") {
      // Published by an attempt that crashed before saving. Find it instead of posting again.
      const found = simulated ? null : await instagramFindRecentByCaption(account, post.caption, minutes(new Date(post.scheduled_at), -60));
      await markPublished(post, found?.externalId ?? post.container_id, found?.permalink ?? null, ctx);
      return;
    }
    if (status === "FINISHED") {
      const result = simulated
        ? { externalId: dryRunId("ig", post.id), permalink: null }
        : await instagramPublish(account, post.container_id);
      await markPublished(post, result.externalId, result.permalink, ctx);
      return;
    }
    // ERROR or EXPIRED: start over with a new container (counts as a failed attempt).
    await setPost(post.id, { container_id: null, status: "queued" });
    throw new PlatformError(`Instagram could not process the video (${status}${detail ? `: ${detail}` : ""}).`, "retry");
  }

  // queued (or "uploading" after a crash, where at worst an unpublished container was left behind; those expire on their own)
  await setPost(post.id, { status: "uploading" });
  const videoUrl = await presignGet(clip.storage_key, 6 * 3600);
  const containerId = simulated ? dryRunId("igc", post.id) : await instagramCreateReel(account, videoUrl, post.caption);
  await setPost(post.id, {
    status: "processing",
    container_id: containerId,
    processing_started_at: ctx.now,
    next_attempt_at: minutes(ctx.now, simulated ? 0 : 1),
  });
}

async function clipFor(clipId: string) {
  const clip = await queryOne<{ storage_key: string; content_type: string; status: string }>(
    "SELECT storage_key, content_type, status FROM clips WHERE id = $1",
    [clipId],
  );
  if (!clip || clip.status === "deleted") throw new PlatformError("The clip file is no longer available.", "fatal");
  return clip;
}

async function markPublished(post: PostRow, externalId: string, permalink: string | null, ctx: Ctx) {
  await setPost(post.id, {
    status: "published",
    external_id: externalId,
    permalink,
    published_at: ctx.now,
    last_error: null,
    next_attempt_at: null,
    metrics_stage: 0,
    next_metrics_at: new Date(ctx.now.getTime() + METRIC_STAGES_HOURS[0] * 3600_000),
  });
  ctx.log.push(`published ${post.platform} post ${post.id}`);
  await updateClipAfterPost(post.clip_id, ctx.now);
  await checkQueue(post.account_id, ctx.now);
}

async function handleFailure(post: PostRow, err: unknown, ctx: Ctx) {
  const e = err instanceof PlatformError ? err : new PlatformError((err as Error)?.message || String(err), "retry");
  ctx.log.push(`post ${post.id}: ${e.kind}: ${e.message}`);
  if (e.kind === "reconnect") {
    await markNeedsReconnect(post.account_id);
    await setPost(post.id, { status: "queued", container_id: null, next_attempt_at: minutes(ctx.now, 15), last_error: e.message });
    const account = await getAccount(post.account_id);
    if (account) await emailReconnect(account, ctx.now);
    return;
  }
  const attempts = post.attempts + 1;
  if (e.kind === "retry" && attempts < MAX_ATTEMPTS) {
    // Wait 5, 20, ... minutes, or longer when the platform tells us to (e.g. daily quota).
    const waitMin = Math.max(5 * 4 ** (attempts - 1), (e.retryAfterSec ?? 0) / 60);
    // Keep "uploading" so the next attempt checks whether the upload actually went through.
    await setPost(post.id, { attempts, next_attempt_at: minutes(ctx.now, waitMin), last_error: e.message });
    return;
  }
  await setPost(post.id, { attempts, status: "needs_attention", last_error: e.message, next_attempt_at: null });
  await updateClipAfterPost(post.clip_id, ctx.now);
  const user = await userFor(post.user_id);
  if (user) {
    await sendEmailOnce({
      key: `failed:${post.id}:${attempts}`,
      userId: user.id,
      kind: "post_failed",
      to: user.email,
      subject: `A ${label(post.platform)} post needs your attention`,
      text: `We couldn't post "${post.title}" to ${label(post.platform)}.\n\nReason: ${e.message}\n\nOpen ${env.appUrl}/schedule to retry or cancel it. The clip is kept for 7 days.`,
    });
  }
}

/** When every post of a clip is finished, schedule the file for deletion (48 h, or 7 days if something failed). */
async function updateClipAfterPost(clipId: string, now: Date) {
  const rows = await query<{ status: string }>("SELECT status FROM posts WHERE clip_id = $1", [clipId]);
  if (!rows.length || rows.some((r) => ["queued", "uploading", "processing"].includes(r.status))) return;
  const failed = rows.some((r) => r.status === "needs_attention");
  const deleteAfter = new Date(now.getTime() + (failed ? 7 * 24 : 48) * 3600_000);
  await query("UPDATE clips SET status = CASE WHEN $2 THEN status ELSE 'posted' END, delete_after = $3 WHERE id = $1 AND status <> 'deleted'", [
    clipId,
    failed,
    deleteAfter,
  ]);
}

// ---------- emails ----------

function label(platform: string) {
  return platform === "youtube" ? "YouTube" : "Instagram";
}

async function userFor(userId: string) {
  return queryOne<{ id: string; email: string; timezone: string; low_stock_days: number }>(
    "SELECT id, email, timezone, low_stock_days FROM users WHERE id = $1",
    [userId],
  );
}

async function emailReconnect(account: AccountRow, now: Date) {
  const user = await userFor(account.user_id);
  if (!user) return;
  await sendEmailOnce({
    key: `reconnect:${account.id}:${now.toISOString().slice(0, 10)}`,
    userId: user.id,
    kind: "reconnect",
    to: user.email,
    subject: `Reconnect your ${label(account.platform)} account ${account.name}`,
    text: `Posting to ${label(account.platform)} (${account.name}) is paused because the connection stopped working.\n\nOpen ${env.appUrl}/settings and press "Reconnect". Your scheduled clips are kept and will continue after reconnecting.`,
  });
}

/**
 * Running-low emails, per account, for Automation-mode queues:
 * a warning when ≤ low_stock_days days of posts are left, and a final email when none are left.
 * Each email is sent once per "batch" (identified by the newest scheduled post).
 */
export async function checkQueue(accountId: string, now: Date) {
  const account = await getAccount(accountId);
  if (!account) return;
  const user = await userFor(account.user_id);
  if (!user) return;
  const newest = await queryOne<{ id: string }>(
    `SELECT p.id FROM posts p JOIN clips c ON c.id = p.clip_id JOIN source_videos s ON s.id = c.source_video_id
      WHERE p.account_id = $1 AND s.mode = 'automation' ORDER BY p.created_at DESC, p.scheduled_at DESC LIMIT 1`,
    [accountId],
  );
  if (!newest) return; // never automated on this account
  const upcoming = await query<{ scheduled_at: Date }>(
    `SELECT p.scheduled_at FROM posts p JOIN clips c ON c.id = p.clip_id JOIN source_videos s ON s.id = c.source_video_id
      WHERE p.account_id = $1 AND s.mode = 'automation' AND p.status IN ('queued', 'uploading', 'processing')`,
    [accountId],
  );
  const days = new Set(upcoming.map((p) => DateTime.fromJSDate(new Date(p.scheduled_at)).setZone(user.timezone).toISODate())).size;
  const link = `${env.appUrl}/upload`;
  if (days === 0) {
    await sendEmailOnce({
      key: `empty:${accountId}:${newest.id}`,
      userId: user.id,
      kind: "queue_empty",
      to: user.email,
      subject: `Your clips are running out (${label(account.platform)} ${account.name})`,
      text: `Your clips are running out. Kindly add more clips.\n\nThere are no more scheduled posts for ${label(account.platform)} (${account.name}).\nUpload a new video here: ${link}`,
    });
  } else if (days <= user.low_stock_days) {
    await sendEmailOnce({
      key: `low:${accountId}:${newest.id}`,
      userId: user.id,
      kind: "queue_low",
      to: user.email,
      subject: `Only ${days} day${days === 1 ? "" : "s"} of clips left (${label(account.platform)} ${account.name})`,
      text: `Your clips are running out. Kindly add more clips.\n\n${label(account.platform)} (${account.name}) has posts scheduled for ${days} more day${days === 1 ? "" : "s"}.\nUpload a new video here: ${link}`,
    });
  }
}

// ---------- metrics ----------

export async function collectMetrics(ctx: Ctx, limit = 100) {
  const due = await query<PostRow & { tz: string; clip_duration: number; format: string }>(
    `SELECT p.*, u.timezone AS tz, c.duration AS clip_duration, s.format
       FROM posts p JOIN users u ON u.id = p.user_id JOIN clips c ON c.id = p.clip_id JOIN source_videos s ON s.id = c.source_video_id
      WHERE p.status = 'published' AND p.next_metrics_at IS NOT NULL AND p.next_metrics_at <= $1
      ORDER BY p.next_metrics_at LIMIT $2`,
    [ctx.now, limit],
  );
  // Group YouTube posts per account so up to 50 videos cost one API call.
  const byAccount = new Map<string, typeof due>();
  for (const p of due) byAccount.set(p.account_id, [...(byAccount.get(p.account_id) || []), p]);

  for (const [accountId, posts] of byAccount) {
    const account = await getAccount(accountId);
    if (!account || account.status !== "ok") continue;
    let ytStats: Map<string, Metrics> | null = null;
    for (const post of posts) {
      const hoursAfter = METRIC_STAGES_HOURS[post.metrics_stage] ?? 168;
      let m: Metrics | null = null;
      try {
        if (isSimulated(account)) {
          m = dryRunMetrics({
            externalId: post.external_id || post.id,
            platform: post.platform,
            publishedAt: new Date(post.published_at!),
            hoursAfter,
            timezone: post.tz,
            clipDuration: post.clip_duration,
            vertical: post.format === "vertical",
          });
        } else if (post.platform === "youtube") {
          ytStats ??= await youtubeMetrics(account, posts.map((p) => p.external_id!).filter(Boolean));
          m = ytStats.get(post.external_id!) ?? null;
        } else {
          m = await instagramMetrics(account, post.external_id!);
        }
      } catch (err) {
        if (err instanceof PlatformError && err.kind === "reconnect") await markNeedsReconnect(account.id);
        ctx.log.push(`metrics ${post.id}: ${(err as Error).message}`);
      }
      if (m) {
        await query(
          `INSERT INTO metric_snapshots (id, post_id, hours_after, views, likes, comments, shares, saves, reach, avg_watch_sec)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (post_id, hours_after) DO NOTHING`,
          [newId(), post.id, hoursAfter, m.views, m.likes, m.comments, m.shares, m.saves, m.reach, m.avgWatchSec],
        );
      }
      // Advance even when a snapshot failed, so one broken post can't block the queue.
      const nextStage = post.metrics_stage + 1;
      const nextAt = nextStage < METRIC_STAGES_HOURS.length
        ? new Date(new Date(post.published_at!).getTime() + METRIC_STAGES_HOURS[nextStage] * 3600_000)
        : null;
      await setPost(post.id, { metrics_stage: nextStage, next_metrics_at: nextAt });
    }
  }
  return due.length;
}

// ---------- retention ----------

export async function cleanupStorage(ctx: Ctx) {
  // Clips left without any active post (cancelled, or the account was disconnected) get the
  // normal 48 h grace period; uploaded clips whose plan was never confirmed are kept 3 days.
  await query(
    `UPDATE clips c SET delete_after = $1
      WHERE c.status IN ('scheduled', 'ready') AND c.delete_after IS NULL
        AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status IN ('queued', 'uploading', 'processing'))
        AND (c.status = 'scheduled' OR c.created_at <= $2)`,
    [new Date(ctx.now.getTime() + 48 * 3600_000), new Date(ctx.now.getTime() - 3 * 86400_000)],
  );
  // Posted/failed clips past their retention time, and uploads that were never finished.
  const expired = await query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM clips
      WHERE status <> 'deleted' AND (
        (delete_after IS NOT NULL AND delete_after <= $1)
        OR (status = 'uploading' AND created_at <= $2)
      ) LIMIT 200`,
    [ctx.now, new Date(ctx.now.getTime() - 24 * 3600_000)],
  );
  for (const clip of expired) {
    try {
      await deleteObject(clip.storage_key);
      await query("UPDATE clips SET status = 'deleted' WHERE id = $1", [clip.id]);
    } catch (err) {
      ctx.log.push(`cleanup ${clip.id}: ${(err as Error).message}`);
    }
  }
  return expired.length;
}

// ---------- daily jobs ----------

async function claimDailyJob(name: string, now: Date): Promise<boolean> {
  const rows = await query(
    `INSERT INTO job_runs (name, last_run) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET last_run = EXCLUDED.last_run
       WHERE job_runs.last_run <= $3
     RETURNING name`,
    [name, now, new Date(now.getTime() - 20 * 3600_000)],
  );
  return rows.length > 0;
}

async function runDaily(ctx: Ctx) {
  if (!(await claimDailyJob("daily", ctx.now))) return false;
  const accounts = await query<AccountRow>("SELECT * FROM connected_accounts");
  for (const account of accounts) {
    const problem = await refreshAccountData(account);
    if (problem) ctx.log.push(`refresh: ${problem}`);
    await checkQueue(account.id, ctx.now);
  }
  const users = await query<{ id: string }>("SELECT id FROM users");
  for (const u of users) {
    try {
      await generateSuggestions(u.id, ctx.now);
    } catch (err) {
      ctx.log.push(`suggestions ${u.id}: ${(err as Error).message}`);
    }
  }
  await sendAdminSummary(ctx);
  return true;
}

async function sendAdminSummary(ctx: Ctx) {
  if (!env.adminEmail) return;
  const since = new Date(ctx.now.getTime() - 24 * 3600_000);
  const counts = await query<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n FROM posts
      WHERE (published_at >= $1) OR (status IN ('needs_attention', 'queued', 'processing', 'uploading') AND scheduled_at <= $2)
      GROUP BY status`,
    [since, ctx.now],
  );
  const get = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const yt = await queryOne<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM posts WHERE platform = 'youtube' AND published_at >= $1",
    [since],
  );
  await sendEmailOnce({
    key: `admin-summary:${ctx.now.toISOString().slice(0, 10)}`,
    userId: null,
    kind: "admin_summary",
    to: env.adminEmail,
    subject: `Clip Autopilot daily summary: ${get("published")} posted, ${get("needs_attention")} need attention`,
    text: [
      `Last 24 hours`,
      `Published: ${get("published")}`,
      `Need attention: ${get("needs_attention")}`,
      `Overdue (still retrying): ${get("queued") + get("uploading") + get("processing")}`,
      `YouTube uploads used: ${yt?.n ?? 0} of 100 per day`,
      ``,
      ...ctx.log.slice(0, 30),
    ].join("\n"),
  });
}

// ---------- entry point ----------

export type TickReport = { now: string; published: number; metrics: number; cleaned: number; daily: boolean; log: string[] };

/** One scheduler run. Safe to call as often as you like; overlapping runs don't collide. */
export async function runTick(opts: { now?: Date; budgetMs?: number } = {}): Promise<TickReport> {
  const ctx: Ctx = { now: opts.now ?? new Date(), log: [] };
  // Remember when the scheduler last ran, so Settings can warn if the cron stops calling.
  await query(
    "INSERT INTO job_runs (name, last_run) VALUES ('tick', $1) ON CONFLICT (name) DO UPDATE SET last_run = EXCLUDED.last_run",
    [ctx.now],
  );
  const published = await processDuePosts(ctx, { budgetMs: opts.budgetMs ?? 200_000 });
  const metrics = await collectMetrics(ctx);
  const cleaned = await cleanupStorage(ctx);
  const daily = await runDaily(ctx);
  return { now: ctx.now.toISOString(), published, metrics, cleaned, daily, log: ctx.log };
}

/** Manual "Post now": process just these posts immediately. */
export async function runPostsNow(postIds: string[], now = new Date()) {
  const ctx: Ctx = { now, log: [] };
  await processDuePosts(ctx, { budgetMs: 240_000, onlyIds: postIds });
  return ctx.log;
}
