import { afterEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import { cleanSeo, rulesSeo, type SeoClipInput, type SeoSource } from "@/lib/seo";
import { buildOptimizedInstagram, buildOptimizedYouTube } from "@/lib/captions";
import { defaultScores, pickDailyHours, planSlots } from "@/lib/planner";

// Title & caption writer: built-in rules, cleaning to platform limits, AI responses (mocked),
// fallbacks, and 5 posts per day.

const source: SeoSource = {
  title: "Frozen 2 scenes",
  filename: "frozen2.mp4",
  description: "",
  hashtags: "#frozen2 #elsa",
  topic: "Frozen 2 best scenes",
  language: "",
  format: "vertical",
};
const clip = (idx: number, total = 10): SeoClipInput => ({ clipId: `c${idx}`, idx, total, startSec: idx * 60, duration: 60, frames: [] });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("built-in writer", () => {
  it("gives every clip a different, clean title within limits", () => {
    const seos = Array.from({ length: 10 }, (_, i) => cleanSeo(rulesSeo(source, clip(i)), "rules", source));
    expect(new Set(seos.map((s) => s.youtube.title)).size).toBe(10);
    for (const s of seos) {
      expect(s.youtube.title.length).toBeLessThanOrEqual(90);
      expect(s.youtube.title).not.toMatch(/#/);
      expect(s.youtube.tags.join(",").length).toBeLessThanOrEqual(450);
      expect(s.hashtags.length).toBeLessThanOrEqual(5);
      expect(s.hashtags.slice(0, 2)).toEqual(["#frozen2", "#elsa"]); // the creator's own hashtags come first
      expect(s.instagram.caption).not.toMatch(/#\w/);
    }
  });
});

describe("cleaning AI output", () => {
  it("enforces platform limits and drops spam hashtags", () => {
    const s = cleanSeo(
      {
        clip: 1,
        youtube_title: `"${"Elsa finally shows her real power in this unforgettable scene ".repeat(3)} #shorts"`,
        youtube_description: "Line one #tag\nLine two",
        youtube_tags: Array.from({ length: 60 }, (_, i) => `frozen 2 keyword number ${i}`),
        instagram_caption: "Hook line #frozen\n\nQuestion?",
        hashtags: ["#viral", "#fyp", "frozen", "#disney", "#animation", "#elsa", "#anna", "#olaf"],
        keywords: ["frozen 2"],
      },
      "claude",
      source,
    );
    expect(s.youtube.title.length).toBeLessThanOrEqual(90);
    expect(s.youtube.title).not.toMatch(/#|"/);
    expect(s.youtube.tags.join(",").length).toBeLessThanOrEqual(450);
    expect(s.hashtags).toEqual(["#frozen2", "#elsa", "#frozen", "#disney", "#animation"]);
    expect(s.youtube.description).not.toMatch(/#tag/);
    expect(s.instagram.caption).not.toMatch(/#frozen/);
  });

  it("builds platform text: #Shorts in the description, series line on Instagram", () => {
    const s = cleanSeo(rulesSeo(source, clip(2)), "rules", source);
    const yt = buildOptimizedYouTube(s, { vertical: true, duration: 60 });
    expect(yt.title).not.toMatch(/#Shorts/);
    expect(yt.description).toMatch(/#Shorts/);
    expect(yt.tags.length).toBeGreaterThan(3);
    const ig = buildOptimizedInstagram(s, { part: 3, totalParts: 10 });
    expect(ig).toMatch(/Part 3\/10/);
    expect(ig.length).toBeLessThanOrEqual(2200);
  });
});

describe("AI engines (mocked)", () => {
  const aiClip = (n: number) => ({
    clip: n,
    youtube_title: `AI title ${n}`,
    youtube_description: "desc",
    youtube_tags: ["frozen 2"],
    instagram_caption: "caption",
    hashtags: ["#disney"],
    keywords: ["frozen"],
  });

  it("uses Claude when ANTHROPIC_API_KEY is set, and fills gaps with the built-in writer", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "tool_use", input: { clips: [aiClip(1)] } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { writeSeo } = await import("@/lib/seo");
    const { results, warning } = await writeSeo(source, [clip(0, 2), clip(1, 2)]);
    expect(warning).toBeUndefined();
    expect(results.get("c0")!.engine).toBe("claude");
    expect(results.get("c0")!.youtube.title).toBe("AI title 1");
    expect(results.get("c1")!.engine).toBe("rules"); // the AI skipped clip 2
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(JSON.parse(String(init.body)).tool_choice.name).toBe("save_clip_metadata");
  });

  it("uses Gemini when only GEMINI_API_KEY is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "g-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify([aiClip(1)]) }] } }] }), { status: 200 })),
    );
    const { writeSeo } = await import("@/lib/seo");
    const { results, engine } = await writeSeo(source, [clip(0, 1)]);
    expect(engine).toBe("gemini");
    expect(results.get("c0")!.youtube.title).toBe("AI title 1");
  });

  it("falls back to the built-in writer when the AI call fails", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "bad-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })));
    const { writeSeo } = await import("@/lib/seo");
    const { results, engine, warning } = await writeSeo(source, [clip(0, 1)]);
    expect(engine).toBe("rules");
    expect(warning).toMatch(/invalid x-api-key/);
    expect(results.get("c0")!.youtube.title.length).toBeGreaterThan(5);
  });
});

describe("5 posts per day", () => {
  it("picks 5 well-spaced hours and plans 5 posts every day", () => {
    const hours = pickDailyHours(defaultScores(), 5);
    expect(hours).toHaveLength(5);
    for (let i = 1; i < hours.length; i++) expect(hours[i] - hours[i - 1]).toBeGreaterThanOrEqual(2);
    const slots = planSlots({ count: 25, hours, timezone: "Asia/Kolkata", after: new Date("2026-10-01T00:00:00Z") });
    const perDay = new Map<string, number>();
    for (const s of slots) {
      const d = DateTime.fromJSDate(s).setZone("Asia/Kolkata").toISODate()!;
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    expect([...perDay.values()].every((n) => n <= 5)).toBe(true);
    expect(perDay.size).toBeLessThanOrEqual(6);
  });
});
