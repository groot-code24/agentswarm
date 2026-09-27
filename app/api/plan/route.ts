import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson, withUser } from "@/lib/http";
import { commitPlan, getSource, previewPlan } from "@/lib/schedule";

// preview: when each clip would go out on each account. commit: save it as the schedule.
const Body = z.object({ sourceVideoId: z.string(), commit: z.boolean().default(false) });

export const POST = withUser(async (req, user) => {
  const { sourceVideoId, commit } = await readJson(req, Body);
  const source = await getSource(user, sourceVideoId);
  if (!commit) return NextResponse.json({ plans: await previewPlan(user, source) });
  const { created, plans } = await commitPlan(user, source);
  return NextResponse.json({ created, plans });
});
