// Central place for configuration. Everything optional has a local-dev fallback,
// and production refuses to start without the settings it can't work without.

const isProd = process.env.NODE_ENV === "production";

function list(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const env = {
  isProd,
  appUrl: (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, ""),
  sessionSecret: process.env.SESSION_SECRET || (isProd ? "" : "dev-only-session-secret-change-me-please-32b"),
  encryptionKey: process.env.ENCRYPTION_KEY || "",
  allowedEmails: list(process.env.ALLOWED_EMAILS),
  adminEmail: (process.env.ADMIN_EMAIL || "").trim().toLowerCase(),

  databaseUrl: process.env.DATABASE_URL || "",

  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  instagramAppId: process.env.INSTAGRAM_APP_ID || "",
  instagramAppSecret: process.env.INSTAGRAM_APP_SECRET || "",
  instagramApiVersion: process.env.INSTAGRAM_API_VERSION || "v25.0",

  s3Endpoint: process.env.S3_ENDPOINT || "",
  s3Bucket: process.env.S3_BUCKET || "",
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || "",
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
  s3Region: process.env.S3_REGION || "auto",

  resendApiKey: process.env.RESEND_API_KEY || "",
  emailFrom: process.env.EMAIL_FROM || "Clip Autopilot <onboarding@resend.dev>",

  cronSecret: process.env.CRON_SECRET || "",
  // Dry run: YouTube/Instagram are simulated. Nothing is posted anywhere.
  dryRun: process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1",
};

export const features = {
  googleLogin: Boolean(env.googleClientId && env.googleClientSecret),
  instagram: Boolean(env.instagramAppId && env.instagramAppSecret),
  s3: Boolean(env.s3Endpoint && env.s3Bucket && env.s3AccessKeyId && env.s3SecretAccessKey),
  email: Boolean(env.resendApiKey),
  // Email-only sign-in without Google, for local development only.
  devLogin: !isProd && !(env.googleClientId && env.googleClientSecret),
};

/** Problems that make the deployment unsafe or unusable. Shown on the login page. */
export function configProblems(): string[] {
  const problems: string[] = [];
  if (!env.sessionSecret || env.sessionSecret.length < 32) problems.push("SESSION_SECRET must be set (32+ characters).");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(env.encryptionKey)) problems.push("ENCRYPTION_KEY must be 32 random bytes in base64 (see .env.example).");
  if (env.allowedEmails.length === 0) problems.push("ALLOWED_EMAILS is empty, so nobody can log in.");
  if (isProd) {
    if (!env.databaseUrl) problems.push("DATABASE_URL is required in production.");
    if (!features.s3) {
      const missing = (["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const).filter((k) => !process.env[k]);
      problems.push(`Clip storage (Cloudflare R2) is not set up. Missing in Vercel: ${missing.join(", ")}. See SETUP.md step 2.`);
    }
    if (!features.googleLogin) problems.push("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are required in production.");
    if (!env.cronSecret) problems.push("CRON_SECRET is required in production.");
  }
  return problems;
}
