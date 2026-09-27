import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Weekly AI review (Gemini, mocked) → suggestions; approving a title lesson teaches the writer;
// undo removes it; the review runs at most once a week. Also: Google "Testing mode" detection.

const USER = "ai-user";
const ACC = "ai-acc";
let mod: {
  db: typeof import("@/lib/db");
  sugg: typeof import("@/lib/suggestions");
  seo: typeof import("@/lib/seo");
  yt: typeof import("@/lib/platforms/youtube");
};
const fetchMock = vi.fn();

beforeAll(async () => {
  vi.stubEnv("GEMINI_API_KEY", "test-gemini");
  vi.stubEnv("GOOGLE_CLIENT_ID", "cid");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  mod = {
    db: await import("@/lib/db"),
    sugg: await import("@/lib/suggestions"),
    seo: await import("@/lib/seo"),
    yt: await import("@/lib/platforms/youtube"),
  };
  const { query } = mod.db;
  await query("INSERT INTO users (id, email, name, timezone) VALUES ($1, 'ai@example.com', 'AI', 'Asia/Kolkata')", [USER]);
  await query(
    `INSERT INTO connected_accounts (id, user_id, platform, external_id, name, meta) VALUES ($1, $2, 'instagram', 'ig-ai', '@ai', '{"dryRun":true}')`,
    [ACC, USER],
  );
  await query(
    `INSERT INTO source_videos (id, user_id, filename, duration, mode, account_ids, clip_length, format, posts_per_day)
     VALUES ('ai-src', $1, 'v.mp4', 600, 'automation', $2, 60, 'vertical', 2)`,
    [USER, [ACC]],
  );
  for (let i = 0; i < 10; i++) {
    await query(
      `INSERT INTO clips (id, source_video_id, user_id, idx, storage_key, bytes, duration, start_sec, status)
       VALUES ($1, 'ai-src', $2, $3, 'k', 100, 60, $4, 'posted')`,
      [`ai-clip-${i}`, USER, i, i * 60],
    );
    const published = new Date(Date.now() - (i + 2) * 86400_000);
    await query(
      `INSERT INTO posts (id, clip_id, account_id, user_id, platform, scheduled_at, status, title, caption, published_at, idempotency_key)
       VALUES ($1, $2, $3, $4, 'instagram', $5, 'published', $6, $7, $5, $1)`,
      [`ai-post-${i}`, `ai-clip-${i}`, ACC, USER, published, i % 2 ? `Why did this happen? #${i}` : `Clip ${i}`, `Hook ${i}\n\n#test`],
    );
    await query(
      `INSERT INTO metric_snapshots (id, post_id, hours_after, views, likes, comments, shares, saves, avg_watch_sec)
       VALUES ($1, $2, 24, $3, 10, 2, 3, 4, 20)`,
      [`ai-m-${i}`, `ai-post-${i}`, i % 2 ? 2000 : 700],
    );
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const geminiReply = (obj: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });

describe("weekly AI review", () => {
  it("turns Gemini's review into suggestions, once a week", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiReply({
        suggestions: [
          {
            kind: "hook",
            title: "Open titles with a question",
            evidence: "Question titles: median 2,000 views vs 700 (5 posts each).",
            action: "Write the first line as a question about the outcome.",
            writer_lesson: "Start titles and captions with a question about what happens next.",
          },
          { kind: "length", title: "Test 30-second clips", evidence: "Average watch is 20 s of 60 s.", action: "Cut the next upload at 30 s.", writer_lesson: "" },
        ],
      }),
    );
    await mod.sugg.generateSuggestions(USER);
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("generativelanguage"));
    expect(calls).toHaveLength(1);
    const prompt = JSON.parse(String((calls[0][1] as RequestInit).body)).contents[0].parts[0].text as string;
    expect(prompt).toContain("views 2000");
    expect(prompt).toContain("Why did this happen?");

    const rows = await mod.db.query<{ type: string; can_apply: boolean }>("SELECT type, can_apply FROM suggestions WHERE user_id = $1 ORDER BY type", [USER]);
    expect(rows.map((r) => [r.type, r.can_apply])).toEqual([
      ["ai_hook", true],
      ["ai_length", false],
    ]);

    // Second run in the same week: no new AI call.
    await mod.sugg.generateSuggestions(USER);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("generativelanguage"))).toHaveLength(1);
  });

  it("approving a lesson teaches the title writer; undo removes it", async () => {
    const s = await mod.db.queryOne<{ id: string }>("SELECT id FROM suggestions WHERE user_id = $1 AND type = 'ai_hook'", [USER]);
    await mod.sugg.applySuggestion(USER, s!.id);
    let prefs = (await mod.db.queryOne<{ prefs: { seoGuidance?: string[] } }>("SELECT prefs FROM users WHERE id = $1", [USER]))!.prefs;
    expect(prefs.seoGuidance).toEqual(["Start titles and captions with a question about what happens next."]);

    // The writer includes the lesson in its request.
    fetchMock.mockResolvedValueOnce(geminiReply([]));
    await mod.seo.writeSeo(
      { title: "t", filename: "f.mp4", description: "", hashtags: "", topic: "x", language: "", format: "vertical", guidance: prefs.seoGuidance },
      [{ clipId: "c", idx: 0, total: 1, startSec: 0, duration: 30, frames: [] }],
    );
    const body = String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body);
    expect(body).toContain("Start titles and captions with a question");

    await mod.sugg.undoSuggestion(USER, s!.id);
    prefs = (await mod.db.queryOne<{ prefs: { seoGuidance?: string[] } }>("SELECT prefs FROM users WHERE id = $1", [USER]))!.prefs;
    expect(prefs.seoGuidance).toBeUndefined();
  });
});

describe("YouTube connect", () => {
  it("detects a Google app still in Testing mode (7-day refresh token)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            expires_in: 3600,
            refresh_token_expires_in: 604799,
            scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ id: "UC1", snippet: { title: "My channel" } }] }), { status: 200 }));
    const r = await mod.yt.youtubeExchangeCode("code");
    expect(r.testingMode).toBe(true);
    expect(r.name).toBe("My channel");
  });

  it("explains what to do when a Google account has no channel", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "a",
            refresh_token: "r",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    await expect(mod.yt.youtubeExchangeCode("code")).rejects.toThrow(/create_channel/);
  });
});
