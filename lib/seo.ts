import { env, features } from "./env";
import { baseTitle, normalizeHashtags } from "./captions";

// Writes a title, description, tags and hashtags for every clip, aimed at views:
//  - Gemini (GEMINI_API_KEY, free tier; preferred) or Claude (ANTHROPIC_API_KEY) look at two frames of
//    each clip plus the member's topic/title, and write platform-specific text.
//  - Without a key (or if the AI call fails) a built-in rule-based writer is used.
// All output is cleaned to each platform's limits before it's saved.

export type SeoEngine = "claude" | "gemini" | "rules";

export type ClipSeo = {
  engine: SeoEngine;
  youtube: { title: string; description: string; tags: string[] };
  instagram: { caption: string };
  hashtags: string[]; // 3–5 focused hashtags, used on both platforms
  keywords: string[];
};

export type SeoSource = {
  title: string;
  filename: string;
  description: string;
  hashtags: string;
  topic: string;
  language: string;
  format: "original" | "vertical";
  /** Lessons from this member's own results, approved on the Suggestions page. */
  guidance?: string[];
};

export type SeoClipInput = {
  clipId: string;
  idx: number; // 0-based position in the video
  total: number; // number of clips from this video
  startSec: number;
  duration: number;
  frames: string[]; // base64 JPEG (no data: prefix)
};

