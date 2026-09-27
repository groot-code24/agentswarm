import { requireUser } from "@/lib/session";
import { listAccounts } from "@/lib/accounts";
import { QUEUE_CAP_BYTES, queueBytes } from "@/lib/schedule";
import UploadStudio from "@/components/UploadStudio";

export const dynamic = "force-dynamic";
export const metadata = { title: "Upload" };

export default async function UploadPage() {
  const user = await requireUser();
  const accounts = (await listAccounts(user.id)).map((a) => ({ id: a.id, platform: a.platform, name: a.name, status: a.status }));
  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Upload a video</h1>
          <p>Your video is split into clips right here in your browser. Choose every setting below; nothing is pre-selected.</p>
        </div>
      </header>
      <UploadStudio
        accounts={accounts}
        prefs={user.prefs || {}}
        queueUsed={await queueBytes(user.id)}
        queueCap={QUEUE_CAP_BYTES}
        timezone={user.timezone}
      />
    </main>
  );
}
