# Clip Autopilot: Feasibility and Build Plan

**Status:** Built (phases 1–6); ready to set up, see [SETUP.md](../SETUP.md) · **Updated:** 27 Sep 2026

> **What changed while building (27 Sep 2026).** Each change removes a service or a failure mode:
> - **Login:** Google sign-in with an email allowlist (`ALLOWED_EMAILS`) instead of Clerk. It reuses the Google project we need for YouTube anyway.
> - **Scheduler:** a database-backed job queue, run by `/api/cron/tick` every minute from **cron-job.org** (free), instead of Inngest. Vercel's daily cron is the backup.
> - **YouTube timing:** YouTube clips are uploaded **at their slot time** as public, instead of early with `publishAt`. Cancelling or moving a post then never needs a YouTube call.
> - **YouTube permissions:** only `youtube.upload` + `youtube.readonly`. Title rewriting of existing videos was dropped, because without AI it would be low quality.
> - **Queue cap:** 1 GB per member (not 500 MB), so a 1-hour video fits. When a video doesn't fit, the clips that fit are scheduled and the page says so.
> - **Dry-run mode** (`DRY_RUN=true`): simulated YouTube and Instagram, used for local testing and automated tests.


## 1. Scope

A **private tool for our own team of 5–10 people**. Each person connects only
**YouTube channels and Instagram accounts they own**. The platform is not open to
the public, has no sign-up page, and is free.

This scope removes most of the hard parts of a public product:

| Public product would need | Private tool (us) |
|---------------------------|-------------------|
| Meta App Review + Business Verification (needs a registered business) | **Not needed.** The Meta app stays in Development mode, and each member's Instagram account is added as an *Instagram Tester*. |
| Google OAuth verification (weeks) | **Not needed.** The app is set to "In production" without verification. Each member clicks through a one-time "unverified app" warning. Google allows up to 100 users this way. |
| Waitlists, capacity planning, abuse controls | **Not needed.** 5–10 users fit comfortably in every free tier (§11). |
| **YouTube API audit** | **Still needed.** Without it, every video our app uploads is locked to **Private**. This is the only external approval left. |

## 2. Short answer: can we build it?

**Yes.** Everything described can be built with the official APIs, for free, for
our team. The single external dependency is the **YouTube API audit**:
- It is free, but approval and timing are up to Google.
- We submit it on day 1 and build while we wait.
- Until it passes, YouTube uploads work but stay Private. Instagram is not affected.

## 3. What the platform does

1. **Log in.** Only invited team emails can log in (an allowlist; no public sign-up). The login email receives notifications.
2. **Connect accounts:** "Connect YouTube" and "Connect Instagram", for accounts the member owns.
3. **Upload a long video.** It is split into clips in the browser (the fast engine already built). **The member selects every setting; nothing is pre-selected:**
   - clip length
   - format (original or vertical 9:16)
   - mode
   - platforms
   - posts per day

   The Split button stays disabled until all of these are chosen.
4. **Choose a mode:**
   - **Automation mode.** Clips are scheduled and posted automatically to **both YouTube and Instagram**. The member can untick one.
   - **Manual mode.** Nothing is scheduled. The member previews and downloads clips, or presses **Post now** on a single clip. Manual clips stay in the browser and are only uploaded to storage when Post now is pressed.
5. **Auto-schedule.** Posts per day: **minimum 2** (maximum 4). The system picks the best times separately for each platform.
   *Example:* 30 clips at 2 per day gives a 15-day plan on each platform. The member reviews and can edit it before it starts.
6. **Auto-publish** at each slot: a YouTube Short and an Instagram Reel, with a title, caption and hashtags.
7. **Running-low emails:**
   - A warning when 3 days of clips are left.
   - A final email when the queue is empty: *"Your clips are running out. Kindly add more clips."*
8. **Analyze and suggest.** The system tracks views and engagement per clip, compares them with that account's normal level, and suggests improvements.
9. **Apply with permission.** Every suggestion needs an **Approve** click. Changes are logged and can be undone where the platform allows.

## 4. What the platforms allow (checked 27 Sep 2026)

### YouTube (Data API v3)

| Fact | Impact on us |
|------|--------------|
| Videos uploaded by **unaudited projects are locked to Private**. | Submit the audit form on day 1. Test with Private uploads meanwhile. |
| Uploads have their own quota: **100 uploads/day per project**. Other calls share 10,000 units/day. | 10 members × 4 posts/day = 40. Plenty. |
| `status.publishAt` makes YouTube publish a Private upload at a set time. | Not used: we upload at the slot time instead (see the note at the top), so moving or cancelling a post needs no YouTube call. |
| `videos.update` (title/description/tags) costs 50 units. | Possible later (needs a write scope). Not used now: suggestions change future posts. |
| Shorts = vertical or square, up to 3 minutes. There is no "Short" flag in the API. | Horizontal clips will be treated as normal videos. This is why the member picks the format. |
| OAuth **Testing** mode: logins expire every 7 days. **In production** without verification: one-time warning screen, 100-user lifetime cap. | Use In production. The first time, the member clicks "Advanced → Go to app". |

