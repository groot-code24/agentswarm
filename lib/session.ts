import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { DateTime } from "luxon";
import { env } from "./env";
import { newId, query, queryOne } from "./db";
import { allowedBy, canSignIn, isAdmin, type AccessStatus } from "./access";

const COOKIE = "ca_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export type User = {
  id: string;
  email: string;
  name: string | null;
  timezone: string;
  low_stock_days: number;
  prefs: UserPrefs;
};

export type UserPrefs = {
  recommendedClipLength?: number;
  recommendedFormat?: "original" | "vertical";
};

function secret() {
  return new TextEncoder().encode(env.sessionSecret);
}

export { isAdmin };

/** Creates the user on first login (approved people only) and sets the session cookie. */
export async function startSession(email: string, name: string | null, timezone: string | null) {
  const normalized = email.trim().toLowerCase();
  if (!(await canSignIn(normalized))) throw new Error("This email doesn't have access yet. Ask the admin to approve it.");
  const tz = timezone && DateTime.local().setZone(timezone).isValid ? timezone : "UTC";
  const user = await queryOne<{ id: string }>(
    `INSERT INTO users (id, email, name, timezone) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET name = COALESCE(EXCLUDED.name, users.name)
     RETURNING id`,
    [newId(), normalized, name, tz],
  );
  const token = await new SignJWT({ uid: user!.id })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  const jar = await cookies();
  jar.set(COOKIE, token, { httpOnly: true, secure: env.isProd, sameSite: "lax", path: "/", maxAge: MAX_AGE });
}

export async function endSession() {
  (await cookies()).delete(COOKIE);
}

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    const row = await queryOne<User & { access: AccessStatus | null }>(
      `SELECT u.id, u.email, u.name, u.timezone, u.low_stock_days, u.prefs, a.status AS access
         FROM users u LEFT JOIN access_list a ON a.email = u.email WHERE u.id = $1`,
      [payload.uid],
    );
    // Access removed in the Admin panel takes effect on the very next request.
    if (!row || !allowedBy(row.email, row.access)) return null;
    const { access: _access, ...user } = row;
    void _access;
    return user;
  } catch {
    return null;
  }
}

/** For pages: redirect to /login when not signed in. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** For admin pages: members who aren't admins are sent to the dashboard. */
export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (!isAdmin(user.email)) redirect("/");
  return user;
}

export async function audit(userId: string | null, action: string, detail: Record<string, unknown> = {}) {
  await query("INSERT INTO audit_log (id, user_id, action, detail) VALUES ($1, $2, $3, $4::jsonb)", [
    newId(),
    userId,
    action,
    JSON.stringify(detail),
  ]);
}
