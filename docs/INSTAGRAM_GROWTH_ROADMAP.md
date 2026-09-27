# Clip Autopilot: roadmap to the best Instagram growth platform

**For:** the owner of Clip Autopilot, who uses it to grow their own Instagram (and YouTube) accounts.
**Written:** 27 September 2026, after the title & caption writer and 5-posts-per-day release.
**Goal of this document:** say honestly where the platform stands, what actually grows an Instagram account
in 2026, and which features to build next (in order), with what Instagram's API allows.

---

## 1. Summary

The platform already does the "boring half" of growth well: it cuts videos fast, posts on time at your
audience's best hours, writes a unique title/caption/hashtags for every clip, tracks views, and suggests
changes. What it doesn't do yet is the half that decides whether a Reel gets pushed to new people:

1. **Make each clip better, not just shorter**: pick the best moments, add burned-in captions and a hook in
   the first 2 seconds, and reframe to 9:16 around faces.
2. **Test before you commit**: use Trial Reels and A/B hooks, and learn which angles win.
3. **Engage**: reply to comments in the first hour, and run comment-to-DM funnels.
4. **Learn from the right numbers**: retention, shares and saves per reach, and follows per Reel, not just views.
5. **Stay original**: reposted movie/TV clips are the biggest threat to your growth (section 3).

If you build only five things, build these, in this order:

| # | Feature | Why it matters | Effort |
|---|---------|----------------|--------|
| 1 | Burned-in captions + hook text (in the browser, free) | Most Reels are watched muted; captions and a hook raise 3-second hold and watch time | M |
| 2 | Smart moment picking (scene + audio energy + transcript) | Fixed 60 s cuts start and end in the wrong places; the best moments get skipped | M–L |
| 3 | Comment inbox + AI reply suggestions + comment-to-DM | Early replies and conversations are strong ranking signals, and DMs convert viewers to followers | M |
| 4 | Retention & shares dashboard + learning loop into the title writer | Tells you *why* a Reel worked, and makes every next title smarter | M |
| 5 | Trial Reels + cover selection | Test hooks on non-followers without hurting your grid; better covers improve profile-visit conversion | S–M |

---

## 2. What drives Instagram reach now

Instagram has said publicly that recommendations lean mainly on these signals (details change, but the
direction has been stable):

- **Watch time and completion.** Does the viewer watch to the end, and re-watch? This matters most, especially for reaching non-followers.
- **Sends per reach (shares in DMs).** This is the strongest signal for reaching new people.
- **Likes and saves per reach.** Likes weigh more for followers; saves say "come back to this".
- **Originality.** Original Reels are favoured. Reposted content is down-ranked, and accounts that mostly repost can lose recommendation eligibility.
- **The first 1–3 seconds.** If people swipe away early, distribution stops.
- **Consistency.** Posting regularly keeps you in followers' feeds. Quality per post still beats quantity.

**What this means for the tool:**
- **Keep the 5 posts/day ceiling**, but let your numbers decide. The existing "posts per day" suggestion lowers frequency when views per post fall.
- **Invest in the clip itself** (captions, hook, reframing, best moments) before adding more automation.
- **Measure** retention (average watch time ÷ length), shares/reach and saves/reach for every Reel. Some of this is already collected.

---

## 3. The biggest risk: content rights and originality

The clips tested so far are from a well-known animated movie. Posting unedited clips from films, TV or
other creators at 5 per day can lead to:

- **On Instagram:**
  - Reels muted or blocked by rights holders.
  - Removed for copyright, with repeat takedowns disabling the account.
  - Quietly excluded from recommendations as unoriginal. Views collapse, but nothing tells you why.
- **On YouTube:**
  - Content ID claims (ads go to the owner).
  - Copyright strikes (3 = channel deleted).
  - Rejection from monetization under the "reused content" policy.

This isn't legal advice, but the safe direction is clear:

- **Best:** your own footage (talks, streams, podcasts, tutorials, vlogs, gameplay you recorded) or content you have permission to use.
- **Better than raw reposts:** transformation. Add commentary or a voice-over, reaction, analysis or ranking, your own edits, and captions. Credit the source.
- **In the tool:**
  - an "originality checklist" on the Upload page ("Is this your content or licensed? Did you add commentary/edits?");
  - a warning when many uploads come from the same external source;
  - features 1–3 in section 5, which make clips more original.

---

## 4. Where the platform is today

