import { env } from "./env";
import { query, queryOne } from "./db";
import { chooseScores, pickDailyHours, type Stage } from "./planner";
import { type AccountRow, type AccountMeta, PlatformError } from "./platforms/types";
import { youtubeHistory } from "./platforms/youtube";
import { instagramOnlineFollowers, instagramRefreshIfNeeded } from "./platforms/instagram";

export function isSimulated(account: AccountRow): boolean {
  return env.dryRun || Boolean(account.meta?.dryRun);
}

export async function listAccounts(userId: string): Promise<AccountRow[]> {
  return query<AccountRow>("SELECT * FROM connected_accounts WHERE user_id = $1 ORDER BY platform, created_at", [userId]);
}

export async function getAccount(id: string): Promise<AccountRow | null> {
  return queryOne<AccountRow>("SELECT * FROM connected_accounts WHERE id = $1", [id]);
}

export async function markNeedsReconnect(accountId: string) {
  await query("UPDATE connected_accounts SET status = 'needs_reconnect' WHERE id = $1", [accountId]);
}

/** Views 24 h after posting, for this account's published posts (the input for best-time learning). */
export async function ownPostViews(accountId: string): Promise<{ publishedAt: Date; views: number; postId: string; scheduledHour?: number }[]> {
  return query(
    `SELECT p.id AS "postId", p.published_at AS "publishedAt", s.views::int AS views
       FROM posts p
       JOIN LATERAL (
         SELECT views FROM metric_snapshots m
          WHERE m.post_id = p.id AND m.hours_after >= 24 AND m.views IS NOT NULL
          ORDER BY m.hours_after ASC LIMIT 1
       ) s ON true
      WHERE p.account_id = $1 AND p.status = 'published'
      ORDER BY p.published_at DESC
      LIMIT 200`,
    [accountId],
  );
}

export type BestTimes = { hours: number[]; scores: number[]; stage: Stage; basis: string };

export async function bestTimes(account: AccountRow, timezone: string, postsPerDay: number): Promise<BestTimes> {
  const own = await ownPostViews(account.id);
  const { scores, stage, basis } = chooseScores({
    ownPosts: own,
    history: account.meta?.history,
    onlineFollowersUtc: account.meta?.onlineFollowersUtc,
    timezone,
  });
  return { hours: pickDailyHours(scores, postsPerDay), scores, stage, basis };
}

/**
 * Daily refresh of audience data (YouTube channel history, Instagram online followers)
 * and Instagram token renewal. Errors are returned, not thrown, so one bad account
 * doesn't stop the others.
 */
export async function refreshAccountData(account: AccountRow): Promise<string | null> {
  if (isSimulated(account) || account.status !== "ok") return null;
  try {
    const meta: AccountMeta = { ...(account.meta || {}) };
    if (account.platform === "youtube") {
      meta.history = await youtubeHistory(account);
    } else {
      await instagramRefreshIfNeeded(account);
      const refreshed = await getAccount(account.id);
      const online = await instagramOnlineFollowers(refreshed || account);
      if (online) meta.onlineFollowersUtc = online;
    }
    await query("UPDATE connected_accounts SET meta = $1::jsonb, meta_updated_at = now() WHERE id = $2", [
      JSON.stringify(meta),
      account.id,
    ]);
    return null;
  } catch (err) {
    if (err instanceof PlatformError && err.kind === "reconnect") await markNeedsReconnect(account.id);
    return `${account.platform} ${account.name}: ${(err as Error).message}`;
  }
}
