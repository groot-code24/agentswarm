import { NextResponse } from "next/server";
import { env, features } from "@/lib/env";
import { newId, query } from "@/lib/db";
import { createState } from "@/lib/oauth";
import { audit, currentUser } from "@/lib/session";
import { youtubeAuthUrl } from "@/lib/platforms/youtube";
import { instagramAuthUrl } from "@/lib/platforms/instagram";

export async function GET(_req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  const user = await currentUser();
  if (!user) return NextResponse.redirect(`${env.appUrl}/login`);
  const back = (msg: string) => NextResponse.redirect(`${env.appUrl}/settings?error=${encodeURIComponent(msg)}`);
  if (platform !== "youtube" && platform !== "instagram") return back("Unknown platform.");

  if (env.dryRun) {
    // Simulated account: lets the whole app be tried without Google/Meta setup.
    const name = platform === "youtube" ? "Test channel (dry run)" : "@test_account (dry run)";
    await query(
      `INSERT INTO connected_accounts (id, user_id, platform, external_id, name, status, meta)
       VALUES ($1, $2, $3, $4, $5, 'ok', '{"dryRun": true}'::jsonb)
       ON CONFLICT (user_id, platform, external_id) DO UPDATE SET status = 'ok'`,
      [newId(), user.id, platform, `dry-${platform}-${user.id.slice(0, 8)}`, name],
    );
    await audit(user.id, "account.connected", { platform, dryRun: true });
    return NextResponse.redirect(`${env.appUrl}/settings?connected=${platform}`);
  }

  if (platform === "youtube" && !features.googleLogin) return back("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.");
  if (platform === "instagram" && !features.instagram) return back("Set INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET first.");
  const state = await createState({ purpose: platform, uid: user.id });
  return NextResponse.redirect(platform === "youtube" ? youtubeAuthUrl(state, user.email) : instagramAuthUrl(state));
}
