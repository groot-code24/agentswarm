import { beforeAll, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { newId, query, queryOne } from "@/lib/db";
import { commitPlan, previewPlan, createPostNow, type SourceVideo } from "@/lib/schedule";
import { runTick, runPostsNow } from "@/lib/scheduler";
import { applySuggestion, generateSuggestions, undoSuggestion } from "@/lib/suggestions";
import type { User } from "@/lib/session";

// End-to-end automation run in dry-run mode: simulated YouTube + Instagram, in-memory database.

const TZ = "Asia/Kolkata";
const user: User = { id: "u1", email: "member@example.com", name: "Member", timezone: TZ, low_stock_days: 3, prefs: {} };
const start = new Date("2026-10-01T02:00:00Z"); // 07:30 in India

async function seedAccounts() {
  await query("INSERT INTO users (id, email, name, timezone) VALUES ($1, $2, $3, $4)", [user.id, user.email, user.name, TZ]);
  for (const platform of ["youtube", "instagram"]) {
    await query(
      `INSERT INTO connected_accounts (id, user_id, platform, external_id, name, meta)
       VALUES ($1, $2, $3, $4, $5, '{"dryRun": true}'::jsonb)`,
      [`acc-${platform}`, user.id, platform, `ext-${platform}`, `Test ${platform}`],
    );
  }
}

async function seedSource(opts: { clips: number; mode: "automation" | "manual"; clipLength?: number; ppd?: number }): Promise<SourceVideo> {
  const id = newId();
  await query(
    `INSERT INTO source_videos (id, user_id, filename, duration, mode, account_ids, clip_length, format, posts_per_day, title, hashtags)
     VALUES ($1, $2, 'talk.mp4', $3, $4, $5, $6, 'vertical', $7, 'My talk', '#talk #learning')`,
    [id, user.id, opts.clips * (opts.clipLength ?? 60), opts.mode, ["acc-youtube", "acc-instagram"], opts.clipLength ?? 60, opts.ppd ?? 2],
  );
  for (let i = 0; i < opts.clips; i++) {
    await query(
      `INSERT INTO clips (id, source_video_id, user_id, idx, storage_key, bytes, duration, start_sec, status)
       VALUES ($1, $2, $3, $4, $5, 1000, $6, $7, 'ready')`,
      [newId(), id, user.id, i, `test/${id}/${i}.mp4`, opts.clipLength ?? 60, i * (opts.clipLength ?? 60)],
    );
  }
  return (await queryOne<SourceVideo>("SELECT * FROM source_videos WHERE id = $1", [id]))!;
}

/** Runs the scheduler every `stepMin` minutes between two times (a simulated cron). */
async function simulate(from: Date, to: Date, stepMin = 30) {
  for (let t = from.getTime(); t <= to.getTime(); t += stepMin * 60_000) {
    await runTick({ now: new Date(t), budgetMs: 60_000 });
  }
}

describe("automation (dry run)", () => {
  let source: SourceVideo;

  beforeAll(async () => {
    await seedAccounts();
    source = await seedSource({ clips: 30, mode: "automation", ppd: 2 });
  });

  it("plans 30 clips at 2 per day over 15 days on each platform", async () => {
    const plans = await previewPlan(user, source, start);
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan.slots).toHaveLength(30);
      const days = new Set(plan.slots.map((s) => DateTime.fromISO(s.at).setZone(TZ).toISODate()));
      expect(days.size).toBe(15);
      expect(plan.stage).toBe("default");
    }
    const { created } = await commitPlan(user, source, start);
    expect(created).toBe(60);
    // Committing twice never creates duplicates.
    const again = await commitPlan(user, source, start).catch((e) => e);
    expect(again instanceof Error || again.created === 0).toBe(true);
    const count = await queryOne<{ n: number }>("SELECT COUNT(*)::int AS n FROM posts");
    expect(count!.n).toBe(60);
  });

  it("publishes every post exactly once, on time, and collects metrics", async () => {
    await simulate(start, new Date(start.getTime() + 24 * 86400_000), 30);
    const posts = await query<{ status: string; scheduled_at: Date; published_at: Date; external_id: string }>(
      "SELECT status, scheduled_at, published_at, external_id FROM posts",
    );
    expect(posts.every((p) => p.status === "published")).toBe(true);
    expect(new Set(posts.map((p) => p.external_id)).size).toBe(60);
    for (const p of posts) {
      const lateMin = (new Date(p.published_at).getTime() - new Date(p.scheduled_at).getTime()) / 60_000;
      expect(lateMin).toBeGreaterThanOrEqual(0);
      expect(lateMin).toBeLessThanOrEqual(31); // within one simulated cron step
    }
    const snaps = await queryOne<{ n: number }>("SELECT COUNT(*)::int AS n FROM metric_snapshots WHERE hours_after = 24");
    expect(snaps!.n).toBe(60);
  });

  it("sends the running-low warning and the empty email once per account", async () => {
    const sent = await query<{ key: string; kind: string }>("SELECT key, kind FROM notifications WHERE kind IN ('queue_low', 'queue_empty')");
    expect(sent.filter((s) => s.kind === "queue_low")).toHaveLength(2);
    expect(sent.filter((s) => s.kind === "queue_empty")).toHaveLength(2);
  });

  it("deletes clip files 48 hours after they are posted everywhere", async () => {
    const clips = await query<{ status: string }>("SELECT status FROM clips WHERE source_video_id = $1", [source.id]);
    // The last clips went out ~15 days in; 24 simulated days later all files are gone.
    expect(clips.every((c) => c.status === "deleted")).toBe(true);
  });

  it("learns best times and proposes a posting-time change that can be applied and undone", async () => {
    // Queue a second batch at deliberately poor hours so the rule has something to fix.
    const second = await seedSource({ clips: 10, mode: "automation", ppd: 2 });
    const now = new Date(start.getTime() + 25 * 86400_000);
    await commitPlan(user, second, now);
    const posts = await query<{ id: string }>("SELECT id FROM posts WHERE status = 'queued' AND account_id = 'acc-youtube' ORDER BY scheduled_at", []);
    for (const [i, p] of posts.entries()) {
      const t = DateTime.fromJSDate(now).setZone(TZ).plus({ days: 1 + Math.floor(i / 2) }).set({ hour: i % 2 ? 9 : 8, minute: 0 });
      await query("UPDATE posts SET scheduled_at = $1 WHERE id = $2", [t.toJSDate(), p.id]);
    }
    await generateSuggestions(user.id, now);
    const s = await queryOne<{ id: string; title: string; proposed_change: { hours: number[] } }>(
      "SELECT * FROM suggestions WHERE type = 'posting_time' AND account_id = 'acc-youtube'",
    );
    expect(s).not.toBeNull();
    // The simulated audience peaks around 12:00 and 20:00, so that's what it should learn.
    expect(s!.proposed_change.hours.some((h) => h >= 19 && h <= 21)).toBe(true);

    const before = await query<{ id: string; scheduled_at: Date }>("SELECT id, scheduled_at FROM posts WHERE status = 'queued' AND account_id = 'acc-youtube' ORDER BY id");
    await applySuggestion(user.id, s!.id, now);
    const moved = await query<{ scheduled_at: Date }>("SELECT scheduled_at FROM posts WHERE status = 'queued' AND account_id = 'acc-youtube'");
    for (const p of moved) expect(s!.proposed_change.hours).toContain(DateTime.fromJSDate(new Date(p.scheduled_at)).setZone(TZ).hour);

    await undoSuggestion(user.id, s!.id, now);
    const after = await query<{ id: string; scheduled_at: Date }>("SELECT id, scheduled_at FROM posts WHERE status = 'queued' AND account_id = 'acc-youtube' ORDER BY id");
    expect(after.map((p) => new Date(p.scheduled_at).toISOString())).toEqual(before.map((p) => new Date(p.scheduled_at).toISOString()));
    const log = await query("SELECT action FROM audit_log WHERE action LIKE 'suggestion.%'");
    expect(log).toHaveLength(2);
  });

  it("Post now publishes a manual clip immediately", async () => {
    const manual = await seedSource({ clips: 1, mode: "manual" });
    const clip = await queryOne<{ id: string }>("SELECT id FROM clips WHERE source_video_id = $1", [manual.id]);
    const accounts = await query<never>("SELECT * FROM connected_accounts WHERE user_id = $1", [user.id]);
    const now = new Date(start.getTime() + 26 * 86400_000);
    const ids = await createPostNow(user, clip!.id, accounts, now);
    expect(ids).toHaveLength(2);
    await runPostsNow(ids, now);
    await runPostsNow(ids, now); // Instagram needs a second pass (container → publish)
    const statuses = await query<{ status: string }>("SELECT status FROM posts WHERE id = ANY($1)", [ids]);
    expect(statuses.every((p) => p.status === "published")).toBe(true);
  });

  it("marks a post that can't be fixed by retrying as needing attention, and emails once", async () => {
    const broken = await seedSource({ clips: 1, mode: "manual" });
    const clip = await queryOne<{ id: string }>("SELECT id FROM clips WHERE source_video_id = $1", [broken.id]);
    await query("UPDATE clips SET status = 'deleted' WHERE id = $1", [clip!.id]);
    const account = await query<never>("SELECT * FROM connected_accounts WHERE platform = 'youtube'");
    const now = new Date(start.getTime() + 27 * 86400_000);
    // createPostNow refuses deleted-but-not-uploading clips? It only blocks "uploading", so this goes through.
    const ids = await createPostNow(user, clip!.id, account, now);
    await runPostsNow(ids, now);
    const post = await queryOne<{ status: string; last_error: string }>("SELECT status, last_error FROM posts WHERE id = $1", [ids[0]]);
    expect(post!.status).toBe("needs_attention");
    expect(post!.last_error).toMatch(/no longer available/);
    const mail = await query("SELECT key FROM notifications WHERE kind = 'post_failed'");
    expect(mail).toHaveLength(1);
  });
});
