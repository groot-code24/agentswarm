import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, readJson, withUser } from "@/lib/http";
import { audit, isAdmin } from "@/lib/session";
import { deleteAccess, setAccess } from "@/lib/access";

// Admin only: approve, remove or forget who may sign in.
const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  action: z.enum(["approve", "block", "delete"]),
});

export const POST = withUser(async (req, user) => {
  if (!isAdmin(user.email)) throw new HttpError(403, "Only the admin can change who has access.");
  const { email, action } = await readJson(req, Body);
  try {
    if (action === "delete") await deleteAccess(email);
    else await setAccess(email, action === "approve" ? "approved" : "blocked", user.email);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  await audit(user.id, `access.${action}`, { email });
  return NextResponse.json({ ok: true });
});
