export type Platform = "youtube" | "instagram";

export type AccountRow = {
  id: string;
  user_id: string;
  platform: Platform;
  external_id: string;
  name: string;
  access_token: string | null; // encrypted
  refresh_token: string | null; // encrypted
  token_expires_at: Date | null;
  status: "ok" | "needs_reconnect";
  meta: AccountMeta;
  meta_updated_at: Date | null;
};

export type AccountMeta = {
  /** Past uploads (YouTube channel history) for best-time planning. */
  history?: { publishedAt: string; views: number }[];
  /** Instagram followers online per hour, keyed by UTC hour "0".."23". */
  onlineFollowersUtc?: Record<string, number>;
  accountType?: string;
  dryRun?: boolean;
};

export type Metrics = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  avgWatchSec: number | null;
};

/** Errors from YouTube/Instagram, classified so the scheduler knows what to do. */
export class PlatformError extends Error {
  constructor(
    message: string,
    public kind: "retry" | "reconnect" | "fatal",
    /** For "retry": wait at least this long (e.g. quota resets at midnight Pacific). */
    public retryAfterSec?: number,
  ) {
    super(message);
  }
}

/** Turns a failed HTTP response into a classified PlatformError. */
export async function httpError(platform: Platform, res: Response, action: string): Promise<PlatformError> {
  let detail = "";
  let body: unknown = null;
  try {
    const text = await res.text();
    detail = text.slice(0, 500);
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const msg = `${platform} ${action} failed (${res.status}): ${extractMessage(body) || detail}`;
  const lower = JSON.stringify(body ?? detail).toLowerCase();

  if (res.status === 401 || lower.includes("invalid_grant") || /"code":\s*190\b/.test(lower)) {
    return new PlatformError(msg, "reconnect");
  }
  if (lower.includes("quotaexceeded") || lower.includes("uploadlimitexceeded") || lower.includes("dailylimitexceeded")) {
    return new PlatformError(msg, "retry", 3 * 3600);
  }
  if (res.status === 429 || res.status >= 500 || /"code":\s*(4|17|32|613|2)\b/.test(lower)) {
    return new PlatformError(msg, "retry");
  }
  if (res.status === 403 && (lower.includes("insufficient") || lower.includes("permission"))) {
    return new PlatformError(msg, "reconnect");
  }
  return new PlatformError(msg, "fatal");
}

function extractMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as { error?: { message?: string } | string; error_description?: string; error_message?: string };
  if (typeof b.error === "object" && b.error?.message) return b.error.message;
  return b.error_description || b.error_message || (typeof b.error === "string" ? b.error : "");
}

/** fetch() that turns network failures into retryable errors. */
export async function safeFetch(platform: Platform, url: string, init: RequestInit, action: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new PlatformError(`${platform} ${action}: network error (${(err as Error).message})`, "retry");
  }
}
