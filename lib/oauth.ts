import { cookies } from "next/headers";
import { randomToken, sign, verifySignature } from "./crypto";

// OAuth "state": a signed, short-lived payload plus a nonce cookie in the browser that
// started the flow. It stops forged callbacks (CSRF) and ties a connection to the member.

const NONCE_COOKIE = "ca_oauth_nonce";

export type StatePayload = { purpose: "login" | "youtube" | "instagram"; uid?: string; tz?: string; exp: number; nonce: string };

export async function createState(p: Omit<StatePayload, "exp" | "nonce">): Promise<string> {
  const payload: StatePayload = { ...p, exp: Date.now() + 15 * 60_000, nonce: randomToken(12) };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  (await cookies()).set(NONCE_COOKIE, payload.nonce, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 900, secure: process.env.NODE_ENV === "production" });
  return `${body}.${sign(body)}`;
}

/** Reads the purpose without verifying anything, only to route the callback; readState() still checks it all. */
export function peekPurpose(state: string | null): StatePayload["purpose"] | null {
  try {
    const body = (state || "").split(".")[0];
    return (JSON.parse(Buffer.from(body, "base64url").toString()) as StatePayload).purpose ?? null;
  } catch {
    return null;
  }
}

export async function readState(state: string | null, purpose: StatePayload["purpose"]): Promise<StatePayload> {
  const [body, sig] = (state || "").split(".");
  if (!body || !sig || !verifySignature(body, sig)) throw new Error("The sign-in link is invalid. Please try again.");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as StatePayload;
  const jar = await cookies();
  const nonce = jar.get(NONCE_COOKIE)?.value;
  jar.delete(NONCE_COOKIE);
  if (payload.purpose !== purpose || payload.exp < Date.now() || !nonce || nonce !== payload.nonce) {
    throw new Error("The sign-in link expired. Please try again.");
  }
  return payload;
}
