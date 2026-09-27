import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { HttpError, withUser } from "@/lib/http";
import { audit } from "@/lib/session";

// Disconnect: removes the tokens, upcoming posts and this account's post history and stats.
// Clip files that no longer have a post are cleaned up by the scheduler after 48 h.
export const DELETE = withUser<{ params: Promise<{ id: string }> }>(async (_req, user, ctx) => {
  const { id } = await ctx.params;
  const rows = await query<{ name: string; platform: string }>("SELECT name, platform FROM connected_accounts WHERE id = $1 AND user_id = $2", [id, user.id]);
  if (!rows.length) throw new HttpError(404, "Account not found.");
  const cancelled = await query(
    "SELECT id FROM posts WHERE account_id = $1 AND status IN ('queued', 'uploading', 'processing')",
    [id],
  );
  await query("DELETE FROM connected_accounts WHERE id = $1", [id]);
  await audit(user.id, "account.disconnected", { ...rows[0], cancelledPosts: cancelled.length });
  return NextResponse.json({ ok: true, cancelledPosts: cancelled.length });
});
