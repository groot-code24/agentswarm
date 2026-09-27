import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUser, type User } from "./session";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Wraps an API route: requires a signed-in user and turns errors into JSON responses. */
export function withUser<Ctx>(handler: (req: Request, user: User, ctx: Ctx) => Promise<Response>) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      const user = await currentUser();
      if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
      return await handler(req, user, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof z.ZodError) {
    return NextResponse.json({ error: "Invalid request: " + err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") }, { status: 400 });
  }
  console.error(err);
  return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error" }, { status: 500 });
}

export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON.");
  }
  return schema.parse(body);
}
