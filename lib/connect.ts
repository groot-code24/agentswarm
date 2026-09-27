import { NextResponse } from "next/server";
import { env } from "./env";
import { encrypt } from "./crypto";
import { newId, query } from "./db";
import { readState } from "./oauth";
import { audit, currentUser } from "./session";
import { refreshAccountData } from "./accounts";
import type { AccountRow } from "./platforms/types";
import { youtubeExchangeCode } from "./platforms/youtube";
import { instagramExchangeCode } from "./platforms/instagram";

/** Turns the provider's error codes into steps the member can follow. */
function providerError(platform: string, code: string, description: string | null): string {
  const name = platform === "youtube" ? "Google" : "Instagram";
  if (code === "access_denied" || code === "user_denied" || code === "consent_required") {
    return platform === "youtube"
      ? `Google didn't give permission. Connect again: if Google says "hasn't verified this app", click Advanced → Go to Clip Autopilot, then tick BOTH YouTube boxes and Continue.`
      : "Instagram didn't give permission. Connect again and press Allow.";
  }
  return `${name} stopped the connection (${code}${description ? `: ${description}` : ""}). Try again, or ask the admin.`;
}

// Finishes a "connect account" OAuth flow: exchanges the code, saves the (encrypted)
// tokens and sends the member back to Settings. YouTube arrives here via the Google
// login callback (one redirect URI for everything Google), Instagram via its own route.
export async function finishConnect(req: Request, platform: string): Promise<NextResponse> {
  const url = new URL(req.url);
  const back = (params: string) => NextResponse.redirect(`${env.appUrl}/settings?${params}`);
  const user = await currentUser().catch(() => null);
  try {
    if (!user) return NextResponse.redirect(`${env.appUrl}/login`);
    if (platform !== "youtube" && platform !== "instagram") throw new Error("Unknown platform.");
    const errorCode = url.searchParams.get("error");
    if (errorCode) throw new Error(providerError(platform, errorCode, url.searchParams.get("error_description") || url.searchParams.get("error_reason")));
    const state = await readState(url.searchParams.get("state"), platform);
    if (state.uid !== user.id) throw new Error("This connection was started by another member. Please try again.");
    const authCode = url.searchParams.get("code") || "";

    const result =
      platform === "youtube"
        ? { ...(await youtubeExchangeCode(authCode)), accountType: undefined as string | undefined }
        : { ...(await instagramExchangeCode(authCode)), refreshToken: null as string | null, testingMode: false };
    const rows = await query<AccountRow>(
      `INSERT INTO connected_accounts (id, user_id, platform, external_id, name, access_token, refresh_token, token_expires_at, status, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ok', $9::jsonb)
       ON CONFLICT (user_id, platform, external_id) DO UPDATE SET
         name = EXCLUDED.name, access_token = EXCLUDED.access_token, meta = connected_accounts.meta || EXCLUDED.meta,
         refresh_token = COALESCE(EXCLUDED.refresh_token, connected_accounts.refresh_token),
         token_expires_at = EXCLUDED.token_expires_at, status = 'ok'
       RETURNING *`,
      [
        newId(),
        user.id,
        platform,
        result.externalId,
        result.name,
        encrypt(result.accessToken),
        encrypt(result.refreshToken),
        result.expiresAt,
        JSON.stringify({ ...(result.accountType ? { accountType: result.accountType } : {}), ...(result.testingMode ? { googleTestingMode: true } : {}) }),
      ],
    );
    // Queued posts that were waiting for a reconnect can go out on the next tick.
    await query("UPDATE posts SET next_attempt_at = NULL WHERE account_id = $1 AND status IN ('queued', 'uploading', 'processing')", [rows[0].id]);
    await refreshAccountData(rows[0]); // audience data for best-time planning; failures are non-fatal
    await audit(user.id, "account.connected", { platform, name: result.name });
    return back(`connected=${platform}`);
  } catch (err) {
    const message = (err as Error).message;
    // Recorded so the admin can see why someone couldn't connect (Admin panel).
    if (user) await audit(user.id, "account.connect_failed", { platform, reason: message }).catch(() => undefined);
    return back(`error=${encodeURIComponent(message)}`);
  }
}
