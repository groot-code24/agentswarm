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
  // Starting list of members. After that, the admin approves/removes people in the Admin panel.
  allowedEmails: list(process.env.ALLOWED_EMAILS),
  // Admins (comma-separated): open the Admin panel, approve sign-ins, get the daily summary.
  // Without ADMIN_EMAIL, the first ALLOWED_EMAILS address is the admin.
  adminEmails: list(process.env.ADMIN_EMAIL).length ? list(process.env.ADMIN_EMAIL) : list(process.env.ALLOWED_EMAILS).slice(0, 1),
  adminEmail: (list(process.env.ADMIN_EMAIL)[0] || list(process.env.ALLOWED_EMAILS)[0] || ""),

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
  // Vercel Blob (free on the Hobby plan, no card): added automatically when a Blob store is connected to the project.
  blobToken: process.env.BLOB_READ_WRITE_TOKEN || "",

  // AI for titles/captions and suggestions (optional). Gemini (free tier) if GEMINI_API_KEY is set,
  // else Claude if ANTHROPIC_API_KEY is set, else the built-in rule-based writer (no AI suggestions).
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-5",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-flash-latest",

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
  blob: Boolean(env.blobToken),
  email: Boolean(env.resendApiKey),
  seoEngine: (env.geminiApiKey ? "gemini" : env.anthropicApiKey ? "claude" : "rules") as "claude" | "gemini" | "rules",
  // Email-only sign-in without Google, for local development only.
  devLogin: !isProd && !(env.googleClientId && env.googleClientSecret),
};

/** Problems that make the deployment unsafe or unusable. Shown on the login page. */
export function configProblems(): string[] {
  const problems: string[] = [];
  if (!env.sessionSecret || env.sessionSecret.length < 32) problems.push("SESSION_SECRET must be set (32+ characters).");
  if (!/^[A-Za-z0-9+/]{43}=$/.test(env.encryptionKey)) problems.push("ENCRYPTION_KEY must be 32 random bytes in base64 (see .env.example).");
  if (env.adminEmails.length === 0) problems.push("Set ADMIN_EMAIL to your email: you sign in first and approve everyone else in the Admin panel.");
  if (isProd) {
    if (!env.databaseUrl) problems.push("DATABASE_URL is required in production.");
    if (!features.s3 && !features.blob) {
      problems.push(
        process.env.BLOB_STORE_ID
          ? "Vercel Blob is connected, but BLOB_READ_WRITE_TOKEN is missing. Copy it from the Blob store's settings into the project's environment variables (SETUP.md step 2)."
          : "Clip storage is not set up. In Vercel: Storage → Create → Blob (free) → connect it to this project, then redeploy. See SETUP.md step 2.",
      );
    }
    if (!features.googleLogin) problems.push("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are required in production.");
    if (!env.cronSecret) problems.push("CRON_SECRET is required in production.");
  }
  return problems;
}
