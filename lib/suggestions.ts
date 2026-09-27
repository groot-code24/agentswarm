import { DateTime } from "luxon";
import { newId, query, queryOne } from "./db";
import { getAccount, listAccounts, ownPostViews } from "./accounts";
import { median, pickDailyHours, scoresFromPosts, formatHours } from "./planner";
import { retimeQueuedPosts } from "./schedule";
import type { UserPrefs } from "./session";
import { features } from "./env";
import { aiJson } from "./seo";
import type { AccountRow } from "./platforms/types";

// Suggestions come from plain rules over our own numbers (views 24 h after posting, compared with
// the account's own median) and, when an AI key is set, a weekly AI review of each account's recent
// posts. Nothing changes until the member presses Approve, and every applied change stores what it
// replaced so it can be undone.

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

    // 7) Weekly AI review (Gemini/Claude): specific ideas from this account's own recent posts.
    await aiReview(userId, account, now, week).catch((err) => console.error(`AI suggestions ${account.id}: ${(err as Error).message}`));

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

// ---------- AI review ----------

const AI_KINDS = ["title_style", "hook", "topic", "length", "hashtags", "posting_time", "engagement", "other"] as const;
type AiSuggestion = { kind: (typeof AI_KINDS)[number]; title: string; evidence: string; action: string; writer_lesson: string };

const AI_SYSTEM = `You are a short-form video growth analyst for YouTube Shorts and Instagram Reels.
You get one account's recent posts with their results. Give up to 3 specific suggestions that would most likely raise views, watch time, shares, saves and follows for THIS account.

Rules:
- Base every suggestion on patterns in the data and cite the numbers (e.g. "question hooks: median 2,100 views vs 800 for the rest, 6 posts each"). If the data doesn't support a suggestion, don't make it.
- Be concrete about what to do next. No generic advice ("post consistently", "use trending audio").
- Never suggest engagement bait, misleading clickbait, buying followers, or reposting other people's content.
- kind: one of ${AI_KINDS.join(", ")}.
- title: an imperative under 80 characters.
- evidence: 1–2 sentences with numbers from the data.
- action: 1–2 sentences on exactly what to change.
- writer_lesson: ONLY for suggestions about titles, hooks, captions or hashtags: one sentence the AI title writer should follow for future clips of this account (e.g. "Start titles with a question about the outcome."). Otherwise an empty string.`;

const AI_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...AI_KINDS] },
          title: { type: "string" },
          evidence: { type: "string" },
          action: { type: "string" },
          writer_lesson: { type: "string" },
        },
        required: ["kind", "title", "evidence", "action", "writer_lesson"],
      },
    },
  },
  required: ["suggestions"],
};

/** Once a week per account: the AI reads the last 30 measured posts and proposes up to 3 ideas. */
async function aiReview(userId: string, account: AccountRow, now: Date, week: string) {
  if (features.seoEngine === "rules") return;
  const job = `ai-review:${account.id}`;
  const last = await queryOne<{ last_run: Date }>("SELECT last_run FROM job_runs WHERE name = $1", [job]);
  if (last && now.getTime() - new Date(last.last_run).getTime() < 6 * 86400_000) return;

  const user = await queryOne<{ timezone: string }>("SELECT timezone FROM users WHERE id = $1", [userId]);
  const posts = await query<{
    title: string; caption: string; duration: number; published_at: Date;
    views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; avg_watch_sec: number | null;
  }>(
    `SELECT p.title, p.caption, c.duration, p.published_at, m.views::int AS views, m.likes::int AS likes, m.comments::int AS comments,
            m.shares::int AS shares, m.saves::int AS saves, m.avg_watch_sec
       FROM posts p JOIN clips c ON c.id = p.clip_id
       JOIN LATERAL (SELECT * FROM metric_snapshots ms WHERE ms.post_id = p.id AND ms.hours_after >= 24 AND ms.views IS NOT NULL
                     ORDER BY ms.hours_after ASC LIMIT 1) m ON true
      WHERE p.account_id = $1 AND p.status = 'published'
      ORDER BY p.published_at DESC LIMIT 30`,
    [account.id],
  );
  if (posts.length < 8) return; // not enough results to learn from yet
  await query(
    "INSERT INTO job_runs (name, last_run) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET last_run = EXCLUDED.last_run",
    [job, now],
  );

  const tz = user?.timezone || "UTC";
  const platform = account.platform === "youtube" ? "YouTube Shorts" : "Instagram Reels";
  const n = (v: number | null) => (v == null ? "?" : String(Math.round(v)));
  const lines = posts.map((p, i) => {
    const at = DateTime.fromJSDate(new Date(p.published_at)).setZone(tz);
    const watch = p.avg_watch_sec != null ? `${p.avg_watch_sec.toFixed(1)}s (${Math.round((p.avg_watch_sec / Math.max(1, p.duration)) * 100)}%)` : "?";
    const tags = (p.caption.match(/#[\p{L}\p{N}_]+/gu) || []).slice(0, 6).join(" ");
    const hook = p.caption.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"))?.slice(0, 120) ?? "";
    return `#${i + 1} | ${at.toFormat("ccc d LLL HH:mm")} | ${Math.round(p.duration)}s | views ${n(p.views)} | watch ${watch} | likes ${n(p.likes)} | comments ${n(p.comments)} | shares ${n(p.shares)} | saves ${n(p.saves)} | title "${p.title}" | caption first line "${hook}" | ${tags}`;
  });
  const views = posts.map((p) => p.views ?? 0);
  const prompt = [
    `Account: ${account.name} on ${platform}. Times are in ${tz}.`,
    `Median views 24 h after posting: ${fmt(median(views))} over ${posts.length} posts.`,
    "Recent posts (newest first), metrics about 24 h after posting:",
    ...lines,
  ].join("\n");

  const out = await aiJson<{ suggestions: AiSuggestion[] }>(AI_SYSTEM, prompt, AI_SCHEMA);
  const list = (out?.suggestions ?? []).filter((x) => x && x.title && x.evidence && x.action).slice(0, 3);
  for (const [i, x] of list.entries()) {
    const kind = AI_KINDS.includes(x.kind) ? x.kind : "other";
    const lesson = String(x.writer_lesson || "").trim().slice(0, 300);
    await propose({
      userId,
      accountId: account.id,
      type: `ai_${kind}`,
      title: String(x.title).slice(0, 120),
      evidence: String(x.evidence).slice(0, 600),
      changeSummary: lesson
        ? `${String(x.action).slice(0, 400)} Approve to teach the title writer: "${lesson}" (used for every future title and caption; can be undone).`
        : `${String(x.action).slice(0, 400)} This is advice; nothing changes automatically.`,
      proposedChange: lesson ? { guidance: lesson } : {},
      canApply: Boolean(lesson),
      dedupeKey: `ai:${account.id}:${week}:${i}`,
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
  } else if (s.type.startsWith("ai_") && typeof s.proposed_change.guidance === "string") {
    // Teach the title writer: the lesson is added to every future title/caption request.
    const prefs = { ...(user!.prefs || {}) };
    const previous = prefs.seoGuidance ?? null;
    applied = { key: "seoGuidance", previous };
    const next = [...(previous ?? []).filter((g) => g !== s.proposed_change.guidance), String(s.proposed_change.guidance)].slice(-6);
    await query("UPDATE users SET prefs = $1::jsonb WHERE id = $2", [JSON.stringify({ ...prefs, seoGuidance: next }), userId]);
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