| Area | What exists | Gap |
|------|-------------|-----|
| Cutting | Fast browser splitting; vertical 9:16 (center crop) | Fixed-length cuts; no scene/audio awareness; center crop cuts faces out |
| Text | Per-clip title, description, tags and 3–5 hashtags (Claude/Gemini from frames, or the built-in writer); editable before posting | No burned-in captions or hook overlay; no A/B testing; the writer doesn't learn from results yet |
| Scheduling | Best hours from audience data (IG online followers) and your own results; 2–5 posts/day; retries; crash-safe | Same hours every day of the week; no content-mix rules; no calendar view |
| Instagram publishing | Reels via the official API (Instagram Login); token refresh | No cover choice, collaborators, Trial Reels, Stories, carousels, location |
| Engagement | none | No comment inbox, replies or DM funnels |
| Analytics | Views at 1 h / 24 h / 3 d / 7 d; likes, comments, shares, saves, average watch time; suggestions with approval + undo | No retention %, sends/reach or follows per Reel; no weekday heatmap; no weekly report |
| Ops | Neon, Vercel Blob (1 GB free), cron every minute, email alerts, live checks | Storage fills fast at 5/day; heavy AI work would need a server |

---

## 5. Feature roadmap

Effort: **S** about 1–3 days, **M** about 1–2 weeks, **L** about 3+ weeks (one developer).
Cost: *free* means no paid service is needed.

### A. Make every clip better (biggest impact)

1. **Burned-in captions (auto subtitles)**: M, free.
   - **How:** transcribe in the browser with Whisper (transformers.js/WebGPU), then draw the words onto the frames while encoding (we already re-encode vertical clips with WebCodecs). Offer 2–3 caption styles (word-by-word highlight works well for Reels).
   - **Why:** most viewers start muted; captions raise watch time and make clips feel original.
2. **Hook text overlay in the first 2 seconds**: S, free.
   - **How:** the title writer already writes a hook; burn it on top for the first 2–3 seconds, with a large, high-contrast style.
3. **Smart moment picking**: M–L, free.
   - **How:** score every second of the source by scene changes, audio loudness/laughter peaks, speech density and (with the transcript) "interesting" sentences. Cut clips that start on a strong moment and end on a complete thought, instead of every N seconds.
   - **Bonus:** "Top 10 moments only" mode, so fewer but stronger posts.
4. **Face/subject-aware 9:16 reframing**: M, free.
   - **How:** MediaPipe face detection in the browser; move the crop window smoothly to keep the speaker in frame.
5. **Cover selection**: S, free.
   - **How:** Instagram supports `cover_url` or `thumb_offset` for Reels; YouTube Shorts has no custom thumbnails through the API. Let the AI pick the most expressive frame, or let the user choose.
6. **Length and loop tuning**: S.
   - Suggest shorter cuts (15–30 s) for loopable moments and 60–90 s for story-driven ones, based on your own retention data.
7. **Loudness normalization**: S, free.
   - Consistent volume (-14 LUFS) avoids swipes caused by quiet audio.

### B. Publishing (what Instagram's API allows)

8. **Trial Reels**: S–M.
   - Recent API versions let you publish a Reel as a trial (shown to non-followers first) and share it to followers manually or automatically if it performs. Verify it's available for your app's API version before building.
   - **Use it for:** testing 2 hooks for the same clip, and sharing the winner.
9. **Collaborators**: S. Invite up to 3 accounts as collaborators (`collaborators` field) for cross-audience reach.
10. **Share-to-feed toggle, location and user tags**: S. These are supported container fields.
11. **Stories**: S–M. Publish a "new Reel" Story after each Reel (Stories are supported for professional accounts), to bring followers back.
12. **Carousels from your best frames**: M. "Best moments" photo carousels (up to 10 items) are another format the algorithm rewards with saves.
13. **Publishing-limit awareness**: S. Read `content_publishing_limit` before posting (Instagram caps API posts per account per 24 h), and warn before a plan would exceed it.
14. **Content mix rules**: S. Don't post the same series back to back; interleave videos, and add weekday-specific hours (weekends often differ).
15. **Evergreen recycling**: M. Re-post top performers after 60–90 days with a new hook and cover (Trial Reel first, to avoid duplicate-content penalties).

### C. Engagement automation (Instagram-specific growth)

16. **Comment inbox with AI reply suggestions**: M. Needs the `instagram_business_manage_comments` permission and comment webhooks.
    - One screen with new comments across accounts, and suggested replies you approve with one click.
    - Replying in the first hour keeps the conversation (and distribution) going.
17. **Comment-to-DM funnels**: M.
    - "Comment PART2 and I'll send you the next clip" → an automatic private reply by DM. Needs `instagram_business_manage_messages`; Instagram only allows private replies to recent comments.
    - This turns viewers into followers and conversations, a strong signal.
