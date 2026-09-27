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

// Finishes a "connect account" OAuth flow: exchanges the code, saves the (encrypted)
// tokens and sends the member back to Settings. YouTube arrives here via the Google
// login callback (one redirect URI for everything Google), Instagram via its own route.
export async function finishConnect(req: Request, platform: string): Promise<NextResponse> {
  const url = new URL(req.url);
  const back = (params: string) => NextResponse.redirect(`${env.appUrl}/settings?${params}`);
  try {
    const user = await currentUser();
    if (!user) return NextResponse.redirect(`${env.appUrl}/login`);
    if (platform !== "youtube" && platform !== "instagram") throw new Error("Unknown platform.");
    if (url.searchParams.get("error")) throw new Error("Connection was cancelled.");
    const state = await readState(url.searchParams.get("state"), platform);
    if (state.uid !== user.id) throw new Error("This connection was started by another member. Please try again.");
    const code = url.searchParams.get("code") || "";

    const result =
      platform === "youtube"
        ? { ...(await youtubeExchangeCode(code)), accountType: undefined as string | undefined }
        : { ...(await instagramExchangeCode(code)), refreshToken: null as string | null };
    const rows = await query<AccountRow>(
      `INSERT INTO connected_accounts (id, user_id, platform, external_id, name, access_token, refresh_token, token_expires_at, status, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ok', $9::jsonb)
       ON CONFLICT (user_id, platform, external_id) DO UPDATE SET
         name = EXCLUDED.name, access_token = EXCLUDED.access_token,
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
        JSON.stringify(result.accountType ? { accountType: result.accountType } : {}),
      ],
    );
    // Queued posts that were waiting for a reconnect can go out on the next tick.
    await query("UPDATE posts SET next_attempt_at = NULL WHERE account_id = $1 AND status IN ('queued', 'uploading', 'processing')", [rows[0].id]);
    await refreshAccountData(rows[0]); // audience data for best-time planning; failures are non-fatal
    await audit(user.id, "account.connected", { platform, name: result.name });
    return back(`connected=${platform}`);
  } catch (err) {
    return back(`error=${encodeURIComponent((err as Error).message)}`);
  }
}
