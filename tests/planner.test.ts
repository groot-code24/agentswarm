import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { chooseScores, defaultScores, pickDailyHours, planSlots, scoresFromOnlineFollowers } from "@/lib/planner";

describe("pickDailyHours", () => {
  it("picks the requested number of hours inside 07:00–23:00, spaced apart", () => {
    for (const n of [2, 3, 4]) {
      const hours = pickDailyHours(defaultScores(), n);
      expect(hours).toHaveLength(n);
      expect(Math.min(...hours)).toBeGreaterThanOrEqual(7);
      expect(Math.max(...hours)).toBeLessThanOrEqual(23);
      for (let i = 1; i < hours.length; i++) expect(hours[i] - hours[i - 1]).toBeGreaterThanOrEqual(3);
    }
  });

  it("never goes below 2 or above 4 per day", () => {
    expect(pickDailyHours(defaultScores(), 1)).toHaveLength(2);
    expect(pickDailyHours(defaultScores(), 9)).toHaveLength(4);
  });

  it("defaults to lunch and evening peaks", () => {
    const [a, b] = pickDailyHours(defaultScores(), 2);
    expect(a).toBeGreaterThanOrEqual(11);
    expect(a).toBeLessThanOrEqual(14);
    expect(b).toBeGreaterThanOrEqual(19);
    expect(b).toBeLessThanOrEqual(21);
  });
});

describe("planSlots", () => {
  it("30 clips at 2 per day take 15 days", () => {
    const after = new Date("2026-10-01T00:00:00Z");
    const slots = planSlots({ count: 30, hours: [13, 20], timezone: "Asia/Kolkata", after });
    expect(slots).toHaveLength(30);
    const days = new Set(slots.map((s) => DateTime.fromJSDate(s).setZone("Asia/Kolkata").toISODate()));
    expect(days.size).toBe(15);
    for (const s of slots) expect([13, 20]).toContain(DateTime.fromJSDate(s).setZone("Asia/Kolkata").hour);
  });

  it("never schedules in the past", () => {
    const after = new Date("2026-10-01T10:00:00Z"); // 15:30 in India: 13:00 today is gone
    const slots = planSlots({ count: 3, hours: [13, 20], timezone: "Asia/Kolkata", after });
    expect(slots[0].getTime()).toBeGreaterThan(after.getTime());
    expect(DateTime.fromJSDate(slots[0]).setZone("Asia/Kolkata").hour).toBe(20);
  });

  it("keeps the local hour across a daylight-saving change", () => {
    const after = new Date("2026-03-06T12:00:00Z");
    const slots = planSlots({ count: 8, hours: [9, 20], timezone: "America/New_York", after });
    for (const s of slots) expect([9, 20]).toContain(DateTime.fromJSDate(s).setZone("America/New_York").hour);
  });
});

describe("chooseScores", () => {
  it("uses defaults with no data, then audience data, then own results", () => {
    const tz = "UTC";
    expect(chooseScores({ ownPosts: [], timezone: tz }).stage).toBe("default");
    const followers = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), h === 8 ? 500 : 10]));
    const a = chooseScores({ ownPosts: [], onlineFollowersUtc: followers, timezone: tz });
    expect(a.stage).toBe("audience");
    expect(pickDailyHours(a.scores, 2)).toContain(8);
    const own = Array.from({ length: 24 }, (_, i) => ({
      publishedAt: new Date(Date.UTC(2026, 0, 1 + i, i % 2 ? 9 : 17)),
      views: i % 2 ? 100 : 1000,
    }));
    const o = chooseScores({ ownPosts: own, onlineFollowersUtc: followers, timezone: tz });
    expect(o.stage).toBe("own-results");
    expect(pickDailyHours(o.scores, 2)).toContain(17);
  });

  it("converts Instagram online-follower hours from UTC to local time", () => {
    const utc = { "14": 900, "3": 5 }; // 14:00 UTC = 19:30 IST → hour 19 or 20 locally
    const scores = scoresFromOnlineFollowers(utc, "Asia/Kolkata")!;
    const best = scores.indexOf(Math.max(...scores));
    expect([19, 20]).toContain(best);
  });
});
