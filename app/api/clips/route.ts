import { NextResponse } from "next/server";
import { z } from "zod";
import { newId, query } from "@/lib/db";
import { HttpError, readJson, withUser } from "@/lib/http";
import { uploadTarget, type UploadTarget } from "@/lib/storage";
import { getSource, queueBytes, queueCapBytes } from "@/lib/schedule";

// Registers clips and returns one-hour upload targets. The browser uploads straight to storage.
const Body = z.object({
  sourceVideoId: z.string(),
  clips: z
    .array(
      z.object({
        idx: z.number().int().min(0),
        bytes: z.number().int().positive().max(1024 * 1024 * 1024),
        duration: z.number().positive(),
        startSec: z.number().min(0),
        width: z.number().int().nullable(),
        height: z.number().int().nullable(),
        contentType: z.string().regex(/^video\//),
        ext: z.string().regex(/^\.[a-z0-9]{2,4}$/),
      }),
    )
    .min(1)
    .max(1000),
});

export const POST = withUser(async (req, user) => {
  const body = await readJson(req, Body);
  const source = await getSource(user, body.sourceVideoId);
  const existing = new Map(
    (await query<{ id: string; idx: number; storage_key: string }>("SELECT id, idx, storage_key FROM clips WHERE source_video_id = $1", [source.id])).map(
      (c) => [c.idx, c],
    ),
  );
  const incoming = body.clips.filter((c) => !existing.has(c.idx)).reduce((n, c) => n + c.bytes, 0);
  const used = await queueBytes(user.id);
  const cap = queueCapBytes();
  if (used + incoming > cap) {
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    throw new HttpError(
      413,
      `Your queue would hold ${mb(used + incoming)} MB, over the ${mb(cap)} MB limit per member (it keeps the team inside the free storage). Use shorter or fewer clips now and add the rest when the queue runs low.`,
    );
  }
  const out: { idx: number; clipId: string; upload: UploadTarget }[] = [];
  for (const c of body.clips) {
    let clip = existing.get(c.idx);
    if (!clip) {
      const id = newId();
      const key = `clips/${user.id}/${source.id}/${String(c.idx + 1).padStart(4, "0")}-${id}${c.ext}`;
      await query(
        `INSERT INTO clips (id, source_video_id, user_id, idx, storage_key, bytes, duration, width, height, start_sec, content_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, source.id, user.id, c.idx, key, c.bytes, c.duration, c.width, c.height, c.startSec, c.contentType],
      );
      clip = { id, idx: c.idx, storage_key: key };
    }
    out.push({ idx: c.idx, clipId: clip.id, upload: await uploadTarget(clip.storage_key, c.contentType, c.bytes) });
  }
  return NextResponse.json({ clips: out });
});
