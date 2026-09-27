// Titles and captions from templates plus the member's own text (no AI API needed).

export function normalizeHashtags(input: string): string[] {
  const tags = input
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter(Boolean)
    .map((t) => `#${t}`);
  return [...new Set(tags)].slice(0, 15);
}

export function baseTitle(title: string, filename: string): string {
  const t = title.trim();
  if (t) return t;
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Clip";
}

export function buildYouTubeText(opts: {
  title: string;
  filename: string;
  description: string;
  hashtags: string;
  part: number;
  totalParts: number;
  vertical: boolean;
  duration: number;
}) {
  const tags = normalizeHashtags(opts.hashtags);
  // "#Shorts" helps YouTube file vertical clips (≤ 3 min) under Shorts.
  const shortsTag = opts.vertical && opts.duration <= 180 ? " #Shorts" : "";
  const part = opts.totalParts > 1 ? ` | Part ${opts.part}` : "";
  const room = 100 - part.length - shortsTag.length;
  const title = baseTitle(opts.title, opts.filename).slice(0, Math.max(10, room)) + part + shortsTag;
  const description = [opts.description.trim(), tags.join(" ")].filter(Boolean).join("\n\n");
  return { title, description, tags: tags.map((t) => t.slice(1)) };
}

export function buildInstagramCaption(opts: {
  title: string;
  filename: string;
  description: string;
  hashtags: string;
  part: number;
  totalParts: number;
}) {
  const part = opts.totalParts > 1 ? ` (Part ${opts.part}/${opts.totalParts})` : "";
  return [baseTitle(opts.title, opts.filename) + part, opts.description.trim(), normalizeHashtags(opts.hashtags).join(" ")]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 2200);
}

// ---------- Optimized text (from lib/seo.ts) ----------

type SeoText = {
  youtube: { title: string; description: string; tags: string[] };
  instagram: { caption: string };
  hashtags: string[];
};

export function buildOptimizedYouTube(seo: SeoText, opts: { vertical: boolean; duration: number }) {
  // "#Shorts" goes in the description (not the title), so the title keeps all its room for keywords.
  const shorts = opts.vertical && opts.duration <= 180 ? ["#Shorts"] : [];
  const hashtags = [...new Set([...shorts, ...seo.hashtags])];
  const description = [seo.youtube.description, hashtags.join(" ")].filter(Boolean).join("\n\n").slice(0, 5000);
  const tags = [...new Set([...seo.youtube.tags, ...seo.hashtags.map((h) => h.slice(1))])];
  return { title: seo.youtube.title.slice(0, 100), description, tags };
}

export function buildOptimizedInstagram(seo: SeoText, opts: { part: number; totalParts: number }) {
  const series = opts.totalParts > 1 ? `Part ${opts.part}/${opts.totalParts} · follow so you don't miss the next one` : "";
  return [seo.instagram.caption, series, seo.hashtags.join(" ")].filter(Boolean).join("\n\n").slice(0, 2200);
}
