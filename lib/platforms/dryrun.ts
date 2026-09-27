import { DateTime } from "luxon";
import type { Metrics } from "./types";

// Simulated YouTube/Instagram for DRY_RUN=true. Nothing leaves the machine.
// Views follow a daily rhythm (peaks around 12:00 and 20:00 in the member's timezone)
// so the best-time learning and suggestions can be seen working end to end.

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

function hourFactor(hour: number): number {
  const peak = (center: number, width: number) => Math.exp(-(((hour - center) / width) ** 2));
  return 0.25 + 0.6 * peak(12.5, 1.6) + 1.0 * peak(20, 2);
}

export function dryRunMetrics(opts: {
  externalId: string;
  platform: "youtube" | "instagram";
  publishedAt: Date;
  hoursAfter: number;
  timezone: string;
  clipDuration: number;
  vertical: boolean;
}): Metrics {
  const localHour = DateTime.fromJSDate(opts.publishedAt).setZone(opts.timezone).hour;
  const base = opts.platform === "youtube" ? 800 : 1200;
  const growth = 1 - Math.exp(-opts.hoursAfter / 20); // most views come in the first day or two
  const noise = 0.6 + 0.8 * hash(opts.externalId);
  const shape = (opts.vertical ? 1.3 : 0.8) * (opts.clipDuration <= 35 ? 1.2 : 1);
  const views = Math.round(base * hourFactor(localHour) * growth * noise * shape);
  return {
    views,
    likes: Math.round(views * 0.05),
    comments: Math.round(views * 0.006),
    shares: opts.platform === "instagram" ? Math.round(views * 0.01) : null,
    saves: opts.platform === "instagram" ? Math.round(views * 0.008) : null,
    reach: opts.platform === "instagram" ? Math.round(views * 0.8) : null,
    avgWatchSec: Math.round(opts.clipDuration * (0.25 + 0.35 * hash(opts.externalId + "w")) * 10) / 10,
  };
}

export function dryRunId(prefix: string, key: string): string {
  return `${prefix}_${Math.floor(hash(key) * 1e10).toString(36)}`;
}
