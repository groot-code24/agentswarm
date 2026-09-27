import { env } from "./env";
import { query, queryOne } from "./db";
import { sendEmail, sendEmailOnce } from "./email";

// Who may sign in. Rules, in order:
//  1. Admins (ADMIN_EMAIL) always may.
//  2. Otherwise the access_list row decides: approved → yes; pending/blocked → no.
//  3. No row: emails in ALLOWED_EMAILS (the starting list) may; everyone else may not, and signing
//     in with Google files a request the admin approves or denies in the Admin panel.

export type AccessStatus = "approved" | "pending" | "blocked";
export type AccessRow = { email: string; status: AccessStatus; name: string | null; requested_at: Date; decided_at: Date | null; decided_by: string | null };

const norm = (email: string) => email.trim().toLowerCase();

export function isAdmin(email: string): boolean {
  return env.adminEmails.includes(norm(email));
}

/** Decides from an already-loaded access row (used by currentUser, which loads it in the same query). */
export function allowedBy(email: string, rowStatus: AccessStatus | null | undefined): boolean {
  const e = norm(email);
  if (isAdmin(e)) return true;
  if (rowStatus) return rowStatus === "approved";
  return env.allowedEmails.includes(e);
}

export async function accessStatus(email: string): Promise<AccessStatus | null> {
  const e = norm(email);
  if (isAdmin(e)) return "approved";
  const row = await queryOne<{ status: AccessStatus }>("SELECT status FROM access_list WHERE email = $1", [e]);
  if (row) return row.status;
  return env.allowedEmails.includes(e) ? "approved" : null;
}

export async function canSignIn(email: string): Promise<boolean> {
  return (await accessStatus(email)) === "approved";
}

/** Someone without access tried to sign in: record the request (once) and tell the admins. */
export async function requestAccess(email: string, name: string | null): Promise<void> {
  const e = norm(email);
  const row = await queryOne<{ email: string }>(
    `INSERT INTO access_list (email, status, name) VALUES ($1, 'pending', $2)
     ON CONFLICT (email) DO NOTHING RETURNING email`,
    [e, name],
  );
  if (!row) return; // already requested (or decided)
  for (const admin of env.adminEmails) {
    await sendEmailOnce({
      key: `access-request:${e}:${admin}`,
      userId: null,
      kind: "access_request",
      to: admin,
      subject: `${name || e} asked to use Clip Autopilot`,
      text: `${name ? `${name} (${e})` : e} tried to sign in to Clip Autopilot.\n\nApprove or deny: ${env.appUrl}/admin\n\nNobody gets in until you approve them.`,
    }).catch(() => false);
  }
}

/** Admin decision. Approving emails the person that they can sign in now. */
export async function setAccess(email: string, status: "approved" | "blocked", by: string): Promise<void> {
  const e = norm(email);
  if (isAdmin(e)) throw new Error("Admins always have access. Change ADMIN_EMAIL to remove an admin.");
  const before = await accessStatus(e);
  await query(
    `INSERT INTO access_list (email, status, decided_at, decided_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (email) DO UPDATE SET status = EXCLUDED.status, decided_at = now(), decided_by = EXCLUDED.decided_by`,
    [e, status, norm(by)],
  );
  if (status === "approved" && before !== "approved") {
    await sendEmail(
      e,
      "You can now sign in to Clip Autopilot",
      `Your access to Clip Autopilot was approved.\n\nSign in with this Google account: ${env.appUrl}/login`,
    ).catch(() => undefined);
  }
}

/** Forget a request or decision entirely (the person can ask again). */
export async function deleteAccess(email: string): Promise<void> {
  const e = norm(email);
  if (isAdmin(e)) throw new Error("Admins always have access.");
  await query("DELETE FROM access_list WHERE email = $1", [e]);
}

export async function pendingCount(): Promise<number> {
  const row = await queryOne<{ n: number }>("SELECT COUNT(*)::int AS n FROM access_list WHERE status = 'pending'");
  return row?.n ?? 0;
}

/** Number of people who may sign in (admins + approved + starting list minus anyone blocked). */
export async function memberCount(): Promise<number> {
  const rows = await query<{ email: string; status: AccessStatus }>("SELECT email, status FROM access_list");
  const members = new Set(env.adminEmails);
  const decided = new Set(rows.map((r) => r.email));
  for (const r of rows) if (r.status === "approved") members.add(r.email);
  for (const e of env.allowedEmails) if (!decided.has(e)) members.add(e);
  return members.size;
}
