# Clip Autopilot: setup guide

This takes you from "works on my computer in dry-run mode" to "posting for real on
Vercel". Every service used has a free plan. Budget about 1–2 hours of clicking,
then wait for YouTube's audit (step 3).

`APP_URL` below means your live address, for example `https://clip-autopilot.vercel.app`.

---

## 0. Try it locally first (5 minutes, no accounts needed)

```bash
npm install
cp .env.example .env.local       # Windows: copy .env.example .env.local
```

Fill in these three values in `.env.local`, and keep `DRY_RUN=true`:

```bash
# SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# ALLOWED_EMAILS=your@email.com
```

Then:

```bash
npm run dev          # http://localhost:3000
npm run tick         # in a second terminal: runs the scheduler every minute
```

1. Sign in with your email. Locally there is a simple email sign-in when Google isn't configured.
2. Go to **Settings** and connect YouTube and Instagram. In dry run, these are simulated test accounts.
3. Go to **Upload**, choose a video and try both modes.

Nothing is posted anywhere. Emails are printed in the `npm run dev` terminal.

---

## Checking your setup at any time

After filling in values, restart `npm run dev` and run:

```bash
npm run check        # or: Settings → System status → "Run live checks"
```

It tests each real service with harmless requests: the Neon round-trip, an R2 write/read/delete plus a browser-upload (CORS) test, the
Google and Instagram app credentials, the Resend domain and the scheduler heartbeat. It then tells you exactly what to fix.
Nothing is posted.

## 1. Database: Neon (free)

1. Sign up at https://neon.tech and create a project (pick the region closest to your Vercel region).
2. Copy the **connection string**. Its format is `postgresql://...`.
3. Save it as `DATABASE_URL`, both in Vercel and in `.env.local`.
   - Tip: create a free **branch** called `dev` in Neon and use *its* connection string in `.env.local`. Then local testing never touches the team's real schedule.

The tables are created automatically on first use.

## 2. Clip storage: Cloudflare R2 (free 10 GB, free downloads)

1. Go to https://dash.cloudflare.com → **R2** → **Create bucket** (e.g. `clip-autopilot`). Save the name as `S3_BUCKET`.
2. Go to **R2 → Manage R2 API tokens → Create API token**:
   - permission: **Object Read & Write**
   - scope: this bucket only
