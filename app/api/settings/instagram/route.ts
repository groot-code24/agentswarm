import { NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/lib/db";
import { readJson, withUser } from "@/lib/http";
import { audit } from "@/lib/session";

// The member's Instagram username. The admin sees it in the Admin panel and adds it as an
// Instagram Tester in the Meta app (needed before the account can be connected).
const Body = z.object({
  username: z
    .string()
    .trim()
    .transform((u) => u.replace(/^@/, "").toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9._]{1,30}$/, "That doesn't look like an Instagram username.")),
});

export const POST = withUser(async (req, user) => {
  const { username } = await readJson(req, Body);
  await query("UPDATE users SET prefs = prefs || $1::jsonb WHERE id = $2", [JSON.stringify({ instagramUsername: username }), user.id]);
  await audit(user.id, "settings.instagram_username", { username });
  return NextResponse.json({ ok: true, username });
});
