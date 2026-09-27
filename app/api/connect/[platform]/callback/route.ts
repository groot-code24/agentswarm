import { finishConnect } from "@/lib/connect";

// Instagram returns here. (YouTube now returns to /api/auth/google/callback; this path
// still works for it in case an older link or registered redirect URI points here.)
export async function GET(req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  return finishConnect(req, platform);
}
