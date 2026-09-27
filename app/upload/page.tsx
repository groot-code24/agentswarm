import { requireUser } from "@/lib/session";
import { listAccounts } from "@/lib/accounts";
import { queueBytes, queueCapBytes } from "@/lib/schedule";
import { env, features } from "@/lib/env";
import { storageBackend } from "@/lib/storage";
import UploadStudio from "@/components/UploadStudio";
import Icon from "@/components/Icon";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata = { title: "Upload" };

export default async function UploadPage() {
  const user = await requireUser();
  const accounts = (await listAccounts(user.id)).map((a) => ({ id: a.id, platform: a.platform, name: a.name, status: a.status }));
  const used = await queueBytes(user.id);
  const cap = await queueCapBytes();
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
  // A local copy keeping clips on this computer's disk while using the shared (live) database:
  // the live site's scheduler can't reach those files.
  const localWithSharedDb = !env.isProd && storageBackend() === "local" && /^postgres(ql)?:\/\//.test(env.databaseUrl);
  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Upload a video</h1>
          <p>Your video is split into clips right here in your browser. Choose every setting below; nothing is pre-selected.</p>
        </div>
        <div className="small muted">
          Storage used: <b style={{ color: used > cap ? "var(--danger)" : "var(--text)" }}>{mb(used)}</b> of {mb(cap)} ·{" "}
          <Link href="/schedule">manage</Link>
        </div>
      </header>
      {localWithSharedDb && (
        <div className="notice warn" style={{ marginBottom: 16 }}>
          <Icon name="alert" size={18} />
          <div>
            This local copy stores clips on this computer&apos;s disk but uses the shared database. Clips scheduled here can&apos;t be
            posted by the live site. Add <code>BLOB_READ_WRITE_TOKEN</code> to <code>.env.local</code> (same value as in Vercel) or use a
            Neon dev branch (SETUP.md step 1).
          </div>
        </div>
      )}
      <UploadStudio
        accounts={accounts}
        prefs={user.prefs || {}}
        queueUsed={used}
        queueCap={cap}
        timezone={user.timezone}
        seoEngine={features.seoEngine}
      />
    </main>
  );
}
