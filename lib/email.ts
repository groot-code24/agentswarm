import { env, features } from "./env";
import { query } from "./db";

// Emails go through Resend's HTTP API. Without RESEND_API_KEY they are printed to the
// server log instead (local dev). Every email has a unique key so it's sent only once.

export async function sendEmailOnce(opts: {
  key: string;
  userId: string | null;
  kind: string;
  to: string;
  subject: string;
  text: string;
}): Promise<boolean> {
  // Claim the key first: if two ticks race, only one sends.
  const claimed = await query(
    "INSERT INTO notifications (key, user_id, kind) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING RETURNING key",
    [opts.key, opts.userId, opts.kind],
  );
  if (!claimed.length) return false;
  try {
    await sendEmail(opts.to, opts.subject, opts.text);
    return true;
  } catch (err) {
    // Release the key so the next tick retries.
    await query("DELETE FROM notifications WHERE key = $1", [opts.key]);
    throw err;
  }
}

export async function sendEmail(to: string, subject: string, text: string) {
  if (!features.email) {
    console.log(`[email → ${to}] ${subject}\n${text}\n`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.emailFrom, to: [to], subject, text }),
  });
  if (!res.ok) throw new Error(`Email failed (${res.status}): ${await res.text()}`);
}
