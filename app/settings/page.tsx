import { requireUser } from "@/lib/session";
import { listAccounts } from "@/lib/accounts";
import { fmtWhen, platformLabel } from "@/lib/format";
import SettingsForm from "@/components/SettingsForm";
import DisconnectButton from "@/components/DisconnectButton";
import LiveChecks from "@/components/LiveChecks";
import Icon, { PlatformIcon } from "@/components/Icon";
import InstagramUsername from "@/components/InstagramUsername";
import { features } from "@/lib/env";

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
          {accounts.some((a) => a.meta?.googleTestingMode) && (
            <div className="notice warn">
              <Icon name="alert" size={18} />
              <div>
                Google says this app is in <b>Testing</b> mode, so your YouTube connection stops working after 7 days. Ask the admin to
                publish it (Google Cloud → Google Auth Platform → Audience → <b>Publish app</b>), then reconnect.
              </div>
            </div>
          )}
          <div className="two-col small" style={{ gap: 12 }}>
            <div className="notice" style={{ display: "block" }}>
              <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                <PlatformIcon platform="youtube" size={18} /> <b style={{ color: "var(--text)" }}>Connecting YouTube</b>
              </div>
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                <li>Press <b>Connect YouTube</b> and pick the Google account that owns your channel (for a Brand Account channel, pick the channel&apos;s name).</li>
                <li>If Google says &quot;Google hasn&apos;t verified this app&quot;: click <i>Advanced → Go to Clip Autopilot</i>. That&apos;s expected for our private tool.</li>
                <li>Tick <b>both</b> YouTube boxes (or &quot;Select all&quot;) and press <b>Continue</b>.</li>
              </ol>
              <div style={{ marginTop: 6 }}>
                If Google shows <i>&quot;Access blocked … has not completed the Google verification process&quot;</i>, the admin still has to publish the
                app in Google Cloud. No YouTube channel yet? <a href="https://www.youtube.com/create_channel" target="_blank" rel="noreferrer">Create one</a> first.
              </div>
            </div>
            <div className="notice" style={{ display: "block" }}>
              <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                <PlatformIcon platform="instagram" size={18} /> <b style={{ color: "var(--text)" }}>Connecting Instagram</b>
              </div>
              {!features.instagram && (
                <div style={{ marginBottom: 6, color: "var(--warn)" }}>Instagram isn&apos;t set up on this site yet (the admin needs to finish SETUP.md step 4).</div>
              )}
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                <li>
                  Your account must be <b>Professional</b> (Creator or Business): Instagram → Settings → Account type and tools → Switch to professional
                  account. It&apos;s free.
                </li>
                <li>Enter your Instagram username below so the admin can add you as an <b>Instagram Tester</b>.</li>
                <li>
                  Accept the invite: <a href="https://www.instagram.com/accounts/manage_access/" target="_blank" rel="noreferrer">instagram.com → Apps and
                  websites → Tester invites</a> → Accept.
                </li>
                <li>Press <b>Connect Instagram</b> and <b>Allow</b>.</li>
              </ol>
              <div style={{ marginTop: 8 }}>
                <InstagramUsername current={user.prefs?.instagramUsername ?? ""} />
              </div>
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
