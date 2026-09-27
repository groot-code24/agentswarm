import { NextResponse } from "next/server";
import { env, features } from "@/lib/env";
import { startSession } from "@/lib/session";

// Local development only: sign in by typing an allowlisted email (no Google project needed).
export async function POST(req: Request) {
  if (!features.devLogin) return NextResponse.json({ error: "Not available." }, { status: 404 });
  const form = await req.formData();
  try {
    await startSession(String(form.get("email") || ""), null, String(form.get("tz") || "") || null);
    return NextResponse.redirect(`${env.appUrl}/`, 303);
  } catch (err) {
    return NextResponse.redirect(`${env.appUrl}/login?error=${encodeURIComponent((err as Error).message)}`, 303);
  }
}
