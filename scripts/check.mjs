// Runs the live setup checks against a running app (default: local dev server).
// Usage: npm run check              (uses CRON_SECRET from .env.local)
//        CHECK_URL=https://your-app.vercel.app/api/checks CRON_SECRET=... npm run check
const url = process.env.CHECK_URL || "http://localhost:3000/api/checks";
const secret = process.env.CRON_SECRET || "";
if (!secret) {
  console.error("CRON_SECRET is not set (add it to .env.local), so the checks endpoint can't be called from the terminal.");
  process.exit(1);
}
const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } }).catch((err) => {
  console.error(`Couldn't reach ${url}: ${err.message}. Is the app running (npm run dev)?`);
  process.exit(1);
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`${res.status}: ${body.error || "request failed"}`);
  process.exit(1);
}
const icon = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
for (const c of body.checks) console.log(`${icon[c.status]}  ${c.name}\n      ${c.detail}\n`);
process.exit(body.checks.some((c) => c.status === "fail") ? 1 : 0);
