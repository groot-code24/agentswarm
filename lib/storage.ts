import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { env, features } from "./env";
import { sign, verifySignature } from "./crypto";

// Clip storage, one of three backends:
//  - "s3":   any S3-compatible bucket (Cloudflare R2), when the S3_* settings are present
//  - "blob": Vercel Blob (free on the Hobby plan), when BLOB_READ_WRITE_TOKEN is present
//  - "local": files under .data/storage, served through signed /api/storage/local URLs (local dev)
// Browsers upload straight to storage (pre-signed URL or short-lived Blob token), so video bytes
// never pass through our functions (Vercel caps request bodies at ~4.5 MB).
// Blob clips are public objects at unguessable paths: Instagram must be able to download them.

const LOCAL_ROOT = resolve(".data/storage");

export type StorageBackend = "s3" | "blob" | "local";
export function storageBackend(): StorageBackend {
  return features.s3 ? "s3" : features.blob ? "blob" : "local";
}

/** The clip's file isn't in storage (e.g. it was uploaded by a local copy of the app, to that computer's disk). */
export class ClipMissingError extends Error {
  constructor(key: string) {
    super(
      `The clip file isn't in ${storageBackend() === "local" ? "local" : "cloud"} storage (${key.split("/").pop()}). ` +
        "It was probably uploaded from a different copy of the app (e.g. localhost). Cancel this post and upload the video again here.",
    );
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  // Vercel Blob's BlobNotFoundError has no distinct name, only its message.
  return String(e?.message).includes("The requested blob does not exist") || e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.code === "ENOENT" || e?.$metadata?.httpStatusCode === 404;
}

async function orMissing<T>(key: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw isNotFound(err) ? new ClipMissingError(key) : err;
  }
}

/** How the browser uploads one clip: PUT to a URL, or the Vercel Blob client with a token. */
export type UploadTarget = { kind: "url"; url: string } | { kind: "vercel-blob"; pathname: string; token: string };

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

export async function uploadTarget(key: string, contentType: string, bytes: number): Promise<UploadTarget> {
  if (storageBackend() !== "blob") return { kind: "url", url: await presignPut(key, contentType) };
  const { generateClientTokenFromReadWriteToken } = await import("@vercel/blob/client");
  const token = await generateClientTokenFromReadWriteToken({
    token: env.blobToken,
    pathname: key,
    allowedContentTypes: [contentType],
    maximumSizeInBytes: bytes,
    validUntil: Date.now() + 3600_000,
    addRandomSuffix: false,
    allowOverwrite: true, // a retried upload replaces the half-finished one
  });
  return { kind: "vercel-blob", pathname: key, token };
}

/** Pre-signed PUT URL (S3 or local only; Vercel Blob uses uploadTarget tokens). */
export async function presignPut(key: string, contentType: string): Promise<string> {
  if (storageBackend() === "local") return localUrl("put", key, 3600);
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  return getSignedUrl(await s3(), new PutObjectCommand({ Bucket: env.s3Bucket, Key: key, ContentType: contentType }), {
    expiresIn: 3600,
  });
}

/** A link Instagram (and our own server) can download the clip from. */
export async function presignGet(key: string, expiresSec = 3 * 3600): Promise<string> {
  const backend = storageBackend();
  if (backend === "local") return localUrl("get", key, expiresSec);
  if (backend === "blob") {
    const { head } = await import("@vercel/blob");
    return orMissing(key, async () => (await head(key, { token: env.blobToken })).url);
  }
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  return getSignedUrl(await s3(), new GetObjectCommand({ Bucket: env.s3Bucket, Key: key }), { expiresIn: expiresSec });
}

export async function getObject(key: string): Promise<Buffer> {
  const backend = storageBackend();
  if (backend === "local") return orMissing(key, () => readFile(localPath(key)));
  if (backend === "blob") {
    const res = await fetch(await presignGet(key), { cache: "no-store" });
    if (res.status === 404) throw new ClipMissingError(key);
    if (!res.ok) throw new Error(`Couldn't download the clip from Vercel Blob (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  return orMissing(key, async () => {
    const res = await (await s3()).send(new GetObjectCommand({ Bucket: env.s3Bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  });
}

export async function objectSize(key: string): Promise<number | null> {
  try {
    const backend = storageBackend();
    if (backend === "local") return (await readFile(localPath(key))).length;
    if (backend === "blob") {
      const { head } = await import("@vercel/blob");
      return (await head(key, { token: env.blobToken })).size;
    }
    const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
    const res = await (await s3()).send(new HeadObjectCommand({ Bucket: env.s3Bucket, Key: key }));
    return res.ContentLength ?? null;
  } catch {
    return null;
  }
}

/** Deletes a clip file; a file that is already gone counts as deleted. */
export async function deleteObject(key: string): Promise<void> {
  try {
    await deleteObjectRaw(key);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

async function deleteObjectRaw(key: string): Promise<void> {
  const backend = storageBackend();
  if (backend === "local") {
    await rm(localPath(key), { force: true });
    return;
  }
  if (backend === "blob") {
    const { del } = await import("@vercel/blob");
    await del(key, { token: env.blobToken });
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
  const backend = storageBackend();
  if (backend === "local") {
    await writeLocal(key, data);
    return;
  }
  if (backend === "blob") {
    const { put } = await import("@vercel/blob");
    await put(key, data, { access: "public", contentType, addRandomSuffix: false, allowOverwrite: true, token: env.blobToken });
    return;
  }
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await (await s3()).send(new PutObjectCommand({ Bucket: env.s3Bucket, Key: key, Body: data, ContentType: contentType }));
}
