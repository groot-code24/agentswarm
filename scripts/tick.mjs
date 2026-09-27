// Local stand-in for the production cron: calls the scheduler every minute.
// Usage (with `npm run dev` running in another terminal):  npm run tick
const url = process.env.TICK_URL || "http://localhost:3000/api/cron/tick";
const secret = process.env.CRON_SECRET || "";

async function tick() {
  try {
    const res = await fetch(url, { method: "POST", headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
    const body = await res.json().catch(() => ({}));
    const note = body.log?.length ? ` | ${body.log.join(" | ")}` : "";
    console.log(`${new Date().toLocaleTimeString()} ${res.status} published=${body.published ?? "?"} metrics=${body.metrics ?? "?"}${note}`);
  } catch (err) {
    console.log(`${new Date().toLocaleTimeString()} tick failed: ${err.message}`);
  }
}

await tick();
setInterval(tick, 60_000);
