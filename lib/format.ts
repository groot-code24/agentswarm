import { DateTime } from "luxon";

export function fmtWhen(d: Date | string | null | undefined, tz: string): string {
  if (!d) return "—";
  const dt = (typeof d === "string" ? DateTime.fromISO(d) : DateTime.fromJSDate(d)).setZone(tz);
  const now = DateTime.now().setZone(tz);
  const time = dt.toFormat("HH:mm");
  if (dt.hasSame(now, "day")) return `Today ${time}`;
  if (dt.hasSame(now.plus({ days: 1 }), "day")) return `Tomorrow ${time}`;
  if (dt.hasSame(now.minus({ days: 1 }), "day")) return `Yesterday ${time}`;
  return dt.toFormat(dt.hasSame(now, "year") ? "ccc d LLL, HH:mm" : "d LLL yyyy, HH:mm");
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return Math.round(n).toLocaleString("en-US");
}

export function platformLabel(p: string) {
  return p === "youtube" ? "YouTube" : "Instagram";
}

export const STATUS_LABEL: Record<string, string> = {
  queued: "Waiting",
  uploading: "Uploading",
  processing: "Processing",
  published: "Published",
  needs_attention: "Needs attention",
  cancelled: "Cancelled",
  failed: "Failed",
};
