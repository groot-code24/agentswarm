import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runChecks } from "@/lib/checks";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Live setup checks. Allowed for signed-in members (Settings page), or with the cron secret
// (so the setup can be verified from a terminal before anyone can sign in).
export async function GET(req: Request) {
  const bearer = req.headers.get("authorization") === `Bearer ${env.cronSecret}` && Boolean(env.cronSecret);
  if (!bearer && !(await currentUser())) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") || new URL(req.url).protocol.replace(":", "");
  const origin = bearer ? null : host ? `${proto}://${host}` : null;
  return NextResponse.json({ checks: await runChecks(origin) });
}