3. Copy the keys:
   - Access Key ID → `S3_ACCESS_KEY_ID`
   - Secret Access Key → `S3_SECRET_ACCESS_KEY`
   - S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` → `S3_ENDPOINT`
4. Set `S3_REGION=auto`.
5. Open the bucket → **Settings → CORS policy** and paste this. It lets browsers upload clips directly:

```json
[
  {
    "AllowedOrigins": ["https://YOUR-APP.vercel.app", "http://localhost:3000"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

## 3. Google: team login + YouTube

1. Go to https://console.cloud.google.com and create a project.
2. **APIs & Services → Library**: enable **YouTube Data API v3**.
3. **Google Auth Platform → Branding (OAuth consent screen)**:
   - Audience **External**.
   - Fill in the app name, support email, app home page (`APP_URL`) and a privacy-policy link.
   - A simple page is fine. For example, a Google Doc saying the tool is internal, stores YouTube/Instagram tokens encrypted, and deletes clips 48 h after posting.
4. **Data Access / Scopes**: add
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `https://www.googleapis.com/auth/youtube.upload`
   - `https://www.googleapis.com/auth/youtube.readonly`
5. **Audience → Publishing status: press "Publish app" (In production).**
   - Don't leave it in *Testing*: in Testing mode, logins expire every 7 days.
   - You don't need to submit for verification. Members will see a one-time "Google hasn't verified this app" screen and click *Advanced → Go to …*. Up to 100 users are allowed this way.
6. **Clients → Create client → Web application**. Add these **Authorized redirect URIs**. Sign-in and Connect YouTube share one address per site:
   - `APP_URL/api/auth/google/callback` (e.g. `https://agentswarm-mauve.vercel.app/api/auth/google/callback`)
   - `http://localhost:3000/api/auth/google/callback`, for local testing
7. Copy the Client ID → `GOOGLE_CLIENT_ID` and the Client secret → `GOOGLE_CLIENT_SECRET`.
8. **Submit the YouTube API audit (important, and slow).** Until it passes, every upload is forced to **Private**.
   - Form: https://support.google.com/youtube/contact/yt_api_form
   - Describe it honestly: *an internal tool used by our own team of 5–10 people to upload Shorts to channels we own; no public users.*
   - While you wait, everything works except that YouTube videos stay Private. You can make them public by hand in YouTube Studio.

## 4. Instagram: Meta app (no App Review needed)

1. Go to https://developers.facebook.com → **My Apps → Create app**.
   - Use case: **Manage messaging & content on Instagram** (the "Instagram API").
   - App type: Business, if it asks.
2. In the app: **Instagram → API setup with Instagram login**.
3. **Set up Instagram business login** → add the redirect URL `APP_URL/api/connect/instagram/callback`.
4. Copy the **Instagram app ID** → `INSTAGRAM_APP_ID` and the **Instagram app secret** → `INSTAGRAM_APP_SECRET`. These are on that same page and are *not* the Facebook App ID.
5. **App roles → Roles → Instagram Testers → Add**: enter each member's Instagram username.
6. Each member does this once, in the Instagram app:
   - **Switch to a Professional account** (Creator or Business). It's free and takes 1 minute: Settings → Account type and tools.
   - **Accept the tester invite**: Settings → Apps and websites → Tester invites.
7. Leave the Meta app in **Development mode**. For accounts with a role on the app, that is all we need.

## 5. Email: Resend (free)

1. Sign up at https://resend.com and create an API key → `RESEND_API_KEY`.
2. **Add and verify your domain** (Domains → Add, then add the DNS records it shows). Then set `EMAIL_FROM`, e.g. `Clip Autopilot <alerts@yourdomain.com>`.
   - Without a verified domain, Resend's test sender only delivers to your own Resend login email, so teammates wouldn't get their "clips running out" emails.
3. Set `ADMIN_EMAIL` to receive the daily summary.

## 6. Deploy on Vercel

1. Push this repo to GitHub, then Vercel → **Add New → Project** → import it. The framework is detected as **Next.js**.
2. **Settings → Environment Variables**: add everything from `.env.example`, with these values:
   - `APP_URL`: your Vercel address, without a trailing slash.
   - `SESSION_SECRET` and `ENCRYPTION_KEY`: new random values, generated with the commands in step 0. **Never change `ENCRYPTION_KEY` later**, or connected accounts must reconnect.
   - `ALLOWED_EMAILS`: the team's login emails, comma-separated.
   - `CRON_SECRET`: another random value.
   - `DRY_RUN`: `true` for the first deploy.
3. Deploy. Open the site: if something is missing, the login page lists exactly what.

## 7. Scheduler: every minute (free)

Vercel's free plan only runs cron once a day; that daily run is already configured as a backup.
For on-time posting, use a free external cron:

1. Sign up at https://cron-job.org → **Create cronjob**.
2. URL: `APP_URL/api/cron/tick?key=YOUR_CRON_SECRET`.
3. Schedule: **every minute**.
4. Save, then check its history. Each run should return HTTP 200 with JSON like `{"published":0,...}`.

## 8. Go live

1. With `DRY_RUN=true`, sign in, connect your real YouTube and Instagram accounts, and upload a short test video in **Manual** mode.
2. Set `DRY_RUN=false` in Vercel and redeploy.
   - Accounts connected while `DRY_RUN=true` are simulated. Disconnect them in **Settings**, then connect the real accounts again.
3. Open **Settings → Run live checks** on the live site. Everything should be ✅, except Posting mode until the next step.
4. Do one **Post now** on a secondary or test account and check that it appears on both platforms.
5. Then use **Automation** mode for real.

---

## Where things live

| What | Where |
|------|-------|
| Posting schedule, retries, stats, emails, cleanup | `lib/scheduler.ts` (runs on every `/api/cron/tick`) |
| Best-time planning | `lib/planner.ts`, `lib/accounts.ts` |
| Suggestions (rules, apply, undo) | `lib/suggestions.ts` |
| YouTube / Instagram API calls | `lib/platforms/` |
| Video splitting in the browser | `lib/splitter-client.ts` |
| Database tables | `lib/schema.ts` |
| Tests (offline, simulated platforms) | `tests/`, run with `npm test` |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Upload fails with "Check the storage CORS settings" | Add your exact `APP_URL` to the R2 CORS policy (step 2). |
| Google says "Error 400: redirect_uri_mismatch" | The `redirect_uri` in the error must be in the client's Authorized redirect URIs (step 3.6), in the same client as `GOOGLE_CLIENT_ID`. Wait ~5 minutes after saving. |
| YouTube videos are Private | The YouTube audit (step 3.8) hasn't passed yet. |
| "This Instagram account is a personal account" | Switch it to a Professional account, then connect again. |
| Instagram connect says the user isn't allowed | Add the username as an Instagram Tester and accept the invite (step 4). |
| An account shows "Reconnect needed" | Settings → Reconnect. Queued posts wait and continue automatically. |
| Posts are late | Check cron-job.org history; it must call `/api/cron/tick` every minute. |
| Teammates don't get emails | Verify a domain in Resend (step 5). |
