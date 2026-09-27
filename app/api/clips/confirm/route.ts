import { NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/lib/db";
import { readJson, withUser } from "@/lib/http";
import { objectSize } from "@/lib/storage";

// Marks uploaded clips as ready after checking the file really arrived in storage.
const Body = z.object({ clipIds: z.array(z.string()).min(1).max(1000) });

export const POST = withUser(async (req, user) => {
  const { clipIds } = await readJson(req, Body);
  const clips = await query<{ id: string; storage_key: string; bytes: number; status: string }>(
    "SELECT id, storage_key, bytes, status FROM clips WHERE id = ANY($1) AND user_id = $2",
    [clipIds, user.id],
  );
  const missing: string[] = [];
  for (const clip of clips) {
    if (clip.status !== "uploading") continue;
    const size = await objectSize(clip.storage_key);
    if (size == null || size !== Number(clip.bytes)) {
      missing.push(clip.id);
      continue;
    }
    await query("UPDATE clips SET status = 'ready' WHERE id = $1 AND status = 'uploading'", [clip.id]);
  }
  return NextResponse.json({ ok: missing.length === 0, missing });
});
