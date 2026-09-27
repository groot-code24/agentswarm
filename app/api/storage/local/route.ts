import { features } from "@/lib/env";
import { readLocal, verifyLocalUrl, writeLocal } from "@/lib/storage";

// Local development storage (used only when no S3/R2 bucket is configured).
// URLs are signed and expire, like real pre-signed bucket URLs.

function check(req: Request, op: "put" | "get") {
  if (features.s3) return "Local storage is disabled when a bucket is configured.";
  const q = new URL(req.url).searchParams;
  if (q.get("op") !== op || !verifyLocalUrl(op, q.get("key") || "", q.get("exp") || "", q.get("sig") || "")) return "Invalid or expired link.";
  return null;
}

export async function PUT(req: Request) {
  const problem = check(req, "put");
  if (problem) return new Response(problem, { status: 403 });
  await writeLocal(new URL(req.url).searchParams.get("key")!, Buffer.from(await req.arrayBuffer()));
  return new Response(null, { status: 200 });
}

export async function GET(req: Request) {
  const problem = check(req, "get");
  if (problem) return new Response(problem, { status: 403 });
  try {
    const data = await readLocal(new URL(req.url).searchParams.get("key")!);
    return new Response(new Uint8Array(data), { headers: { "Content-Type": "video/mp4", "Content-Length": String(data.length) } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
