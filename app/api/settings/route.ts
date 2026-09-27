import { NextResponse } from "next/server";
import { DateTime } from "luxon";
import { z } from "zod";
import { query } from "@/lib/db";
import { HttpError, readJson, withUser } from "@/lib/http";
import { audit } from "@/lib/session";

const Body = z.object({
  timezone: z.string().min(1).max(64),
  lowStockDays: z.number().int().min(1).max(14),
});

export const POST = withUser(async (req, user) => {
  const body = await readJson(req, Body);
  if (!DateTime.local().setZone(body.timezone).isValid) throw new HttpError(400, "Unknown timezone.");
  await query("UPDATE users SET timezone = $1, low_stock_days = $2 WHERE id = $3", [body.timezone, body.lowStockDays, user.id]);
  await audit(user.id, "settings.updated", body);
  return NextResponse.json({ ok: true });
});
