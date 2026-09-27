import { beforeAll, describe, expect, it, vi } from "vitest";

// Who may sign in: admin always; starting list (ALLOWED_EMAILS); everyone else only after the
// admin approves. Runs on the in-memory database; emails go to the log.

let access: typeof import("@/lib/access");
let db: typeof import("@/lib/db");

beforeAll(async () => {
  vi.stubEnv("ADMIN_EMAIL", "boss@example.com");
  vi.stubEnv("ALLOWED_EMAILS", "member@example.com");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.resetModules();
  access = await import("@/lib/access");
  db = await import("@/lib/db");
});

describe("sign-in access", () => {
  it("lets the admin and the starting list in, and nobody else", async () => {
    expect(await access.canSignIn("Boss@Example.com")).toBe(true);
    expect(await access.canSignIn("member@example.com")).toBe(true);
    expect(await access.canSignIn("stranger@example.com")).toBe(false);
    expect(await access.accessStatus("stranger@example.com")).toBeNull();
  });

  it("turns a stranger's sign-in into one pending request and notifies the admin once", async () => {
    await access.requestAccess("stranger@example.com", "Stranger");
    await access.requestAccess("stranger@example.com", "Stranger");
    expect(await access.accessStatus("stranger@example.com")).toBe("pending");
    expect(await access.canSignIn("stranger@example.com")).toBe(false);
    expect(await access.pendingCount()).toBe(1);
    const mails = await db.query("SELECT key FROM notifications WHERE kind = 'access_request'");
    expect(mails).toHaveLength(1);
  });

  it("lets people in only after approval, and out again on removal", async () => {
    await access.setAccess("stranger@example.com", "approved", "boss@example.com");
    expect(await access.canSignIn("stranger@example.com")).toBe(true);
    expect(await access.pendingCount()).toBe(0);
    await access.setAccess("stranger@example.com", "blocked", "boss@example.com");
    expect(await access.canSignIn("stranger@example.com")).toBe(false);
    // A blocked person signing in again doesn't create a new request.
    await access.requestAccess("stranger@example.com", "Stranger");
    expect(await access.accessStatus("stranger@example.com")).toBe("blocked");
  });

  it("can remove someone from the starting list, but never the admin", async () => {
    await access.setAccess("member@example.com", "blocked", "boss@example.com");
    expect(await access.canSignIn("member@example.com")).toBe(false);
    expect(access.allowedBy("member@example.com", "blocked")).toBe(false);
    await expect(access.setAccess("boss@example.com", "blocked", "boss@example.com")).rejects.toThrow(/Admins always/);
    await expect(access.deleteAccess("boss@example.com")).rejects.toThrow(/Admins always/);
    expect(access.allowedBy("boss@example.com", "blocked")).toBe(true);
  });

  it("forgetting a decision returns the email to its default", async () => {
    await access.deleteAccess("member@example.com");
    expect(await access.canSignIn("member@example.com")).toBe(true); // back on the starting list
    await access.deleteAccess("stranger@example.com");
    expect(await access.accessStatus("stranger@example.com")).toBeNull();
  });

  it("counts members for sharing storage", async () => {
    await access.setAccess("friend@example.com", "approved", "boss@example.com");
    expect(await access.memberCount()).toBe(3); // boss, member, friend
  });
});
