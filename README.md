# 🎬 Clip Autopilot

A private tool for our team (5–10 people). Upload a long video and it is split into
clips in your browser. The clips are then posted automatically to **YouTube Shorts**
and **Instagram Reels** at the best times for each account. When clips run out,
you get an email. It also suggests changes that could bring more views, and applies
them only when you approve.

- **Automation mode:** choose posts per day (minimum 2). Every clip goes to the selected YouTube and Instagram accounts at each account's best hours. The plan is shown for review before it starts.
- **Manual mode:** preview clips, download them, or press **Post now** on any clip.
- **Best times** are learned in stages: typical peak hours at first, then the audience's online hours, then your own results after about 20 posts.
- **Emails:** a warning when 3 days of clips are left, and *"Your clips are running out. Kindly add more clips."* when the queue is empty. There are also emails for failed posts and accounts that need reconnecting.
- **Analytics:** views at 1 h / 24 h / 3 days / 7 days per clip, best-hours charts, and comparisons by format and clip length.
- **Suggestions:** better posting times, fewer posts per day, clip length, vertical format, watch-time and hashtag advice. Every applied change can be undone.
- **Safety:** each post is sent at most once, even after crashes or retries. Temporary errors are retried up to 3 times. Tokens are encrypted, and clip files are deleted 48 h after posting.

## Quick start (local, dry run: nothing is posted)

```bash
npm install
cp .env.example .env.local     # then set SESSION_SECRET, ENCRYPTION_KEY, ALLOWED_EMAILS (see SETUP.md step 0)
npm run dev                    # http://localhost:3000
npm run tick                   # second terminal: runs the scheduler every minute
```

## Going live

Follow **[SETUP.md](SETUP.md)**. It covers Neon, Vercel Blob (or Cloudflare R2), Google (login + YouTube, plus the
YouTube API audit), the Meta app for Instagram, Resend, Vercel and a free per-minute cron.
Every service used has a free plan.

The reasoning, platform rules and decisions are in [docs/PLATFORM_PLAN.md](docs/PLATFORM_PLAN.md).
What to build next to grow on Instagram: [docs/INSTAGRAM_GROWTH_ROADMAP.md](docs/INSTAGRAM_GROWTH_ROADMAP.md).

## Development

```bash
npm test            # offline tests: planner + full automation run with simulated platforms
npm run typecheck
npm run build
```

## Also in this repo: the local Flask clipper

`app.py`, `templates/` and `run.bat` are the original stand-alone clipper, which uses native ffmpeg
on your own PC and handles very large files. Run it with `run.bat` (Windows) or `python app.py`.
It isn't part of the deployed platform (`.vercelignore` excludes it).
