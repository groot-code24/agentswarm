import { env } from "../env";
import { decrypt, encrypt } from "../crypto";
import { query } from "../db";
import { type AccountRow, type Metrics, PlatformError, httpError, safeFetch } from "./types";

// YouTube Data API v3. Uploads use the resumable protocol: one request to start the
// session (metadata), one PUT with the video bytes.

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  // Read-only: channel info, view counts, and past uploads for best-time planning.
  "https://www.googleapis.com/auth/youtube.readonly",
];
const API = "https://www.googleapis.com/youtube/v3";

// Same redirect URI as Google login, so only one address per site has to be registered in Google Cloud.
export function youtubeRedirectUri() {
  return `${env.appUrl}/api/auth/google/callback`;
}

/** `loginHint` pre-selects the member's Google account; they can still pick another (e.g. a brand-account channel). */
export function youtubeAuthUrl(state: string, loginHint?: string): string {
  const qs = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: youtubeRedirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // always return a refresh token
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) qs.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${qs}`;
}

export async function youtubeExchangeCode(code: string) {
  const res = await safeFetch("youtube", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: youtubeRedirectUri(),
      grant_type: "authorization_code",
    }),
  }, "token exchange");
  if (!res.ok) throw await httpError("youtube", res, "token exchange");
  const tok = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string; refresh_token_expires_in?: number };
  if (!tok.refresh_token) {
    throw new PlatformError(
      "Google didn't return a long-term login. Open https://myaccount.google.com/connections, remove Clip Autopilot, then connect again.",
      "fatal",
    );
  }
  if (!SCOPES.every((s) => tok.scope.includes(s))) {
    throw new PlatformError(
      'Google gave only some permissions. Connect again and on the permissions screen tick BOTH YouTube boxes (or "Select all"), then Continue.',
      "fatal",
    );
  }
  const ch = await ytGet(tok.access_token, "/channels?part=snippet&mine=true", "channel lookup");
  const channel = (ch.items as { id: string; snippet: { title: string } }[] | undefined)?.[0];
  if (!channel) {
    throw new PlatformError(
      "This Google account has no YouTube channel. Create one at https://www.youtube.com/create_channel, or connect again and pick the Google account (or Brand Account) that owns your channel.",
      "fatal",
    );
  }
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: new Date(Date.now() + tok.expires_in * 1000),
    externalId: channel.id,
    name: channel.snippet.title,
    // Google only limits refresh tokens (to 7 days) while the OAuth app is in "Testing" mode.
    testingMode: tok.refresh_token_expires_in != null && tok.refresh_token_expires_in < 30 * 86400,
  };
}

/** Returns a valid access token, refreshing (and saving) it when it's about to expire. */
async function accessToken(account: AccountRow): Promise<string> {
  const current = decrypt(account.access_token);
  if (current && account.token_expires_at && new Date(account.token_expires_at).getTime() > Date.now() + 120_000) {
    return current;
  }
  const refresh = decrypt(account.refresh_token);
  if (!refresh) throw new PlatformError("YouTube connection has no refresh token.", "reconnect");
  const res = await safeFetch("youtube", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      refresh_token: refresh,
      grant_type: "refresh_token",
    }),
  }, "token refresh");
  if (!res.ok) {
    const err = await httpError("youtube", res, "token refresh");
    // A rejected refresh token always means the member must reconnect.
    if (res.status === 400 || res.status === 401) err.kind = "reconnect";
    throw err;
  }
  const tok = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + tok.expires_in * 1000);
  await query("UPDATE connected_accounts SET access_token = $1, token_expires_at = $2 WHERE id = $3", [
    encrypt(tok.access_token),
    expiresAt,
    account.id,
  ]);
  account.access_token = encrypt(tok.access_token);
  account.token_expires_at = expiresAt;
  return tok.access_token;
}

async function ytGet(token: string, path: string, action: string): Promise<Record<string, unknown>> {
  const res = await safeFetch("youtube", `${API}${path}`, { headers: { Authorization: `Bearer ${token}` } }, action);
  if (!res.ok) throw await httpError("youtube", res, action);
  return res.json();
}

// YouTube rejects "<" and ">" in titles/descriptions; titles max 100 chars.
export function cleanTitle(s: string) {
  return s.replace(/[<>]/g, "").trim().slice(0, 100) || "Clip";
}
function cleanDescription(s: string) {
  return s.replace(/[<>]/g, "").slice(0, 4900);
}

export async function youtubeUpload(
  account: AccountRow,
  video: { bytes: Buffer; contentType: string; title: string; description: string; tags: string[] },
): Promise<{ externalId: string; permalink: string }> {
  const token = await accessToken(account);
  const start = await safeFetch(
    "youtube",
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(video.bytes.length),
        "X-Upload-Content-Type": video.contentType,
      },
      body: JSON.stringify({
        snippet: {
          title: cleanTitle(video.title),
          description: cleanDescription(video.description),
          tags: video.tags.slice(0, 15),
          categoryId: "22", // People & Blogs
        },
        status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
      }),
    },
    "upload start",
  );
  if (!start.ok) throw await httpError("youtube", start, "upload start");
  const location = start.headers.get("location");
  if (!location) throw new PlatformError("YouTube did not return an upload URL.", "retry");

  const put = await safeFetch(
    "youtube",
    location,
    {
      method: "PUT",
      headers: { "Content-Type": video.contentType, "Content-Length": String(video.bytes.length) },
      body: new Uint8Array(video.bytes),
    },
    "upload",
  );
  if (!put.ok) throw await httpError("youtube", put, "upload");
  const created = (await put.json()) as { id: string };
  return { externalId: created.id, permalink: `https://youtube.com/shorts/${created.id}` };
}

