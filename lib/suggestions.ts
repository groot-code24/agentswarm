import { DateTime } from "luxon";
import { newId, query, queryOne } from "./db";
import { getAccount, listAccounts, ownPostViews } from "./accounts";
import { median, pickDailyHours, scoresFromPosts, formatHours } from "./planner";
import { retimeQueuedPosts } from "./schedule";
import type { UserPrefs } from "./session";

// Suggestions are plain rules over our own numbers (views 24 h after posting, compared with the
// account's own median). Nothing changes until the member presses Approve, and every applied
// change stores what it replaced so it can be undone.

export type SuggestionRow = {
  id: string;
  user_id: string;
  account_id: string | null;
  type: string;
  title: string;
  evidence: string;
  change_summary: string;
  proposed_change: Record<string, unknown>;
  applied_state: Record<string, unknown> | null;
  can_apply: boolean;
  status: string;
  created_at: Date;
};

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

async function propose(s: {
  userId: string;
  accountId: string | null;
  type: string;
  title: string;
  evidence: string;
  changeSummary: string;
  proposedChange?: Record<string, unknown>;
  canApply?: boolean;
  dedupeKey: string;
}) {
  // One open suggestion per type and account at a time.
  const open = await queryOne(
    "SELECT id FROM suggestions WHERE user_id = $1 AND type = $2 AND account_id IS NOT DISTINCT FROM $3 AND status = 'proposed'",
    [s.userId, s.type, s.accountId],
  );
  if (open) return;
  await query(
    `INSERT INTO suggestions (id, user_id, account_id, type, title, evidence, change_summary, proposed_change, can_apply, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) ON CONFLICT (dedupe_key) DO NOTHING`,
    [newId(), s.userId, s.accountId, s.type, s.title, s.evidence, s.changeSummary, JSON.stringify(s.proposedChange ?? {}), s.canApply ?? true, s.dedupeKey],
  );
}

type PostStat = {
  post_id: string;
  account_id: string;
  platform: string;
  published_at: Date;
  views: number;
  avg_watch_sec: number | null;
  clip_duration: number;
  clip_length: number;
  format: string;
  hashtags: string;
};

async function userPostStats(userId: string): Promise<PostStat[]> {
  return query<PostStat>(
    `SELECT p.id AS post_id, p.account_id, p.platform, p.published_at, s.views::int AS views, s.avg_watch_sec,
            c.duration AS clip_duration, sv.clip_length, sv.format, sv.hashtags
       FROM posts p
       JOIN clips c ON c.id = p.clip_id
       JOIN source_videos sv ON sv.id = c.source_video_id
       JOIN LATERAL (
         SELECT views, avg_watch_sec FROM metric_snapshots m
          WHERE m.post_id = p.id AND m.hours_after >= 24 AND m.views IS NOT NULL
          ORDER BY m.hours_after ASC LIMIT 1
       ) s ON true
      WHERE p.user_id = $1 AND p.status = 'published'
      ORDER BY p.published_at DESC
      LIMIT 500`,
    [userId],
  );
}

async function currentPostsPerDay(accountId: string): Promise<number> {
  const row = await queryOne<{ ppd: number | null }>(
    `SELECT sv.posts_per_day AS ppd FROM posts p JOIN clips c ON c.id = p.clip_id JOIN source_videos sv ON sv.id = c.source_video_id
      WHERE p.account_id = $1 AND sv.mode = 'automation' ORDER BY p.created_at DESC LIMIT 1`,
    [accountId],
  );
  return row?.ppd || 2;
}

function hourMedians(posts: { publishedAt: Date; views: number }[], tz: string) {
  const buckets = new Map<number, number[]>();
  for (const p of posts) {
    const h = DateTime.fromJSDate(new Date(p.publishedAt)).setZone(tz).hour;
    buckets.set(h, [...(buckets.get(h) || []), p.views]);
  }
  return new Map([...buckets].map(([h, v]) => [h, { median: median(v), n: v.length }]));
}

