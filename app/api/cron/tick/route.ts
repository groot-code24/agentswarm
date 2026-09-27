import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { runTick } from "@/lib/scheduler";

// The scheduler. Call it every minute (cron-job.org, free) with
//   Authorization: Bearer <CRON_SECRET>
// Vercel's own daily cron sends the same header automatically as a backup.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handle(req: Request) {
  if (env.cronSecret) {
    const auth = req.headers.get("authorization") || "";
    const key = new URL(req.url).searchParams.get("key") || "";
    if (auth !== `Bearer ${env.cronSecret}` && key !== env.cronSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (env.isProd) {
    return NextResponse.json({ error: "CRON_SECRET is not set." }, { status: 500 });
  }
  const report = await runTick({ budgetMs: 200_000 });
  return NextResponse.json(report);
}

export const GET = handle;
export const POST = handle;
