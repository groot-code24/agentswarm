import { NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/lib/db";
import { HttpError, readJson, withUser } from "@/lib/http";
import { getSource, type ClipRow } from "@/lib/schedule";
import { writeSeo } from "@/lib/seo";

export const maxDuration = 120;

// Writes optimized titles/descriptions/tags for a batch of uploaded clips and saves them on the
// clips. The browser sends two small JPEG frames per clip so the writer can see what's in it.
const Body = z.object({
  sourceVideoId: z.string(),
  clips: z
    .array(
      z.object({
        clipId: z.string(),
        frames: z.array(z.string().regex(/^[A-Za-z0-9+/=]+$/).max(400_000)).max(3).default([]),
      }),
    )
    .min(1)
    .max(12),
});

export const POST = withUser(async (req, user) => {
  const body = await readJson(req, Body);
  const source = await getSource(user, body.sourceVideoId);
  if (source.seo_mode !== "optimize") throw new HttpError(400, "This upload uses your own titles.");
  const ids = body.clips.map((c) => c.clipId);
  const rows = await query<ClipRow>("SELECT * FROM clips WHERE id = ANY($1) AND source_video_id = $2 AND user_id = $3", [ids, source.id, user.id]);
  if (rows.length !== ids.length) throw new HttpError(404, "Some clips weren't found.");
  const total = await query<{ n: number }>("SELECT COUNT(*)::int AS n FROM clips WHERE source_video_id = $1", [source.id]);
  const used = await query<{ t: string }>(
    "SELECT seo->'youtube'->>'title' AS t FROM clips WHERE source_video_id = $1 AND seo IS NOT NULL AND NOT (id = ANY($2)) ORDER BY idx",
    [source.id, ids],
  );
  const frames = new Map(body.clips.map((c) => [c.clipId, c.frames]));
  const { results, engine, warning } = await writeSeo(
    { ...source, guidance: user.prefs?.seoGuidance ?? [] },
    rows
      .sort((a, b) => a.idx - b.idx)
      .map((c) => ({
        clipId: c.id,
        idx: c.idx,
        total: Math.max(total[0]?.n ?? rows.length, c.idx + 1),
        startSec: Number(c.start_sec),
        duration: Number(c.duration),
        frames: frames.get(c.id) ?? [],
      })),
    used.map((u) => u.t).filter(Boolean),
  );
  for (const [clipId, seo] of results) {
    await query("UPDATE clips SET seo = $1::jsonb WHERE id = $2", [JSON.stringify(seo), clipId]);
  }
  return NextResponse.json({
    engine,
    warning: warning ?? null,
    clips: [...results].map(([clipId, seo]) => ({ clipId, title: seo.youtube.title, hashtags: seo.hashtags, engine: seo.engine })),
  });
});
