import { NextResponse } from "next/server";
import { env, features } from "@/lib/env";
import { createState } from "@/lib/oauth";

// Team login with Google (openid + email only; YouTube is connected separately).
export async function GET(req: Request) {
  if (!features.googleLogin) return NextResponse.redirect(`${env.appUrl}/login?error=${encodeURIComponent("Google login is not configured.")}`);
  const tz = new URL(req.url).searchParams.get("tz") || undefined;
  const state = await createState({ purpose: "login", tz });
  const qs = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: `${env.appUrl}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    state,
  });
  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${qs}`);
}
