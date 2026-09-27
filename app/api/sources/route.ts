import { NextResponse } from "next/server";
import { z } from "zod";
import { newId, query } from "@/lib/db";
import { HttpError, readJson, withUser } from "@/lib/http";
import { listAccounts } from "@/lib/accounts";
import { MAX_POSTS_PER_DAY, MIN_POSTS_PER_DAY } from "@/lib/planner";

// One record per split video, holding the member's choices. Every choice is required
// (the upload page has no pre-selected settings).
const Body = z.object({
  filename: z.string().min(1).max(300),
  duration: z.number().positive(),
  mode: z.enum(["automation", "manual"]),
  accountIds: z.array(z.string()).max(20),
  clipLength: z.number().int().min(5).max(180),
  format: z.enum(["original", "vertical"]),
  postsPerDay: z.number().int().min(MIN_POSTS_PER_DAY).max(MAX_POSTS_PER_DAY).nullable(),
  title: z.string().max(90).default(""),
  description: z.string().max(2000).default(""),
  hashtags: z.string().max(500).default(""),
  // "optimize": titles/descriptions/tags are written per clip (lib/seo.ts); "as_written": the member's own text.
  seoMode: z.enum(["optimize", "as_written"]),
  topic: z.string().max(200).default(""),
  language: z.string().max(40).default(""),
});

export const POST = withUser(async (req, user) => {
  const body = await readJson(req, Body);
  if (body.mode === "automation") {
    const mine = new Set((await listAccounts(user.id)).map((a) => a.id));
    if (!body.accountIds.length) throw new HttpError(400, "Choose at least one account to post to.");
    if (!body.accountIds.every((id) => mine.has(id))) throw new HttpError(400, "Unknown account.");
    if (!body.postsPerDay) throw new HttpError(400, "Choose how many posts per day.");
  }
  const id = newId();
  await query(
    `INSERT INTO source_videos (id, user_id, filename, duration, mode, account_ids, clip_length, format, posts_per_day, title, description, hashtags,
                                seo_mode, topic, language)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id,
      user.id,
      body.filename,
      body.duration,
      body.mode,
      body.mode === "automation" ? body.accountIds : [],
      body.clipLength,
      body.format,
      body.mode === "automation" ? body.postsPerDay : null,
      body.title,
      body.description,
      body.hashtags,
      body.seoMode,
      body.topic.trim(),
      body.language.trim(),
    ],
  );
  return NextResponse.json({ id });
});
