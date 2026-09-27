import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { peekPurpose, readState } from "@/lib/oauth";
import { audit, isAllowedEmail, startSession } from "@/lib/session";
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
    if (!isAllowedEmail(info.email)) return fail(`${info.email} is not on the team list. Ask the admin to add it to ALLOWED_EMAILS.`);
    await startSession(info.email, info.name ?? null, state.tz ?? null);
    await audit(null, "login", { email: info.email });
    return NextResponse.redirect(`${env.appUrl}/`);
  } catch (err) {
    return fail((err as Error).message);
  }
}
