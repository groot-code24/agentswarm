import { NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/lib/db";
import { HttpError, readJson, withUser } from "@/lib/http";
import { listAccounts } from "@/lib/accounts";
import { createPostNow } from "@/lib/schedule";
import { runPostsNow } from "@/lib/scheduler";

export const maxDuration = 300;

// Manual mode: publish one clip now. Instagram may need a minute to process the video;
// then the post shows "processing" and the scheduler finishes it on the next tick.
const Body = z.object({ clipId: z.string(), accountIds: z.array(z.string()).min(1) });

export const POST = withUser(async (req, user) => {
  const { clipId, accountIds } = await readJson(req, Body);
  const accounts = (await listAccounts(user.id)).filter((a) => accountIds.includes(a.id));
  if (!accounts.length) throw new HttpError(400, "Choose at least one connected account.");
  const ids = await createPostNow(user, clipId, accounts);
  if (ids.length) {
    await runPostsNow(ids);
    // Instagram processes the video first; wait briefly and try to finish within this request.
    for (let i = 0; i < 4; i++) {
      const pending = await query("SELECT id FROM posts WHERE id = ANY($1) AND status = 'processing'", [ids]);
      if (!pending.length) break;
      await new Promise((r) => setTimeout(r, 8000));
      await runPostsNow(ids);
    }
  }
  const posts = await query<{ id: string; platform: string; status: string; permalink: string | null; last_error: string | null }>(
    "SELECT id, platform, status, permalink, last_error FROM posts WHERE clip_id = $1 AND user_id = $2",
    [clipId, user.id],
  );
  return NextResponse.json({ posts });
});