export async function generateSuggestions(userId: string, now = new Date()) {
  const user = await queryOne<{ id: string; timezone: string; prefs: UserPrefs }>("SELECT id, timezone, prefs FROM users WHERE id = $1", [userId]);
  if (!user) return;
  const tz = user.timezone;
  const week = DateTime.fromJSDate(now).toFormat("kkkk-'W'WW");
  const month = DateTime.fromJSDate(now).toFormat("yyyy-LL");
  const accounts = await listAccounts(userId);
  const stats = await userPostStats(userId);

  for (const account of accounts) {
    const own = await ownPostViews(account.id);
    const queued = await query<{ scheduled_at: Date }>(
      "SELECT scheduled_at FROM posts WHERE account_id = $1 AND status = 'queued' AND scheduled_at > $2",
      [account.id, now],
    );
    const ppd = await currentPostsPerDay(account.id);
    const platform = account.platform === "youtube" ? "YouTube" : "Instagram";

    // 1) Posting times: upcoming posts sit at hours that did clearly worse than the best hours.
    const scores = scoresFromPosts(own, tz, 12);
    if (scores && queued.length) {
      const best = pickDailyHours(scores, ppd);
      const queuedHours = [...new Set(queued.map((q) => DateTime.fromJSDate(new Date(q.scheduled_at)).setZone(tz).hour))];
      const avg = (hs: number[]) => hs.reduce((a, h) => a + scores[h], 0) / hs.length;
      if (avg(queuedHours) < 0.8 * avg(best)) {
        const medians = hourMedians(own, tz);
        const bestWithData = best.filter((h) => medians.has(h));
        const worst = queuedHours.filter((h) => medians.has(h)).sort((a, b) => medians.get(a)!.median - medians.get(b)!.median)[0];
        const parts: string[] = [];
        for (const h of bestWithData) parts.push(`${formatHours([h])}: median ${fmt(medians.get(h)!.median)} views (${medians.get(h)!.n} posts)`);
        if (worst != null) parts.push(`${formatHours([worst])}: median ${fmt(medians.get(worst)!.median)} views (${medians.get(worst)!.n} posts)`);
        await propose({
          userId,
          accountId: account.id,
          type: "posting_time",
          title: `Post at ${formatHours(best)} on ${platform} ${account.name}`,
          evidence: `Views in the first 24 h by posting hour, from your last ${own.length} posts: ${parts.join("; ")}.`,
          changeSummary: `Move ${queued.length} upcoming posts to ${formatHours(best)} (${ppd} per day, same order). Can be undone.`,
          proposedChange: { hours: best },
          dedupeKey: `posting_time:${account.id}:${best.join("-")}:${week}`,
        });
      }
    }

    // 2) Posts per day: reach per post is falling while posting more than the minimum.
    if (own.length >= 20 && ppd > 2 && queued.length) {
      const recent = median(own.slice(0, 10).map((p) => p.views));
      const before = median(own.slice(10, 20).map((p) => p.views));
      if (before > 0 && recent / before < 0.7) {
        await propose({
          userId,
          accountId: account.id,
          type: "posts_per_day",
          title: `Post ${ppd - 1} times a day instead of ${ppd} on ${platform} ${account.name}`,
          evidence: `Your last 10 posts got a median of ${fmt(recent)} views in 24 h, down ${Math.round((1 - recent / before) * 100)}% from the 10 before (${fmt(before)}). Posting less often can raise views per post.`,
          changeSummary: `Spread the ${queued.length} upcoming posts over more days at ${ppd - 1} per day (minimum stays 2). Can be undone.`,
          proposedChange: { postsPerDay: ppd - 1 },
          dedupeKey: `posts_per_day:${account.id}:${ppd - 1}:${week}`,
        });
      }
    }

    // 5) Watch time (advice): Instagram viewers leave early.
    if (account.platform === "instagram") {
      const ratios = stats
        .filter((s) => s.account_id === account.id && s.avg_watch_sec != null && s.clip_duration > 0)
        .slice(0, 10)
        .map((s) => s.avg_watch_sec! / s.clip_duration);
      if (ratios.length >= 5 && median(ratios) < 0.3) {
        await propose({
          userId,
          accountId: account.id,
          type: "watch_time",
          title: `Viewers leave your ${platform} clips early`,
          evidence: `On your last ${ratios.length} Reels, people watched ${Math.round(median(ratios) * 100)}% of each clip on average.`,
          changeSummary: "Start each clip on its strongest moment, add on-screen captions, and try shorter clips (30 s). This is advice; nothing changes automatically.",
          canApply: false,
          dedupeKey: `watch_time:${account.id}:${month}`,
        });
      }
    }
  }

  // 3) Clip length: one length clearly beats the others.
  const byLength = new Map<number, number[]>();
  for (const s of stats) byLength.set(s.clip_length, [...(byLength.get(s.clip_length) || []), s.views]);
  const lengths = [...byLength].filter(([, v]) => v.length >= 5).map(([len, v]) => ({ len, med: median(v), n: v.length }));
  if (lengths.length >= 2) {
    lengths.sort((a, b) => b.med - a.med);
    const [best, next] = lengths;
    if (best.med >= 1.3 * next.med && user.prefs?.recommendedClipLength !== best.len) {
      await propose({
        userId,
        accountId: null,
        type: "clip_length",
        title: `Use ${best.len}-second clips`,
        evidence: lengths.map((l) => `${l.len}s clips: median ${fmt(l.med)} views (${l.n} posts)`).join("; ") + ".",
        changeSummary: `Mark ${best.len} seconds as "Recommended" on the upload page. You still choose the length each time. Can be undone.`,
        proposedChange: { clipLength: best.len },
        dedupeKey: `clip_length:${userId}:${best.len}:${month}`,
      });
    }
  }

  // 4) Vertical format on YouTube.
  const yt = stats.filter((s) => s.platform === "youtube");
  const vertical = yt.filter((s) => s.format === "vertical").map((s) => s.views);
  const original = yt.filter((s) => s.format === "original").map((s) => s.views);
  if (user.prefs?.recommendedFormat !== "vertical") {
    if (vertical.length >= 5 && original.length >= 5 && median(vertical) >= 1.3 * median(original)) {
      await propose({
        userId,
        accountId: null,
        type: "vertical_format",
        title: "Use vertical 9:16 for YouTube",
        evidence: `On YouTube, vertical clips got a median of ${fmt(median(vertical))} views vs ${fmt(median(original))} for original-shape clips.`,
        changeSummary: 'Mark "Vertical 9:16" as "Recommended" on the upload page. You still choose each time. Can be undone.',
        proposedChange: { format: "vertical" },
        dedupeKey: `vertical_format:${userId}:${month}`,
      });
    } else if (original.length >= 8 && vertical.length === 0) {
      await propose({
        userId,
        accountId: null,
        type: "vertical_format",
        title: "Try vertical 9:16 clips on YouTube",
        evidence: `All of your last ${original.length} YouTube clips were horizontal. YouTube only shows vertical or square videos (up to 3 min) as Shorts, so horizontal clips miss the Shorts feed.`,
        changeSummary: 'Mark "Vertical 9:16" as "Recommended" on the upload page. You still choose each time. Can be undone.',
        proposedChange: { format: "vertical" },
        dedupeKey: `vertical_format_try:${userId}:${month}`,
      });
    }
  }

  // 6) Hashtags (advice): recent uploads had none.
  const recentSources = await query<{ hashtags: string }>(
    "SELECT hashtags FROM source_videos WHERE user_id = $1 AND mode = 'automation' ORDER BY created_at DESC LIMIT 3",
    [userId],
  );
  if (stats.length >= 5 && recentSources.length >= 2 && recentSources.every((s) => !s.hashtags.trim())) {
    await propose({
      userId,
      accountId: null,
      type: "hashtags",
      title: "Add 3–5 hashtags to your uploads",
      evidence: `Your last ${recentSources.length} uploads had no hashtags. Hashtags help both platforms show clips to people interested in the topic.`,
      changeSummary: "Fill in the Hashtags box on the upload page with 3–5 specific tags (e.g. #cricket #ipl2026 rather than #video). This is advice; nothing changes automatically.",
      canApply: false,
      dedupeKey: `hashtags:${userId}:${month}`,
    });
  }
}