18. **Pinned first comment**: S. Post a question as the first comment ("Which part next?") to seed discussion.
19. **Mention alerts**: S. Webhook alerts when someone mentions or tags you, so you can reshare to Stories.

### D. Analytics and learning loop

20. **Per-Reel scorecard**: S.
    - Retention % (average watch ÷ length), shares/reach, saves/reach, likes/reach and follows (if the API provides them for your account type).
    - Colour each Reel green/amber/red against your own median.
21. **Learning loop into the title writer**: M. Feed the 10 best and 10 worst titles/hooks (with their retention and shares) into the writer's prompt, so every new title learns from your audience. Store which hook pattern each post used.
22. **A/B tests**: M. The same clip with 2 hooks (via Trial Reels) or 2 covers; after 24 h, keep the winner's style.
23. **Weekday × hour heatmap**: S. Upgrade best-time planning from "best hours" to "best hours per weekday".
24. **Weekly growth email**: S. Followers gained, top 3 Reels and why (retention/shares), and what to try next week.
25. **Niche and competitor benchmarks**: M. Hashtag search and competitor metrics ("business discovery") exist only in the Instagram API **with Facebook Login** (needs a linked Facebook Page). Add that login as an optional second connection if you want it.

### E. Platform

26. **Calendar view**: M. A drag-and-drop week/month view of every queued post.
27. **Approval queue**: S. An optional "review before posting" mode: posts wait for a tap, useful with AI-written text.
28. **More platforms**: M each. Facebook Reels (same Meta app) and Threads are the cheapest to add. TikTok's posting API requires an app audit.
29. **Storage at scale**: S. At 5 posts/day the free 1 GB Blob plan fills fast. The existing R2 option (10 GB free, needs a card) or smaller exports (lower bitrate for Reels) keep it free for longer.
30. **Background processing**: L. Heavy steps (transcription for long videos, smart moment picking) may need a small worker, since Vercel functions are short-lived. Browser-first keeps it free for now.

---

## 6. What the APIs can't do (don't plan on these)

- **No trending or licensed music.** You can't pick sounds from Instagram's library through the API. Keep the video's own audio.
- **No hashtag search or competitor lookup** with Instagram Login alone (needs Facebook Login + a Page, item 25).
- **No editing after publishing** beyond limited fields (for example turning comments on/off). Get the caption right before posting (the Schedule page's **Edit text** is for this).
- **No automatic DMs to people who haven't interacted with you.** Messages must answer a user action (comment, DM, story reply) within Instagram's messaging window.
- **No native scheduling in Instagram.** Clip Autopilot's own scheduler posts at the exact time.

---

## 7. A 90-day plan to grow your account with the tool

**Weeks 1–2: set a baseline**
- Post 3/day at the planned best hours, with "Write them for me" on (add a free Gemini key, SETUP.md 5b).
- Only post clips you'd stop scrolling for yourself: skip weak moments rather than posting everything.
- Note your median 24 h views, retention and shares/reach.

**Weeks 3–6: improve the clip, then scale**
- Build and use features 1–2 (captions + hook overlay). Compare the median against weeks 1–2.
- If retention holds, move to 4–5/day. If views per post drop by more than ~30%, go back down (the suggestion engine will propose this).
- Reply to every comment in the first hour (feature 16 makes this fast).

**Weeks 7–12: learn and double down**
- Turn on Trial Reels for hook tests, and keep the winning styles.
- Use the scorecard: make more of your top 10% (same topic, format and length), and stop what's in your bottom 30%.
- Add comment-to-DM for series ("comment NEXT for part 2") and Stories after each Reel.

**Targets to watch:**
- **Retention:** above 50% for clips under 30 s, above 35% for 60 s.
- **Shares/reach:** rising week over week.
- **Follows per 1,000 views:** your own trend line matters more than any benchmark.

---

## 8. Suggested build order

| Phase | Contents | Rough effort |
|-------|----------|--------------|
| 1 (now → 3 weeks) | Burned-in captions, hook overlay, cover selection, per-Reel scorecard, originality checklist | ~3 weeks |
| 2 | Comment inbox + AI replies, pinned first comment, publishing-limit check, weekday heatmap, weekly email | ~3 weeks |
| 3 | Smart moment picking, face-aware reframing, learning loop into the writer | ~4 weeks |
| 4 | Trial Reels + A/B tests, comment-to-DM funnels, Stories, calendar view | ~4 weeks |
| 5 | Facebook Reels/Threads, competitor benchmarks (Facebook Login), carousels, evergreen recycling | as needed |

Each phase keeps the platform's existing rules: nothing posts without the member's choice, every
AI-written text is editable, suggestions need approval and can be undone, and everything that can run in
the browser for free does.
