import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { withUser } from "@/lib/http";
import { audit } from "@/lib/session";
import { getSource } from "@/lib/schedule";
import { deleteObject } from "@/lib/storage";

type Ctx = { params: Promise<{ id: string }> };

// Cancels every post of one uploaded video that hasn't gone out yet, and frees its clip
// storage right away. Posts that are uploading/processing at this moment are left to finish.
export const DELETE = withUser<Ctx>(async (_req, user, ctx) => {
  const { id } = await ctx.params;
  const source = await getSource(user, id);
  const cancelled = await query<{ id: string }>(
    `UPDATE posts SET status = 'cancelled', next_attempt_at = NULL
      WHERE user_id = $1 AND status IN ('queued', 'needs_attention')
        AND clip_id IN (SELECT id FROM clips WHERE source_video_id = $2)
      RETURNING id`,
    [user.id, source.id],
  );
  const clips = await query<{ id: string; storage_key: string; bytes: number }>(
    `SELECT id, storage_key, bytes FROM clips c
      WHERE c.source_video_id = $1 AND c.status IN ('uploading', 'ready', 'scheduled')
        AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = c.id AND p.status IN ('queued', 'uploading', 'processing'))`,
    [source.id],
  );
  let freed = 0;
  let pending = 0;
  for (const clip of clips) {
    try {
      await deleteObject(clip.storage_key);
      await query("UPDATE clips SET status = 'deleted' WHERE id = $1", [clip.id]);
      freed += Number(clip.bytes);
    } catch {
      // Storage hiccup: the regular cleanup deletes it on a later run.
      await query("UPDATE clips SET delete_after = now() WHERE id = $1", [clip.id]);
      pending++;
    }
  }
  await audit(user.id, "source.cancelled", { sourceVideoId: source.id, posts: cancelled.length, clipsDeleted: clips.length - pending });
  return NextResponse.json({ cancelled: cancelled.length, freedBytes: freed, pending });
});