export async function youtubeMetrics(account: AccountRow, videoIds: string[]): Promise<Map<string, Metrics>> {
  const token = await accessToken(account);
  const out = new Map<string, Metrics>();
  for (let i = 0; i < videoIds.length; i += 50) {
    const ids = videoIds.slice(i, i + 50).join(",");
    const data = await ytGet(token, `/videos?part=statistics&id=${ids}`, "stats");
    for (const item of (data.items as { id: string; statistics: Record<string, string> }[]) || []) {
      const s = item.statistics || {};
      out.set(item.id, {
        views: num(s.viewCount),
        likes: num(s.likeCount),
        comments: num(s.commentCount),
        shares: null,
        saves: null,
        reach: null,
        avgWatchSec: null,
      });
    }
  }
  return out;
}

/** The channel's last 50 uploads with views, used to find its best posting hours. */
export async function youtubeHistory(account: AccountRow): Promise<{ publishedAt: string; views: number }[]> {
  const token = await accessToken(account);
  const ch = await ytGet(token, "/channels?part=contentDetails&mine=true", "channel lookup");
  const uploads = (ch.items as { contentDetails: { relatedPlaylists: { uploads: string } } }[] | undefined)?.[0]
    ?.contentDetails.relatedPlaylists.uploads;
  if (!uploads) return [];
  const pl = await ytGet(token, `/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}`, "history");
  const items = (pl.items as { contentDetails: { videoId: string; videoPublishedAt?: string } }[]) || [];
  const published = items.filter((i) => i.contentDetails.videoPublishedAt);
  const stats = await youtubeMetrics(account, published.map((i) => i.contentDetails.videoId));
  return published.map((i) => ({
    publishedAt: i.contentDetails.videoPublishedAt!,
    views: stats.get(i.contentDetails.videoId)?.views ?? 0,
  }));
}

/** Finds a video we uploaded recently by exact title (crash recovery: avoids uploading twice). */
export async function youtubeFindRecentByTitle(account: AccountRow, title: string, since: Date): Promise<string | null> {
  const token = await accessToken(account);
  const ch = await ytGet(token, "/channels?part=contentDetails&mine=true", "channel lookup");
  const uploads = (ch.items as { contentDetails: { relatedPlaylists: { uploads: string } } }[] | undefined)?.[0]
    ?.contentDetails.relatedPlaylists.uploads;
  if (!uploads) return null;
  const pl = await ytGet(token, `/playlistItems?part=snippet&maxResults=10&playlistId=${uploads}`, "recent uploads");
  const wanted = cleanTitle(title);
  for (const item of (pl.items as { snippet: { title: string; publishedAt: string; resourceId: { videoId: string } } }[]) || []) {
    if (item.snippet.title === wanted && new Date(item.snippet.publishedAt) >= since) return item.snippet.resourceId.videoId;
  }
  return null;
}

function num(v: string | undefined): number | null {
  return v == null ? null : Number(v);
}
