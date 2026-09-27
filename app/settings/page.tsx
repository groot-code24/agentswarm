import { requireUser } from "@/lib/session";
import { listAccounts } from "@/lib/accounts";
import { fmtWhen, platformLabel } from "@/lib/format";
import SettingsForm from "@/components/SettingsForm";
import DisconnectButton from "@/components/DisconnectButton";
import LiveChecks from "@/components/LiveChecks";
import Icon, { PlatformIcon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const user = await requireUser();
  const accounts = await listAccounts(user.id);
  const { connected, error } = await searchParams;

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Connect the accounts you own, and set your timezone.</p>
        </div>
      </header>
      {(connected || error) && (
        <div className="stack" style={{ marginBottom: 20 }}>
          {connected && (
            <div className="notice ok"><Icon name="check" size={18} /><div>{platformLabel(connected)} connected.</div></div>
          )}
          {error && (
            <div className="notice error"><Icon name="alert" size={18} /><div>{error}</div></div>
          )}
        </div>
      )}

      <section className="card">
        <div className="card-title">
          <h3><Icon name="link" size={18} /> Connected accounts</h3>
          <span className="small muted">{accounts.length} connected</span>
        </div>
        <div className="stack">
          {accounts.map((a) => (
            <div key={a.id} className="list-item" style={{ flexWrap: "wrap", borderTop: 0, padding: 14, background: "var(--surface-2)", borderRadius: 14, border: "1px solid var(--border)" }}>
              <span className="acct-avatar"><PlatformIcon platform={a.platform} size={24} /></span>
              <div className="li-main">
                <div className="row" style={{ gap: 8 }}>
                  <b className="acct-name">{a.name}</b>
                  <span className={`badge ${a.status}`}>{a.status === "ok" ? "Connected" : "Reconnect needed"}</span>
                  {a.meta?.dryRun && <span className="badge">simulated</span>}
                </div>
                <div className="li-sub" style={{ whiteSpace: "normal" }}>
                  {platformLabel(a.platform)}
                  {a.platform === "instagram" && a.token_expires_at && <> · token renews automatically (expires {fmtWhen(a.token_expires_at, user.timezone)})</>}
                </div>
              </div>
              <div className="row">
                {a.status !== "ok" && (
                  <a className="btn small primary" href={`/api/connect/${a.platform}`}><Icon name="refresh" size={14} /> Reconnect</a>
                )}
                <DisconnectButton id={a.id} name={a.name} />
              </div>
            </div>
          ))}
          <div className="connect-grid">
            <a className="connect-card" href="/api/connect/youtube">
              <PlatformIcon platform="youtube" size={32} />
              <div className="cc-text"><b>Connect YouTube</b><span>Add a channel you own</span></div>
              <Icon name="plus" size={18} />
            </a>
            <a className="connect-card" href="/api/connect/instagram">
              <PlatformIcon platform="instagram" size={32} />
              <div className="cc-text"><b>Connect Instagram</b><span>Professional accounts only</span></div>
              <Icon name="plus" size={18} />
            </a>
          </div>
          <div className="two-col small" style={{ gap: 12 }}>
            <div className="notice" style={{ display: "block" }}>
              <b style={{ color: "var(--text)" }}>Before connecting Instagram:</b> your account must be a <b>Professional</b> account
              (Instagram → Settings → Account type and tools → Switch to professional account), and the admin must add your username as an
              <b> Instagram Tester</b> in the Meta app. Accept the invite in Instagram → Settings → Apps and websites → Tester invites.
            </div>
            <div className="notice" style={{ display: "block" }}>
              <b style={{ color: "var(--text)" }}>Connecting YouTube:</b> Google shows &quot;Google hasn&apos;t verified this app&quot; the first time.
              That&apos;s expected for our private tool: click <i>Advanced → Go to Clip Autopilot</i> and tick all boxes.
            </div>
          </div>
        </div>
      </section>

      <h2>Your preferences</h2>
      <section className="card">
        <SettingsForm timezone={user.timezone} lowStockDays={user.low_stock_days} />
      </section>

      <h2>System status</h2>
      <section className="card">
        <LiveChecks />
      </section>
    </main>
  );
}
