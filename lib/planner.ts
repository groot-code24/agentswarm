import { DateTime } from "luxon";

// Best-time planning. Pure functions (no database) so they are easy to test.
// Hour scores are 24 numbers, one per local hour in the member's timezone; higher = better.

export type Stage = "default" | "audience" | "own-results";
export type HourScores = number[];

export const MIN_POSTS_PER_DAY = 2;
export const MAX_POSTS_PER_DAY = 5;
// Never schedule at night: posts go out between 07:00 and 23:00 local time.
const WINDOW_START = 7;
const WINDOW_END = 23;

/** Stage A: typical short-video peaks (lunch and evening) when we know nothing yet. */
export function defaultScores(): HourScores {
  return Array.from({ length: 24 }, (_, h) => {
    const bump = (c: number, w: number) => Math.exp(-(((h - c) / w) ** 2));
    return 0.2 + 0.7 * bump(12.5, 1.5) + 1.0 * bump(20, 1.8);
  });
}

function normalize(scores: HourScores): HourScores {
  const max = Math.max(...scores);
  return max > 0 ? scores.map((s) => s / max) : scores;
}

// Blend each hour with its neighbours, because data per single hour is thin.
function smooth(scores: HourScores): HourScores {
  return scores.map((s, h) => 0.25 * scores[(h + 23) % 24] + 0.5 * s + 0.25 * scores[(h + 1) % 24]);
}

function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Scores from "views by the hour they were posted", in local hours. Null if too little data. */
export function scoresFromPosts(posts: { publishedAt: Date | string; views: number }[], timezone: string, minPosts: number): HourScores | null {
  if (posts.length < minPosts) return null;
  const buckets: number[][] = Array.from({ length: 24 }, () => []);
  for (const p of posts) {
    const d = typeof p.publishedAt === "string" ? DateTime.fromISO(p.publishedAt) : DateTime.fromJSDate(p.publishedAt);
    buckets[d.setZone(timezone).hour].push(p.views);
  }
  const overall = median(posts.map((p) => p.views));
  const prior = normalize(defaultScores());
  // Hours without data fall back to the default curve, scaled to the account's typical views.
  const raw = buckets.map((b, h) => (b.length ? (median(b) * b.length + overall * prior[h]) / (b.length + 1) : overall * prior[h] * 0.9));
  return normalize(smooth(raw));
}

/** Instagram "followers online" (UTC hours) → local-hour scores. */
export function scoresFromOnlineFollowers(utc: Record<string, number> | undefined, timezone: string): HourScores | null {
  if (!utc || !Object.keys(utc).length) return null;
  const offsetHours = Math.round(DateTime.now().setZone(timezone).offset / 60);
  const local = Array.from({ length: 24 }, () => 0);
  for (const [hour, count] of Object.entries(utc)) local[(((Number(hour) + offsetHours) % 24) + 24) % 24] += count;
  if (local.every((c) => c === 0)) return null;
  return normalize(smooth(local));
}

/** Picks the best inputs available: own results > audience data > defaults. */
export function chooseScores(opts: {
  ownPosts: { publishedAt: Date | string; views: number }[];
  history?: { publishedAt: string; views: number }[];
  onlineFollowersUtc?: Record<string, number>;
  timezone: string;
}): { scores: HourScores; stage: Stage; basis: string } {
  const own = scoresFromPosts(opts.ownPosts, opts.timezone, 20);
  if (own) return { scores: own, stage: "own-results", basis: `views of your last ${opts.ownPosts.length} posts` };
  const followers = scoresFromOnlineFollowers(opts.onlineFollowersUtc, opts.timezone);
  if (followers) return { scores: followers, stage: "audience", basis: "when your Instagram followers are online" };
  const history = scoresFromPosts(opts.history || [], opts.timezone, 8);
  if (history) return { scores: history, stage: "audience", basis: `views of your channel's last ${opts.history!.length} uploads` };
  return { scores: normalize(defaultScores()), stage: "default", basis: "typical Shorts/Reels peak hours (no data yet)" };
}

/** Chooses the best `postsPerDay` hours with enough spacing, sorted by time of day. */
export function pickDailyHours(scores: HourScores, postsPerDay: number): number[] {
  const n = Math.min(MAX_POSTS_PER_DAY, Math.max(MIN_POSTS_PER_DAY, Math.round(postsPerDay)));
  const candidates = Array.from({ length: WINDOW_END - WINDOW_START + 1 }, (_, i) => WINDOW_START + i).sort(
    (a, b) => scores[b] - scores[a] || a - b,
  );
  for (let gap = Math.max(3, Math.min(5, Math.floor(16 / n))); gap >= 1; gap--) {
    const chosen: number[] = [];
    for (const h of candidates) {
      if (chosen.every((c) => Math.abs(c - h) >= gap)) chosen.push(h);
      if (chosen.length === n) return chosen.sort((a, b) => a - b);
    }
  }
  return candidates.slice(0, n).sort((a, b) => a - b);
}

/**
 * Turns daily hours into concrete times: `count` slots starting after `after`.
 * With `explore`, every 5th day moves the last slot one hour later so the
 * model keeps testing nearby hours instead of never learning anything new.
 */
export function planSlots(opts: {
  count: number;
  hours: number[];
  timezone: string;
  after: Date;
  explore?: boolean;
  /** Minutes past the hour, so two platforms don't post at the exact same second. */
  minute?: number;
}): Date[] {
  const slots: Date[] = [];
  const earliest = DateTime.fromJSDate(opts.after).plus({ minutes: 10 });
  let day = DateTime.fromJSDate(opts.after).setZone(opts.timezone).startOf("day");
  for (let dayIndex = 0; slots.length < opts.count && dayIndex < 3660; dayIndex++, day = day.plus({ days: 1 })) {
    const hours = [...opts.hours];
    if (opts.explore && dayIndex % 5 === 4 && hours.length) {
      const last = hours.length - 1;
      if (hours[last] + 1 <= WINDOW_END && !hours.includes(hours[last] + 1)) hours[last] += 1;
    }
    for (const hour of hours) {
      const t = DateTime.fromObject(
        { year: day.year, month: day.month, day: day.day, hour, minute: opts.minute ?? 0 },
        { zone: opts.timezone },
      );
      if (t > earliest && slots.length < opts.count) slots.push(t.toJSDate());
    }
  }
  return slots;
}

export function formatHours(hours: number[]): string {
  return hours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ");
}

export { median };
