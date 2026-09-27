import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { peekPurpose, readState } from "@/lib/oauth";
import { audit, startSession } from "@/lib/session";
import { accessStatus, requestAccess } from "@/lib/access";
import { finishConnect } from "@/lib/connect";

// The one redirect URI registered with Google: handles team login and "Connect YouTube".
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (peekPurpose(url.searchParams.get("state")) === "youtube") return finishConnect(req, "youtube");
  const fail = (msg: string) => NextResponse.redirect(`${env.appUrl}/login?error=${encodeURIComponent(msg)}`);
  try {
    if (url.searchParams.get("error")) return fail("Google sign-in was cancelled.");
    const state = await readState(url.searchParams.get("state"), "login");
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code") || "",
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        redirect_uri: `${env.appUrl}/api/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) return fail("Google sign-in failed. Please try again.");
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${access_token}` } });
    const info = (await infoRes.json()) as { email?: string; email_verified?: boolean; name?: string };
    if (!info.email || !info.email_verified) return fail("Your Google account email is not verified.");
    const access = await accessStatus(info.email);
    if (access === "blocked") return fail(`${info.email} doesn't have access to Clip Autopilot. Contact the admin if you think this is a mistake.`);
    if (access !== "approved") {
      // First time (or still waiting): file a request for the admin and explain.
      await requestAccess(info.email, info.name ?? null);
      return NextResponse.redirect(`${env.appUrl}/login?requested=${encodeURIComponent(info.email.toLowerCase())}`);
    }
    await startSession(info.email, info.name ?? null, state.tz ?? null);
    await audit(null, "login", { email: info.email });
    return NextResponse.redirect(`${env.appUrl}/`);
  } catch (err) {
    return fail((err as Error).message);
  }
}
