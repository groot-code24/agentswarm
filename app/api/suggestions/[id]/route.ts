import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, readJson, withUser } from "@/lib/http";
import { applySuggestion, rejectSuggestion, undoSuggestion } from "@/lib/suggestions";

const Body = z.object({ action: z.enum(["apply", "reject", "undo"]) });

// Nothing is ever applied without this explicit request from the member.
export const POST = withUser<{ params: Promise<{ id: string }> }>(async (req, user, ctx) => {
  const { id } = await ctx.params;
  const { action } = await readJson(req, Body);
  try {
    if (action === "apply") await applySuggestion(user.id, id);
    else if (action === "undo") await undoSuggestion(user.id, id);
    else await rejectSuggestion(user.id, id);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  return NextResponse.json({ ok: true });
});
