import { NextResponse } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/lib/db";
import { HttpError, readJson, withUser } from "@/lib/http";
import { audit } from "@/lib/session";

type Ctx = { params: Promise<{ id: string }> };

async function ownPost(id: string, userId: string) {
  const post = await queryOne<{ id: string; status: string; scheduled_at: Date; clip_id: string; platform: string }>(
    "SELECT id, status, scheduled_at, clip_id, platform FROM posts WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  if (!post) throw new HttpError(404, "Post not found.");
  return post;
}

const Patch = z.union([
  z.object({ scheduledAt: z.string().datetime({ offset: true }) }),
  z.object({ title: z.string().trim().min(1).max(100), caption: z.string().max(5000) }),
]);

// Move a waiting post to another time, or edit its title/caption before it goes out.
export const PATCH = withUser<Ctx>(async (req, user, ctx) => {
  const { id } = await ctx.params;
  const post = await ownPost(id, user.id);
  const body = await readJson(req, Patch);
  if ("title" in body) {
    if (!["queued", "needs_attention"].includes(post.status)) throw new HttpError(400, "Only posts that haven't gone out yet can be edited.");
    const limit = post.platform === "instagram" ? 2200 : 5000;
    if (body.caption.length > limit) throw new HttpError(400, `The caption is too long (${body.caption.length}/${limit} characters).`);
    await query("UPDATE posts SET title = $1, caption = $2 WHERE id = $3 AND status IN ('queued', 'needs_attention')", [body.title, body.caption, id]);
    await audit(user.id, "post.edited", { postId: id });
    return NextResponse.json({ ok: true });
  }
  if (post.status !== "queued") throw new HttpError(400, "Only waiting posts can be moved.");
  const when = new Date(body.scheduledAt);
  if (when.getTime() < Date.now() - 60_000) throw new HttpError(400, "Pick a time in the future.");
  await query("UPDATE posts SET scheduled_at = $1 WHERE id = $2 AND status = 'queued'", [when, id]);
  await audit(user.id, "post.moved", { postId: id, from: post.scheduled_at, to: when });
  return NextResponse.json({ ok: true });
});

// Cancel a post that hasn't gone out yet.
export const DELETE = withUser<Ctx>(async (_req, user, ctx) => {
  const { id } = await ctx.params;
  const post = await ownPost(id, user.id);
  if (!["queued", "needs_attention"].includes(post.status)) throw new HttpError(400, "This post can't be cancelled now.");
  await query("UPDATE posts SET status = 'cancelled' WHERE id = $1 AND status = ANY($2)", [id, ["queued", "needs_attention"]]);
  await audit(user.id, "post.cancelled", { postId: id });
  return NextResponse.json({ ok: true });
});

// Retry a post that needs attention (for example after reconnecting the account).
export const POST = withUser<Ctx>(async (_req, user, ctx) => {
  const { id } = await ctx.params;
  const post = await ownPost(id, user.id);
  if (post.status !== "needs_attention") throw new HttpError(400, "Only failed posts can be retried.");
  const clip = await queryOne<{ status: string }>("SELECT status FROM clips WHERE id = $1", [post.clip_id]);
  if (!clip || clip.status === "deleted") throw new HttpError(400, "The clip file was already deleted. Upload the video again.");
  await query(
    `UPDATE posts SET status = 'queued', attempts = 0, next_attempt_at = NULL, last_error = NULL, container_id = NULL,
            scheduled_at = LEAST(scheduled_at, now()) WHERE id = $1`,
    [id],
  );
  await query("UPDATE clips SET delete_after = NULL WHERE id = $1", [post.clip_id]);
  await audit(user.id, "post.retried", { postId: id });
  return NextResponse.json({ ok: true });
});
