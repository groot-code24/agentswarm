import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { env, features } from "./env";
import { sign, verifySignature } from "./crypto";

// Clip storage. Production: any S3-compatible bucket (Cloudflare R2 recommended).
// Local dev: files under .data/storage, served through signed /api/storage/local URLs.
// Browsers upload directly with pre-signed URLs, so video bytes never pass through
// our functions (Vercel caps request bodies at ~4.5 MB).

const LOCAL_ROOT = resolve(".data/storage");

async function s3() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: env.s3Region,
    endpoint: env.s3Endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: env.s3AccessKeyId, secretAccessKey: env.s3SecretAccessKey },
    // R2 and other S3-compatible stores reject the SDK's default extra checksum headers on presigned uploads.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

function localPath(key: string): string {
  const p = resolve(join(LOCAL_ROOT, key));
  if (!p.startsWith(LOCAL_ROOT)) throw new Error("Invalid storage key.");
  return p;
}

function localUrl(op: "put" | "get", key: string, expiresSec: number): string {
  const exp = Math.floor(Date.now() / 1000) + expiresSec;
  const sig = sign(`${op}:${key}:${exp}`);
  const qs = new URLSearchParams({ op, key, exp: String(exp), sig });
  return `${env.appUrl}/api/storage/local?${qs}`;
}

export function verifyLocalUrl(op: string, key: string, exp: string, sig: string): boolean {
  return Number(exp) * 1000 > Date.now() && verifySignature(`${op}:${key}:${exp}`, sig);
}

export async function presignPut(key: string, contentType: string): Promise<string> {
  if (!features.s3) return localUrl("put", key, 3600);
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  return getSignedUrl(await s3(), new PutObjectCommand({ Bucket: env.s3Bucket, Key: key, ContentType: contentType }), {
    expiresIn: 3600,
  });
}

/** A temporary public link. Instagram downloads the clip from it when publishing. */
export async function presignGet(key: string, expiresSec = 3 * 3600): Promise<string> {
  if (!features.s3) return localUrl("get", key, expiresSec);
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  return getSignedUrl(await s3(), new GetObjectCommand({ Bucket: env.s3Bucket, Key: key }), { expiresIn: expiresSec });
}

export async function getObject(key: string): Promise<Buffer> {
  if (!features.s3) return readFile(localPath(key));
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const res = await (await s3()).send(new GetObjectCommand({ Bucket: env.s3Bucket, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

export async function objectSize(key: string): Promise<number | null> {
  try {
    if (!features.s3) return (await readFile(localPath(key))).length;
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const res = await (await s3()).send(new HeadObjectCommand({ Bucket: env.s3Bucket, Key: key }));
    return res.ContentLength ?? null;
  } catch {
    return null;
  }
}

export async function deleteObject(key: string): Promise<void> {
  if (!features.s3) {
    await rm(localPath(key), { force: true });
    return;
  }
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  await (await s3()).send(new DeleteObjectCommand({ Bucket: env.s3Bucket, Key: key }));
}

// Local-dev helpers used by /api/storage/local
export async function writeLocal(key: string, data: Buffer) {
  const p = localPath(key);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, data);
}
export async function readLocal(key: string): Promise<Buffer> {
  return readFile(localPath(key));
}

/** Server-side write, used only by the setup checks. */
export async function putObject(key: string, data: Buffer, contentType: string): Promise<void> {
  if (!features.s3) {
    await writeLocal(key, data);
    return;
  }
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await (await s3()).send(new PutObjectCommand({ Bucket: env.s3Bucket, Key: key, Body: data, ContentType: contentType }));
}
