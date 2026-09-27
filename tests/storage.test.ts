import { afterEach, describe, expect, it, vi } from "vitest";

// Storage backend selection and Vercel Blob upload tokens (no network: tokens are signed locally).
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("storage backend", () => {
  it("uses local disk when nothing is configured", async () => {
    const { storageBackend, uploadTarget } = await import("../lib/storage");
    expect(storageBackend()).toBe("local");
    const target = await uploadTarget("clips/a.mp4", "video/mp4", 1000);
    expect(target.kind).toBe("url");
  });

  it("uses Vercel Blob when BLOB_READ_WRITE_TOKEN is set, with a token scoped to one file", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_teststore123_secretsecretsecret");
    const { storageBackend, uploadTarget } = await import("../lib/storage");
    const { getPayloadFromClientToken } = await import("@vercel/blob/client");
    expect(storageBackend()).toBe("blob");
    const target = await uploadTarget("clips/u/s/0001-x.mp4", "video/mp4", 5_000_000);
    expect(target.kind).toBe("vercel-blob");
    if (target.kind !== "vercel-blob") return;
    expect(target.pathname).toBe("clips/u/s/0001-x.mp4");
    const payload = getPayloadFromClientToken(target.token);
    expect(payload.pathname).toBe("clips/u/s/0001-x.mp4");
    expect(payload.maximumSizeInBytes).toBe(5_000_000);
    expect(payload.allowedContentTypes).toEqual(["video/mp4"]);
    expect(payload.addRandomSuffix).toBe(false);
    expect(payload.validUntil).toBeGreaterThan(Date.now());
  });

  it("shares the free Blob space between team members", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_teststore123_secretsecretsecret");
    vi.stubEnv("ALLOWED_EMAILS", "a@x.com,b@x.com,c@x.com");
    const { queueCapBytes } = await import("../lib/schedule");
    expect(queueCapBytes()).toBe(Math.floor((900 * 1024 * 1024) / 3));
  });

  it("prefers R2 when both are configured", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_teststore123_secretsecretsecret");
    vi.stubEnv("S3_ENDPOINT", "https://example.r2.cloudflarestorage.com");
    vi.stubEnv("S3_BUCKET", "b");
    vi.stubEnv("S3_ACCESS_KEY_ID", "k");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "s");
    const { storageBackend } = await import("../lib/storage");
    const { queueCapBytes } = await import("../lib/schedule");
    expect(storageBackend()).toBe("s3");
    expect(queueCapBytes()).toBe(1024 * 1024 * 1024);
  });
});
