import { NextResponse } from "next/server";
import { withUser } from "@/lib/http";
import { generateSuggestions } from "@/lib/suggestions";

// "Check now" on the Suggestions page (normally this runs once a day).
export const POST = withUser(async (_req, user) => {
  await generateSuggestions(user.id);
  return NextResponse.json({ ok: true });
});