### Instagram (Instagram API with Instagram Login)

| Fact | Impact on us |
|------|--------------|
| Only **Professional accounts** (Business or Creator) can publish. | Each member switches their account in Instagram settings (free, 1 minute). |
| **Development mode** works only for accounts with a role on the Meta app. | We add each member's Instagram username under *Roles → Instagram Testers*. They accept in Instagram: *Settings → Apps and websites → Tester invites*. |
| Reels are published from a **publicly reachable `video_url`**, because Meta downloads the file. | Clips go to cloud storage with a temporary link. |
| Limit: 100 API posts per 24 h per account. No scheduling in the API. | 2–4 per day is fine. **Our** scheduler fires at the slot time. |
| `online_followers` (followers online by hour) works for accounts with **100+ followers**, last 30 days. | Real "best time" data for Instagram. |
| Metrics get renamed or removed over time (for example `plays` became `views`). | All Instagram calls go through one adapter file. |

### Vercel

| Fact | Impact on us |
|------|--------------|
| Hobby (free) cron runs at most once per day. | Exact posting times come from the per-minute tick (§6), so Hobby is enough. |
| Hobby is for non-commercial use. | This fits a private team tool. If the channels are run as a paying business, check [Vercel's commercial-use rule](https://vercel.com/docs/limits/fair-use-guidelines). The Pro plan is $20/month if needed. |
| Request body limit ~4.5 MB. | Videos never pass through our functions. The browser uploads straight to storage. |

## 5. What is not guaranteed

- **Views.** Suggestions are based on our own data and best practice. The platforms' algorithms are not public.
- **The "best time" needs data.** At 2 posts a day, per-account timing becomes reliable after about 2–3 weeks. Until then we use `online_followers` (Instagram, 100+ followers) or sensible defaults.
- **Editing Instagram posts after publishing** is very limited in the API. Suggestions therefore apply to **future** posts on both platforms.
- **Reach for unoriginal content.** Both platforms reduce reach for reposted or unoriginal material. Only upload videos we own, and prefer clips with a strong first few seconds.

## 6. Architecture

```
 Browser (Next.js page)
   │  1. split video (mediabunny, existing code) ──► 2. upload clips straight to storage (pre-signed URL)
   ▼
 Next.js on Vercel (Hobby): dashboard + API routes
   │── Google sign-in: allowlisted team emails only
   │── Postgres (Neon, free): users, accounts, clips, posts, metrics, suggestions
   │── Cloudflare R2 (free 10 GB): clip files; Instagram downloads them from here
   │── Scheduler: /api/cron/tick every minute (cron-job.org): publish, retry, metrics, emails, cleanup
   │── Resend (free): running-low and "reconnect your account" emails
   ▼
 YouTube Data API + YouTube Analytics API      Instagram API (publishing + insights)
```

- **Per-minute tick from cron-job.org:** Vercel Hobby cron runs only once a day. The queue lives in the database, so every tick is safe to repeat.
- **R2:** Instagram downloads every clip, and R2 downloads are free.
- **Separate logins:** logging in to our app is separate from connecting YouTube or Instagram. A broken YouTube token never locks anyone out.
- **No AI API for now** (it has no free tier). Titles and captions come from templates plus the member's own text. AI text can be added later if wanted.
- The current splitter page becomes the upload page. The Flask version stays as a local tool.

## 7. Data model

| Table | Key fields |
|-------|-----------|
| `users` | id, email (allowlisted), timezone, low_stock_days (3), queue cap 1 GB (computed from clips) |
| `connected_accounts` | user_id, platform (`youtube`/`instagram`), external_id, name, **encrypted** tokens, expires_at, status (`ok`/`needs_reconnect`) |
| `source_videos` | user_id, filename, duration, mode (`automation`/`manual`), platforms, clip_length, format, posts_per_day (2–4) |
| `clips` | source_video_id, index, storage_key, duration, width, height, status (`ready`/`scheduled`/`posted`/`deleted`) |
| `posts` | clip_id, account_id, scheduled_at (UTC), status, external_post_id, attempts, last_error, **idempotency_key** (unique) |
| `metric_snapshots` | post_id, taken_at, views, likes, comments, shares, saves, avg_watch_time |
| `suggestions` | user_id, type, evidence (JSON), proposed_change (JSON), status (`proposed`/`approved`/`applied`/`rejected`/`undone`) |
| `audit_log` | user_id, action, before, after, at |
| `notifications` | user_id, kind, sent_at (prevents duplicate emails) |

**Post lifecycle:** each step is saved *before* it runs, so a crash never posts a clip twice.

```
queued ─► uploading ─► processing ─► published
   │           │            │
   └► cancelled            └► failed (retry up to 3 times, waiting longer each time) ─► needs_attention (email the member)
```

## 8. Scheduling logic

1. **Days needed** = ceil(clips ÷ posts per day). *30 clips at 2 per day = 15 days.*
2. **Best time per platform**, learned in stages:
   - **Stage A (no data yet):** default windows such as 12:00–13:00 and 19:00–21:00 in the audience's timezone, at least 4 hours apart. For YouTube, also use the channel's past upload performance if it has history.
   - **Stage B (Instagram, 100+ followers):** the top hours from `online_followers`.
   - **Stage C (after about 20 posts):** the hours that got above-average views in the first 24 h. Mostly use the best slots, and sometimes try a new one so the model keeps learning.
3. **Automation mode:** each clip goes to both platforms, each at its own best time. For example, 13:00 on Instagram and 19:30 on YouTube.
4. **Store all times in UTC.** Convert to the member's timezone only for display (this avoids daylight-saving bugs).
5. **Running-low emails:** after each publish, count the future queued posts.
   - When they cover ≤ 3 days, send the warning.
   - At 0, send the "running out" email.
   - Each email is sent once per stock-out.

## 9. Analytics and suggestions

We take metric snapshots at **1 h, 24 h, 72 h and 7 days** after each post, and
compare each clip with **that account's own median**.

| Signal (example) | Suggestion | Can we apply it? |
|------------------|-----------|------------------|
| Views at 24 h well below the median for 5+ posts | Try new posting times | ✅ Reschedule future slots |
| Shorter clips keep viewers watching longer | Use 30 s instead of 60 s next time | ✅ Pre-fill next upload (member still confirms) |
| Horizontal clips underperform on YouTube | Use vertical 9:16 | ✅ For future clips |
| No hashtags on recent uploads | Add 3–5 specific hashtags | ⚠️ Advice only |
| Low watch time | Start clips on a strong moment, add subtitles | ⚠️ Advice only |
| Reach per post falling as posts increase | Lower posts per day (not below 2) | ✅ With approval |

**Permission flow:** each suggestion card shows *what we saw* (numbers), *what
we propose*, and *exactly what will change*. The member can approve or reject it.
Every applied change is logged with before/after values so it can be undone.
Nothing is auto-applied.

## 10. Build plan

Only start the next phase after the current phase's "done" test passes.

| Phase | Work | Done when |
|-------|------|-----------|
| **0. Setup (day 1)** | Google Cloud project, OAuth consent screen set to *In production*, **submit the YouTube API audit form**. Meta developer app in Development mode, Instagram Testers added. Each member switches to a Professional Instagram account and accepts the tester invite. Simple privacy-policy page (needed by the forms). | Audit submitted. All members' Instagram accounts show as testers. |
| **1. Foundation** | Next.js app, Google sign-in with allowlist, Neon, R2. Move the splitter in, add the mode and settings selectors (no defaults), and upload clips to R2. | A member logs in, splits a video, and sees their clips stored in the cloud after refreshing the page. |
| **2. YouTube** | Connect YouTube, encrypted tokens and refresh, upload one clip at its slot time. | A clip appears on a member's channel (Private until the audit passes). The token still works 8+ days later. |
| **3. Instagram** | Connect Instagram, block personal accounts, publish one Reel from an R2 link, refresh long-lived tokens automatically. | A Reel appears on a member's account. |
| **4. Scheduler** | Slot planner, per-minute tick, state machine, retries, running-low and reconnect emails, Manual-mode "Post now". | A 30-clip plan runs on one member's accounts with no duplicate or missed posts, including a simulated crash mid-upload. |
| **5. Analytics** | Metric snapshots, dashboard per clip and per account. | Numbers match YouTube Studio and Instagram Insights. |
| **6. Suggestions** | Rules, suggestion cards, approve/apply/undo, audit log. | Each suggestion type can be applied and undone. |
| **7. Team rollout** | All 5–10 members. Monitor for a week. | One week with no failed posts that weren't retried automatically. |

## 11. Cost: $0 per month

| Service | Free allowance | Our use (10 members) |
|---------|---------------|----------------------|
| YouTube Data API | 100 uploads/day | ≤ 40/day |
| Cloudflare R2 | 10 GB, free downloads | Usually a few GB (1 GB queue cap per member; rarely all full at once) |
| cron-job.org + Vercel functions | Free; ~43,000 ticks/month | Well within Vercel Hobby's 1M invocations |
| Resend | 3,000 emails/month, 100/day | A few dozen |
| Vercel Hobby, Neon | Free plans | Well within limits |

## 12. Decisions (27 Sep 2026)

| # | Topic | Decision |
|---|-------|----------|
| 1 | Who uses it | **Private team tool, 5–10 people, own YouTube and Instagram accounts only.** No public access, no Meta business verification. |
| 2 | Platforms | **Automation mode:** each clip goes to both (can untick one). **Manual mode:** member posts or downloads themselves. |
| 3 | Posting | **Minimum 2 per day** (max 4), at the best time per platform. Warning at 3 days of clips left. |
| 4 | Settings | **No defaults.** The member selects clip length, format, mode, platforms and posts per day. |
| 5 | Price | **Free.** Fits entirely in free tiers (§11). |
| 6 | Retention | See below. |

**Retention policy:**

| What | Kept for | Why |
|------|----------|-----|
| Original long video | **Never uploaded** | It is split in the browser |
| Manual-mode clips | **Never uploaded** unless Post now is pressed | They stay in the browser |
| Scheduled clips | Until posted (queue cap 1 GB per member) | They are the queue |
| Posted clips | **Deleted 48 h after** they are live on every selected platform | The platforms hold their own copy. 48 h covers retries. |
| Failed clips | 7 days, with emails on day 1 and day 5 | Time to reconnect and retry |
| Titles, schedule, metrics | While the member is active | Needed for best-time learning. YouTube data is refreshed or deleted per its policies. |

## 13. How to build it without making more errors

**Posting safety** (double posts and missed posts are the worst bugs):
- Give every post a unique `idempotency_key`, and check `external_post_id` before uploading.
- Save the state before each external call, and resume after a crash instead of starting over.
- Retry only temporary errors (network, 5xx, rate limit), waiting longer each time. Errors like "invalid video" or "permission revoked" go to `needs_attention`, and the member gets an email.
- A **dry-run mode** runs the whole scheduler without posting. Use it for tests.

**Tokens:**
- Encrypt tokens at rest and refresh them before they expire.
- If a refresh fails: pause that account's posts (without deleting them), mark it `needs_reconnect`, and email the member.

**Testing:**
- Keep a separate staging setup (its own database and storage bucket).
- Do the first automation runs on one member's secondary or test accounts before touching main channels.

**Code:**
- TypeScript strict mode, with every API response validated by a schema (zod).
- One adapter file per platform.
- Tests for the slot planner (timezones, daylight saving, 0/1/500 clips), the state machine, and email de-duplication.
- Small changes, one phase at a time, with CI checks on every push.

**Monitoring:**
- Error tracking (Sentry free tier).
- Logs that include `post_id`.
- A daily summary email to the admin: posted, failed, retried, and YouTube quota used.

## 14. Risks

| Risk | Mitigation |
|------|------------|
| YouTube audit is slow or rejected | Submit on day 1 with a clear description of an internal tool for our own channels. Everything else can be built meanwhile. Uploads stay Private until approved. |
| A member's Instagram tester invite isn't accepted, or the account isn't Professional | Connection screen checks both and shows the fix. |
| Instagram metric or API changes | Instagram adapter file, schema validation, and an alert when a metric is missing. |
| Expectation of guaranteed views | Suggestions show the evidence and the result of each change, honestly. |

## Sources

- YouTube `videos.insert` (Private lock for unaudited projects, `publishAt`, upload quota): https://developers.google.com/youtube/v3/docs/videos/insert
- YouTube quota costs: https://developers.google.com/youtube/v3/determine_quota_cost
- Google OAuth app audience (Testing 7-day expiry, unverified app 100-user cap): https://support.google.com/cloud/answer/15549945
- Instagram content publishing (Professional accounts, 100 posts/24 h, public `video_url`): https://developers.facebook.com/docs/instagram-platform/content-publishing/
- Instagram App Review (not needed for accounts you own or manage): https://developers.facebook.com/docs/instagram-platform/app-review/
- Instagram user insights (`online_followers`): https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/insights/
- Instagram Tester invite steps (community guide): https://keryx.phpboyscout.uk/how-to/instagram-credentials/
- Vercel cron limits and Hobby fair use: https://vercel.com/docs/cron-jobs/usage-and-pricing, https://vercel.com/docs/limits/fair-use-guidelines
- Free tiers: https://developers.cloudflare.com/r2/pricing/, https://www.inngest.com/pricing, https://resend.com/pricing