type RawClip = {
  clip: number;
  youtube_title: string;
  youtube_description: string;
  youtube_tags: string[];
  instagram_caption: string;
  hashtags: string[];
  keywords: string[];
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM = `You are a senior short-form video growth strategist who writes metadata for YouTube Shorts and Instagram Reels that earns views, watch time, comments and follows.

For EACH clip you receive (frames from the clip plus context), write:
- youtube_title: 40–70 characters. Front-load the main search keyword, then a curiosity hook or clear payoff. Specific beats generic. At most one emoji. No ALL CAPS words except short acronyms. Never include hashtags or "Part N" in the title.
- youtube_description: 2–4 short lines. Line 1 repeats the core keywords naturally and says what happens. Then one line of context. Then a comment-driving question and a subscribe line. No hashtags (they're added separately).
- youtube_tags: 8–15 search phrases people would actually type (mix broad and long-tail, include the topic and any names that are clearly given in the context). No '#'.
- instagram_caption: first line is a scroll-stopping hook under 125 characters (it's all people see before "more"). Then 1–2 short lines of context or value. End with a question that invites comments, and a "save/share/follow" nudge. No hashtags.
- hashtags: 3–5 focused hashtags (without spaces), from specific/niche to broader. Include the creator's own hashtags if they gave any. Avoid spammy tags like #viral #fyp #foryou #like4like.
- keywords: 3–6 core keywords for this clip.

Rules:
- Base every clip's text on what is actually visible in its frames and on the given context. Never invent names, events or facts that aren't shown or given. If you can't tell what the clip shows, write around the given topic.
- Every clip in a series needs a DIFFERENT title angle (question, bold statement, "wait for it", reveal, relatable reaction, number, how/why...). Don't reuse titles listed as already used.
- Titles and captions must be honest: the clip must deliver what the title promises (misleading clickbait is punished by both platforms).
- Write in the requested language. Hashtags and tags may mix in English search terms when that's how people search.`;

function contextText(source: SeoSource, clips: SeoClipInput[], usedTitles: string[]): string {
  const lines = [
    `Video: "${baseTitle(source.title, source.filename)}"`,
    source.topic && `What it's about (from the creator): ${source.topic}`,
    source.description && `Creator's description: ${source.description}`,
    source.hashtags && `Creator's hashtags (keep them): ${normalizeHashtags(source.hashtags).join(" ")}`,
    `Format: ${source.format === "vertical" ? "vertical 9:16 Shorts/Reels" : "original aspect ratio"}`,
    `Language: ${source.language || "same language as the creator's text; English if none"}`,
    `The video was split into ${clips[0]?.total ?? clips.length} clips posted as a series.`,
    usedTitles.length ? `Titles already used in this series (don't repeat): ${usedTitles.slice(-40).map((t) => `"${t}"`).join("; ")}` : "",
    source.guidance?.length
      ? `Lessons from this creator's own results (the creator approved these; follow them):\n${source.guidance.map((g) => `- ${g}`).join("\n")}`
      : "",
    `Write metadata for these ${clips.length} clips (use each clip's number in "clip"):`,
  ];
  return lines.filter(Boolean).join("\n");
}

const clipLabel = (c: SeoClipInput) =>
  `Clip ${c.idx + 1} of ${c.total}: starts at ${fmtTime(c.startSec)} in the video, ${Math.round(c.duration)} s long.${c.frames.length ? " Frames:" : " (no frames available)"}`;

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

const ITEM_PROPS = {
  clip: { type: "integer", description: "The clip number" },
  youtube_title: { type: "string" },
  youtube_description: { type: "string" },
  youtube_tags: { type: "array", items: { type: "string" } },
  instagram_caption: { type: "string" },
  hashtags: { type: "array", items: { type: "string" } },
  keywords: { type: "array", items: { type: "string" } },
};
const REQUIRED = Object.keys(ITEM_PROPS);

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

async function callClaude(source: SeoSource, clips: SeoClipInput[], usedTitles: string[]): Promise<RawClip[]> {
  type Block = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };
  const content: Block[] = [{ type: "text", text: contextText(source, clips, usedTitles) }];
  for (const c of clips) {
    content.push({ type: "text", text: clipLabel(c) });
    for (const f of c.frames) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f } });
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.anthropicApiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: env.claudeModel,
      max_tokens: 1200 * clips.length + 500,
      system: SYSTEM,
      tools: [
        {
          name: "save_clip_metadata",
          description: "Save the metadata written for every clip.",
          input_schema: {
            type: "object",
            properties: { clips: { type: "array", items: { type: "object", properties: ITEM_PROPS, required: REQUIRED } } },
            required: ["clips"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "save_clip_metadata" },
      messages: [{ role: "user", content }],
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { content?: { type: string; input?: { clips?: RawClip[] } }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Claude: ${json.error?.message || res.status}`);
  const out = json.content?.find((b) => b.type === "tool_use")?.input?.clips;
  if (!Array.isArray(out)) throw new Error("Claude returned no clip metadata.");
  return out;
}

function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // Gemini's responseSchema uses upper-case type names.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "type") out.type = String(v).toUpperCase();
    else if (k === "description") continue;
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, geminiSchema(pv as Record<string, unknown>)])) : geminiSchema(v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out;
}

async function callGemini(source: SeoSource, clips: SeoClipInput[], usedTitles: string[]): Promise<RawClip[]> {
  const parts: ({ text: string } | { inline_data: { mime_type: string; data: string } })[] = [{ text: contextText(source, clips, usedTitles) }];
  for (const c of clips) {
    parts.push({ text: clipLabel(c) });
    for (const f of c.frames) parts.push({ inline_data: { mime_type: "image/jpeg", data: f } });
  }
  const schema = geminiSchema({ type: "array", items: { type: "object", properties: ITEM_PROPS, required: REQUIRED } });
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.geminiModel)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.geminiApiKey, "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.9 },
    }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`Gemini: ${json.error?.message || res.status}`);
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const out = JSON.parse(text) as RawClip[];
  if (!Array.isArray(out)) throw new Error("Gemini returned no clip metadata.");
  return out;
}

// Built-in writer: no AI. Varied hook patterns that read well around any topic phrase
// (the topic is always used as a label, never inside a sentence).
const HOOKS = [
  (t: string) => `${t}: wait for the end 😳`,
  (t: string) => `This moment hits different | ${t}`,
  (t: string) => `Nobody saw this coming | ${t}`,
  (t: string) => `${t}: the scene everyone replays`,
  (t: string) => `Watch till the end | ${t}`,
  (t: string) => `${t}: did you notice this?`,
  (t: string) => `Rate this moment 1–10 | ${t}`,
  (t: string) => `${t}: it only gets better`,
  (t: string) => `The part everyone talks about | ${t}`,
  (t: string) => `${t}: don't skip this one`,
];
const QUESTIONS = ["Which moment was your favourite?", "Rate this 1–10 in the comments.", "Did you see that coming?", "Who should see this? Tag them."];
const STOP = new Set("the a an and or of to in on for with this that is are was were be it its at by from as my your our part clip clips video full hd official new best".split(" "));

/** Hashtags from a phrase: the whole phrase joined if short, plus its first and last word pairs (#bigbuckbunny, #funnymoments). */
function phraseTags(phrase: string): string[] {
  const words = phrase.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
  const out = new Set<string>();
  if (words.length && words.join("").length <= 22) out.add(words.join(""));
  if (words.length >= 3 && words.slice(0, 3).join("").length <= 18) out.add(words.slice(0, 3).join(""));
  else if (words.length >= 2) out.add(words.slice(0, 2).join(""));
  if (words.length >= 2) out.add(words.slice(-2).join(""));
  if (words.length === 1) out.add(words[0]);
  return [...out].filter((t) => t.length >= 3).map((t) => `#${t}`);
}

export function rulesSeo(source: SeoSource, c: SeoClipInput): RawClip {
  const topic = (source.topic || baseTitle(source.title, source.filename)).replace(/\s+/g, " ").trim().slice(0, 50);
  const hook = HOOKS[c.idx % HOOKS.length](topic);
  const words = `${topic} ${source.title} ${source.description}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  const uniq = [...new Set(words)];
  const topicLc = topic.toLowerCase();
  // Search phrases: the topic and its common variants, then meaningful single words (4+ letters).
  const tags = [topicLc, `${topicLc} shorts`, `${topicLc} clips`, `${topicLc} best moments`, ...uniq.filter((w) => w.length >= 4)];
  const hashtags = [...normalizeHashtags(source.hashtags), ...phraseTags(topic), ...phraseTags(source.title)];
  const question = QUESTIONS[c.idx % QUESTIONS.length];
  return {
    clip: c.idx + 1,
    youtube_title: hook,
    youtube_description: [`${topic}${c.total > 1 ? ` – part ${c.idx + 1} of ${c.total}` : ""}.`, source.description.trim(), `💬 ${question}`, "🔔 Subscribe for the next part."]
      .filter(Boolean)
      .join("\n"),
    youtube_tags: tags,
    instagram_caption: [hook, source.description.trim(), `💬 ${question}`, "Save this and follow for more 👉"].filter(Boolean).join("\n\n"),
    hashtags,
    keywords: uniq.slice(0, 6),
  };
}

// ---------------------------------------------------------------------------
// Cleaning to platform limits
// ---------------------------------------------------------------------------

const oneLine = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

function cutAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, "");
}

export function cleanSeo(raw: RawClip, engine: SeoEngine, source: SeoSource): ClipSeo {
  const title = cutAtWord(
    oneLine(raw.youtube_title)
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .replace(/#[\p{L}\p{N}_]+/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim(),
    90,
  );
  // YouTube: tags ≤ 500 characters in total (we keep a margin), each tag ≤ 60.
  const tags: string[] = [];
  let tagChars = 0;
  for (const t of (Array.isArray(raw.youtube_tags) ? raw.youtube_tags : []).map((t) => oneLine(t).replace(/^#/, "").replace(/[<>"]/g, "").slice(0, 60))) {
    if (!t || tags.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
    if (tagChars + t.length + 1 > 450) break;
    tags.push(t);
    tagChars += t.length + 1;
  }
  // Creator's own hashtags first, then the writer's; 5 at most (focused beats many).
  const spam = new Set(["#viral", "#fyp", "#foryou", "#foryoupage", "#like4like", "#follow4follow", "#trending", "#explore"]);
  const hashtags: string[] = [];
  for (const h of [...normalizeHashtags(source.hashtags), ...normalizeHashtags((Array.isArray(raw.hashtags) ? raw.hashtags : []).join(" "))]) {
    if (spam.has(h.toLowerCase()) || hashtags.some((x) => x.toLowerCase() === h.toLowerCase())) continue;
    if (hashtags.length < 5) hashtags.push(h);
  }
  const strip = (s: unknown) => String(s ?? "").replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "$1").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return {
    engine,
    youtube: { title: title || baseTitle(source.title, source.filename).slice(0, 90), description: strip(raw.youtube_description).slice(0, 4000), tags },
    instagram: { caption: strip(raw.instagram_caption).slice(0, 1900) },
    hashtags,
    keywords: (Array.isArray(raw.keywords) ? raw.keywords : []).map(oneLine).filter(Boolean).slice(0, 6),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Writes metadata for a batch of clips (one AI request for the whole batch). Falls back to the
 * built-in writer for any clip the AI didn't cover, or for all of them if the AI call fails.
 */
export async function writeSeo(
  source: SeoSource,
  clips: SeoClipInput[],
  usedTitles: string[] = [],
): Promise<{ results: Map<string, ClipSeo>; engine: SeoEngine; warning?: string }> {
  const engine = features.seoEngine;
  const results = new Map<string, ClipSeo>();
  let warning: string | undefined;
  if (engine !== "rules" && clips.length) {
    try {
      const raw = engine === "claude" ? await callClaude(source, clips, usedTitles) : await callGemini(source, clips, usedTitles);
      for (const r of raw) {
        const clip = clips.find((c) => c.idx + 1 === Number(r?.clip));
        if (clip && !results.has(clip.clipId)) results.set(clip.clipId, cleanSeo(r, engine, source));
      }
    } catch (err) {
      warning = `${(err as Error).message}. Used the built-in writer instead.`;
    }
  }
  for (const c of clips) {
    if (!results.has(c.clipId)) results.set(c.clipId, cleanSeo(rulesSeo(source, c), "rules", source));
  }
  const used = [...results.values()].map((r) => r.engine);
  return { results, engine: used.every((e) => e === engine) ? engine : "rules", warning };
}

/** Tiny text-only request, used by the setup checks to confirm the key and model work. */
export async function pingSeoEngine(): Promise<string> {
  const source: SeoSource = { title: "Test", filename: "test.mp4", description: "", hashtags: "", topic: "cooking pasta", language: "English", format: "vertical" };
  const clip: SeoClipInput = { clipId: "x", idx: 0, total: 1, startSec: 0, duration: 30, frames: [] };
  const raw = features.seoEngine === "claude" ? await callClaude(source, [clip], []) : await callGemini(source, [clip], []);
  return cleanSeo(raw[0], features.seoEngine, source).youtube.title;
}

// ---------------------------------------------------------------------------
// Generic structured AI call (used by AI suggestions)
// ---------------------------------------------------------------------------

/**
 * Sends text to the configured AI (Gemini first, else Claude) and returns JSON matching `schema`
 * (a JSON-schema object using lower-case types). Throws when no AI key is configured.
 */
export async function aiJson<T>(system: string, prompt: string, schema: Record<string, unknown>, maxTokens = 4000): Promise<T> {
  if (features.seoEngine === "gemini") {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.geminiModel)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": env.geminiApiKey, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: geminiSchema(schema), temperature: 0.4, maxOutputTokens: maxTokens },
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } };
    if (!res.ok) throw new Error(`Gemini: ${json.error?.message || res.status}`);
    return JSON.parse(json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") || "null") as T;
  }
  if (features.seoEngine === "claude") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.anthropicApiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: env.claudeModel,
        max_tokens: maxTokens,
        system,
        tools: [{ name: "answer", description: "Return the answer.", input_schema: schema }],
        tool_choice: { type: "tool", name: "answer" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { content?: { type: string; input?: T }[]; error?: { message?: string } };
    if (!res.ok) throw new Error(`Claude: ${json.error?.message || res.status}`);
    const out = json.content?.find((b) => b.type === "tool_use")?.input;
    if (!out) throw new Error("Claude returned no answer.");
    return out;
  }
  throw new Error("No AI key configured (GEMINI_API_KEY).");
}
