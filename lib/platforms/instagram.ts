import { DateTime } from "luxon";
import { env } from "../env";
import { decrypt, encrypt } from "../crypto";
import { query } from "../db";
import { type AccountRow, type Metrics, PlatformError, httpError, safeFetch } from "./types";

// Instagram API with Instagram Login (graph.instagram.com). Works in Development mode for
// accounts added to the Meta app as Instagram Testers, so no App Review is needed.

const SCOPES = ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_insights"];
const graph = () => `https://graph.instagram.com/${env.instagramApiVersion}`;

export function instagramRedirectUri() {
  return `${env.appUrl}/api/connect/instagram/callback`;
}

export function instagramAuthUrl(state: string): string {
  const qs = new URLSearchParams({
    client_id: env.instagramAppId,
    redirect_uri: instagramRedirectUri(),
    response_type: "code",
    scope: SCOPES.join(","),
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${qs}`;
}

export async function instagramExchangeCode(code: string) {
  // 1) code → short-lived token (1 hour)
  const res = await safeFetch("instagram", "https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.instagramAppId,
      client_secret: env.instagramAppSecret,
      grant_type: "authorization_code",
      redirect_uri: instagramRedirectUri(),
      code: code.replace(/#_$/, ""), // Instagram sometimes appends "#_" to the code
    }),
  }, "token exchange");
  if (!res.ok) throw await httpError("instagram", res, "token exchange");
  const shortBody = (await res.json()) as { access_token?: string; data?: { access_token: string }[] };
  const shortToken = shortBody.access_token || shortBody.data?.[0]?.access_token;
  if (!shortToken) throw new PlatformError("Instagram did not return an access token.", "fatal");

  // 2) short-lived → long-lived token (60 days)
  const long = await igGetJson(
    `https://graph.instagram.com/access_token?${new URLSearchParams({
      grant_type: "ig_exchange_token",
      client_secret: env.instagramAppSecret,
      access_token: shortToken,
    })}`,
    "long-lived token",
  );
  const accessToken = long.access_token as string;
  const expiresAt = new Date(Date.now() + Number(long.expires_in || 60 * 86400) * 1000);

  const me = await igGetJson(`${graph()}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(accessToken)}`, "profile");
  const accountType = String(me.account_type || "");
  if (accountType && !["BUSINESS", "MEDIA_CREATOR"].includes(accountType)) {
    throw new PlatformError(
      "This Instagram account is a personal account. Switch it to a Professional (Creator or Business) account in Instagram settings, then connect again.",
      "fatal",
    );
  }
  return {
    accessToken,
    expiresAt,
    externalId: String(me.user_id),
    name: `@${me.username}`,
    accountType,
  };
}

async function igGetJson(url: string, action: string): Promise<Record<string, unknown>> {
  const res = await safeFetch("instagram", url, {}, action);
  if (!res.ok) throw await httpError("instagram", res, action);
  return res.json();
}

async function igPostJson(url: string, token: string, body: Record<string, unknown>, action: string) {
  const res = await safeFetch("instagram", url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, action);
  if (!res.ok) throw await httpError("instagram", res, action);
  return (await res.json()) as Record<string, unknown>;
}

function token(account: AccountRow): string {
  const t = decrypt(account.access_token);
  if (!t) throw new PlatformError("Instagram connection has no token.", "reconnect");
  if (account.token_expires_at && new Date(account.token_expires_at).getTime() < Date.now()) {
    throw new PlatformError("Instagram token expired.", "reconnect");
  }
  return t;
}

/** Long-lived tokens last 60 days; refresh when under 20 days remain (must be 24 h+ old). */
export async function instagramRefreshIfNeeded(account: AccountRow): Promise<void> {
  const expires = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (expires - Date.now() > 20 * 86400_000) return;
  const data = await igGetJson(
    `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token(account))}`,
    "token refresh",
  );
  const expiresAt = new Date(Date.now() + Number(data.expires_in || 60 * 86400) * 1000);
  await query("UPDATE connected_accounts SET access_token = $1, token_expires_at = $2 WHERE id = $3", [
    encrypt(String(data.access_token)),
    expiresAt,
    account.id,
  ]);
}

export async function instagramCreateReel(account: AccountRow, videoUrl: string, caption: string): Promise<string> {
  const data = await igPostJson(`${graph()}/${account.external_id}/media`, token(account), {
    media_type: "REELS",
    video_url: videoUrl,
    caption: caption.slice(0, 2200),
    share_to_feed: true,
  }, "create reel");
  return String(data.id);
}

export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "ERROR" | "EXPIRED";

export async function instagramContainerStatus(account: AccountRow, containerId: string): Promise<{ status: ContainerStatus; detail: string }> {
  const data = await igGetJson(
    `${graph()}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token(account))}`,
    "reel status",
  );
  return { status: String(data.status_code) as ContainerStatus, detail: String(data.status || "") };
}

export async function instagramPublish(account: AccountRow, containerId: string): Promise<{ externalId: string; permalink: string | null }> {
  const data = await igPostJson(`${graph()}/${account.external_id}/media_publish`, token(account), { creation_id: containerId }, "publish reel");
  const mediaId = String(data.id);
  let permalink: string | null = null;
  try {
    const m = await igGetJson(`${graph()}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token(account))}`, "permalink");
    permalink = (m.permalink as string) || null;
  } catch {
    /* the post is live; the link is only nice to have */
  }
  return { externalId: mediaId, permalink };
}

export async function instagramMetrics(account: AccountRow, mediaId: string): Promise<Metrics> {
  const metrics = "views,reach,likes,comments,shares,saved,ig_reels_avg_watch_time";
  const data = await igGetJson(
    `${graph()}/${mediaId}/insights?metric=${metrics}&access_token=${encodeURIComponent(token(account))}`,
    "insights",
  );
  const values: Record<string, number> = {};
  for (const m of (data.data as { name: string; values?: { value: number }[]; total_value?: { value: number } }[]) || []) {
    const v = m.values?.[0]?.value ?? m.total_value?.value;
    if (typeof v === "number") values[m.name] = v;
  }
  return {
    views: values.views ?? null,
    reach: values.reach ?? null,
    likes: values.likes ?? null,
    comments: values.comments ?? null,
    shares: values.shares ?? null,
    saves: values.saved ?? null,
    // Reported in milliseconds.
    avgWatchSec: values.ig_reels_avg_watch_time != null ? values.ig_reels_avg_watch_time / 1000 : null,
  };
}

/**
 * Followers online per hour (needs 100+ followers). Meta reports the hours in Pacific time;
 * we convert them to UTC hours. Returns null when Instagram doesn't provide it.
 */
export async function instagramOnlineFollowers(account: AccountRow): Promise<Record<string, number> | null> {
  try {
    const data = await igGetJson(
      `${graph()}/${account.external_id}/insights?metric=online_followers&period=lifetime&access_token=${encodeURIComponent(token(account))}`,
      "online followers",
    );
    const series = (data.data as { values?: { value: Record<string, number>; end_time?: string }[] }[] | undefined)?.[0]?.values || [];
    const totals: Record<string, number> = {};
    for (const point of series) {
      // The day the counts belong to, in Pacific time, so DST is handled correctly.
      const day = point.end_time ? DateTime.fromISO(point.end_time).setZone("America/Los_Angeles").minus({ days: 1 }) : DateTime.now().setZone("America/Los_Angeles");
      for (const [hour, count] of Object.entries(point.value || {})) {
        const utcHour = day.set({ hour: Number(hour), minute: 0 }).toUTC().hour;
        totals[String(utcHour)] = (totals[String(utcHour)] || 0) + Number(count || 0);
      }
    }
    return Object.keys(totals).length ? totals : null;
  } catch (err) {
    if (err instanceof PlatformError && err.kind === "reconnect") throw err;
    return null; // under 100 followers, or metric unavailable
  }
}

/** Finds a Reel we published recently by caption (crash recovery: avoids publishing twice). */
export async function instagramFindRecentByCaption(account: AccountRow, caption: string, since: Date): Promise<{ externalId: string; permalink: string | null } | null> {
  const data = await igGetJson(
    `${graph()}/${account.external_id}/media?fields=id,caption,permalink,timestamp&limit=10&access_token=${encodeURIComponent(token(account))}`,
    "recent media",
  );
  const wanted = caption.slice(0, 2200).trim();
  for (const m of (data.data as { id: string; caption?: string; permalink?: string; timestamp?: string }[]) || []) {
    if ((m.caption || "").trim() === wanted && (!m.timestamp || new Date(m.timestamp) >= since)) {
      return { externalId: m.id, permalink: m.permalink || null };
    }
  }
  return null;
}
