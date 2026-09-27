import { env, features } from "./env";
import { query, queryOne } from "./db";
import { deleteObject, objectSize, presignGet, presignPut, putObject, storageBackend } from "./storage";
import { randomToken } from "./crypto";
import { pingSeoEngine } from "./seo";

// Live setup checks: each one talks to the real service with harmless requests
// (a test query, a tiny test file, a deliberately invalid login code) and explains
// what to fix. Shown on the Settings page.

export type Check = { name: string; status: "ok" | "warn" | "fail"; detail: string };

async function run(name: string, fn: () => Promise<Omit<Check, "name">>): Promise<Check> {
  try {
    return { name, ...(await fn()) };
  } catch (err) {
    return { name, status: "fail", detail: (err as Error).message };
  }
}

export async function runChecks(requestOrigin: string | null): Promise<Check[]> {
  return Promise.all([
    run("App address (APP_URL)", async () => {
      if (!requestOrigin || requestOrigin === env.appUrl) return { status: "ok", detail: env.appUrl };
      return {
        status: "fail",
        detail: `You opened ${requestOrigin} but APP_URL is ${env.appUrl}. Google/Instagram sign-in redirects will fail until they match.`,
      };
    }),

    run("Database", async () => {
      const kind = env.databaseUrl.startsWith("postgres") ? "Neon" : "local (development only)";
      // Round-trip every value type the app stores, so a driver difference shows up here, not in production.
      const at = new Date("2026-01-02T03:04:05Z");
      const row = await queryOne<{ a: string[]; j: { ok: boolean }; t: Date; n: boolean; e: boolean; c: number }>(
        "SELECT $1::text[] AS a, $2::jsonb AS j, $3::timestamptz AS t, ($4::text[] IS NULL) AS n, ('x' = ANY($5::text[])) AS e, COUNT(*)::int AS c FROM users",
        [["x", "y"], JSON.stringify({ ok: true }), at, null, ["x"]],
      );
      const good = row && Array.isArray(row.a) && row.a[1] === "y" && row.j?.ok === true && new Date(row.t).getTime() === at.getTime() && row.n && row.e;
      if (!good) return { status: "fail", detail: `${kind}: connected, but values came back in an unexpected format: ${JSON.stringify(row)}` };
      const tables = await query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('users','posts','clips','connected_accounts')");
      return { status: kind === "Neon" ? "ok" : "warn", detail: `${kind}: connected, ${tables.length}/4 core tables, ${row!.c} member(s).` };
    }),

    run("Clip storage", async () => {
      const backend = storageBackend();
      const key = `_checks/${Date.now()}-${randomToken(8)}.txt`;
      try {
        await putObject(key, Buffer.from("ok"), "text/plain");
      } catch (err) {
        if (backend !== "blob") throw err;
        return {
          status: "fail",
          detail: `Vercel Blob refused a test upload (${(err as Error).message}). The store must allow Public access, because Instagram downloads clips from their links.`,
        };
      }
      const size = await objectSize(key);
      // Instagram fetches clips from a plain link, so check that the link really serves the file.
      const link = size === 2 && backend !== "local" ? await fetch(await presignGet(key, 600), { cache: "no-store" }).catch(() => null) : null;
      await deleteObject(key);
      if (size !== 2) return { status: "fail", detail: "Wrote a test file but couldn't read it back." };
      if (backend === "local") {
        return { status: env.isProd ? "fail" : "warn", detail: "Local disk works, but production needs Vercel Blob (free) or an R2 bucket (SETUP.md step 2)." };
      }
      if (!link?.ok) return { status: "fail", detail: `Stored a test file, but its download link returned ${link?.status ?? "no response"}. Instagram couldn't fetch clips.` };
      if (backend === "blob") {
        return { status: "ok", detail: "Vercel Blob: write, public link, read and delete all work. Browsers upload with short-lived tokens (no CORS setup needed)." };
      }
      // Browsers upload clips straight to R2, which only works with a CORS rule for our address.
      const url = await presignPut(`_checks/cors-${Date.now()}.mp4`, "video/mp4");
      const pre = await fetch(url, {
        method: "OPTIONS",
        headers: { Origin: env.appUrl, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type" },
      });
      const allowed = pre.headers.get("access-control-allow-origin");
      if (!pre.ok || (allowed !== "*" && allowed !== env.appUrl)) {
        return { status: "fail", detail: `R2 write/read/delete works, but browser uploads from ${env.appUrl} are blocked. Add it to the bucket's CORS policy (SETUP.md step 2).` };
      }
      return { status: "ok", detail: `R2 bucket "${env.s3Bucket}": write, read, delete and browser upload (CORS) all work.` };
    }),

    run("Google sign-in + YouTube", async () => {
      if (!features.googleLogin) return { status: env.isProd ? "fail" : "warn", detail: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set." };
      // An invalid code with valid client credentials gives "invalid_grant"; wrong credentials give "invalid_client".
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: "setup-check",
          client_id: env.googleClientId,
          client_secret: env.googleClientSecret,
          redirect_uri: `${env.appUrl}/api/auth/google/callback`,
          grant_type: "authorization_code",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
      if (body.error === "invalid_client" || body.error === "unauthorized_client") {
        return { status: "fail", detail: `Google rejected the client ID/secret (${body.error_description || body.error}).` };
      }
      return {
        status: "ok",
        detail: `Client ID and secret are valid. Make sure this redirect URI is listed in Google Cloud (it serves both sign-in and Connect YouTube): ${env.appUrl}/api/auth/google/callback`,
      };
    }),

    run("Title & caption writer", async () => {
      if (features.seoEngine === "rules") {
        return {
          status: "warn",
          detail: "Using the built-in writer (titles from your topic). For titles written from what's in each clip, add ANTHROPIC_API_KEY or a free GEMINI_API_KEY (SETUP.md step 5b).",
        };
      }
      const title = await pingSeoEngine();
      const name = features.seoEngine === "claude" ? `Claude (${env.claudeModel})` : `Gemini (${env.geminiModel})`;
      return { status: "ok", detail: `${name} works. Sample title: "${title}"` };
    }),

    run("Instagram", async () => {
      if (!features.instagram) return { status: "warn", detail: "INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET are not set (Instagram posting is off)." };
      const res = await fetch("https://api.instagram.com/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.instagramAppId,
          client_secret: env.instagramAppSecret,
          grant_type: "authorization_code",
          redirect_uri: `${env.appUrl}/api/connect/instagram/callback`,
          code: "setup-check",
        }),
      });
      const text = (await res.text()).toLowerCase();
      if (/client secret|platform app|invalid client|client_id|app id/.test(text)) {
        return { status: "fail", detail: `Instagram rejected the app ID/secret. Use the Instagram app ID and secret from "API setup with Instagram login", not the Facebook app ID. (${text.slice(0, 160)})` };
      }
      return {
        status: "ok",
        detail: `App ID and secret are accepted. Redirect URL to add in the Meta app: ${env.appUrl}/api/connect/instagram/callback. Add each member as an Instagram Tester.`,
      };
    }),

    run("Email (Resend)", async () => {
      if (!features.email) return { status: env.isProd ? "fail" : "warn", detail: "RESEND_API_KEY is not set; emails are only printed to the server log." };
      const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${env.resendApiKey}` } });
      const fromDomain = (env.emailFrom.match(/@([^>\s]+)/)?.[1] || "").toLowerCase();
      if (res.status === 401 || res.status === 403) {
        const body = await res.text();
        if (body.includes("restricted")) return { status: "ok", detail: "Key is valid (sending-only key, so domains can't be listed)." };
        return { status: "fail", detail: "Resend rejected the API key." };
      }
      const data = (await res.json()) as { data?: { name: string; status: string }[] };
      const domain = data.data?.find((d) => d.name.toLowerCase() === fromDomain);
      if (fromDomain === "resend.dev") {
        return { status: "warn", detail: "Using Resend's test sender: emails only reach the Resend account owner. Verify your own domain so teammates get emails." };
      }
      if (!domain) return { status: "fail", detail: `EMAIL_FROM uses ${fromDomain}, which isn't added in Resend.` };
      if (domain.status !== "verified") return { status: "fail", detail: `${fromDomain} is added in Resend but not verified yet (${domain.status}).` };
      return { status: "ok", detail: `Sending from ${env.emailFrom} (domain verified).` };
    }),

    run("Scheduler (cron)", async () => {
      const row = await queryOne<{ last_run: Date }>("SELECT last_run FROM job_runs WHERE name = 'tick'");
      const secret = env.cronSecret ? "" : " CRON_SECRET is not set.";
      if (!row) return { status: env.isProd ? "fail" : "warn", detail: `The scheduler has never run. Set up cron-job.org to call ${env.appUrl}/api/cron/tick?key=CRON_SECRET every minute (locally: npm run tick).${secret}` };
      const ago = Math.round((Date.now() - new Date(row.last_run).getTime()) / 60000);
      if (ago > 5) return { status: "fail", detail: `Last run ${ago} minutes ago. The cron should call it every minute, or posts will be late.${secret}` };
      return { status: secret ? "warn" : "ok", detail: `Last run ${ago <= 0 ? "under a minute" : `${ago} min`} ago.${secret}` };
    }),

    run("Posting mode", async () =>
      env.dryRun
        ? { status: "warn", detail: "DRY_RUN is on: YouTube and Instagram are simulated. Set DRY_RUN=false to post for real." }
        : { status: "ok", detail: "Live: clips are really posted." },
    ),
  ]);
}