// ---------- decisions ----------

export async function applySuggestion(userId: string, id: string, now = new Date()): Promise<SuggestionRow> {
  const s = await queryOne<SuggestionRow>("SELECT * FROM suggestions WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!s) throw new Error("Suggestion not found.");
  if (s.status !== "proposed") throw new Error("This suggestion was already handled.");
  if (!s.can_apply) throw new Error("This suggestion is advice only.");
  const user = await queryOne<{ timezone: string; prefs: UserPrefs }>("SELECT timezone, prefs FROM users WHERE id = $1", [userId]);
  let applied: Record<string, unknown> = {};

  if (s.type === "posting_time" || s.type === "posts_per_day") {
    const account = s.account_id ? await getAccount(s.account_id) : null;
    if (!account) throw new Error("The account is no longer connected.");
    let hours = s.proposed_change.hours as number[] | undefined;
    if (!hours) {
      const own = await ownPostViews(account.id);
      const scores = scoresFromPosts(own, user!.timezone, 1);
      hours = pickDailyHours(scores ?? Array(24).fill(1), Number(s.proposed_change.postsPerDay));
    }
    applied = { changes: await retimeQueuedPosts(account, user!.timezone, hours, now) };
  } else if (s.type === "clip_length" || s.type === "vertical_format") {
    const prefs = { ...(user!.prefs || {}) };
    const key = s.type === "clip_length" ? "recommendedClipLength" : "recommendedFormat";
    applied = { key, previous: prefs[key] ?? null };
    const value = s.type === "clip_length" ? s.proposed_change.clipLength : s.proposed_change.format;
    await query("UPDATE users SET prefs = $1::jsonb WHERE id = $2", [JSON.stringify({ ...prefs, [key]: value }), userId]);
  } else {
    throw new Error(`Unknown suggestion type: ${s.type}`);
  }

  await query("UPDATE suggestions SET status = 'applied', applied_state = $1::jsonb, decided_at = $2 WHERE id = $3", [
    JSON.stringify(applied),
    now,
    id,
  ]);
  await query("INSERT INTO audit_log (id, user_id, action, detail) VALUES ($1, $2, 'suggestion.applied', $3::jsonb)", [
    newId(),
    userId,
    JSON.stringify({ suggestionId: id, type: s.type, applied }),
  ]);
  return (await queryOne<SuggestionRow>("SELECT * FROM suggestions WHERE id = $1", [id]))!;
}

export async function undoSuggestion(userId: string, id: string, now = new Date()) {
  const s = await queryOne<SuggestionRow>("SELECT * FROM suggestions WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!s || s.status !== "applied" || !s.applied_state) throw new Error("Only applied suggestions can be undone.");
  let restored = 0;
  if (Array.isArray(s.applied_state.changes)) {
    for (const c of s.applied_state.changes as { postId: string; oldAt: string }[]) {
      // Only posts that haven't gone out yet can be moved back.
      const rows = await query("UPDATE posts SET scheduled_at = $1 WHERE id = $2 AND status = 'queued' RETURNING id", [c.oldAt, c.postId]);
      restored += rows.length;
    }
  } else if (typeof s.applied_state.key === "string") {
    const user = await queryOne<{ prefs: UserPrefs }>("SELECT prefs FROM users WHERE id = $1", [userId]);
    const prefs: Record<string, unknown> = { ...(user?.prefs || {}) };
    if (s.applied_state.previous == null) delete prefs[s.applied_state.key];
    else prefs[s.applied_state.key] = s.applied_state.previous;
    await query("UPDATE users SET prefs = $1::jsonb WHERE id = $2", [JSON.stringify(prefs), userId]);
    restored = 1;
  }
  await query("UPDATE suggestions SET status = 'undone', decided_at = $1 WHERE id = $2", [now, id]);
  await query("INSERT INTO audit_log (id, user_id, action, detail) VALUES ($1, $2, 'suggestion.undone', $3::jsonb)", [
    newId(),
    userId,
    JSON.stringify({ suggestionId: id, restored }),
  ]);
  return restored;
}

export async function rejectSuggestion(userId: string, id: string, now = new Date()) {
  const s = await queryOne<SuggestionRow>("SELECT * FROM suggestions WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!s || s.status !== "proposed") throw new Error("This suggestion was already handled.");
  await query("UPDATE suggestions SET status = $1, decided_at = $2 WHERE id = $3", [s.can_apply ? "rejected" : "dismissed", now, id]);
}
