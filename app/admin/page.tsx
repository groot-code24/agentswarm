import { query } from "@/lib/db";
import { env, features } from "@/lib/env";
import { requireAdmin } from "@/lib/session";
import { fmtWhen } from "@/lib/format";
import type { AccessRow } from "@/lib/access";
import { AccessButtons, AddMember } from "@/components/AdminAccess";
import Icon, { PlatformIcon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin" };

type Person = {
  email: string;
  name: string | null;
  kind: "admin" | "approved" | "starting-list" | "pending" | "blocked" | "no-access";
  requestedAt: Date | null;
  decidedAt: Date | null;
  joinedAt: Date | null;
  lastLogin: Date | null;
  accounts: number;
  waiting: number;
  hasRow: boolean;
  connected: { platform: string; name: string; status: string }[];
  igUsername: string | null;
  /** Latest unfinished or failed connection attempt per platform. */
  problems: { platform: string; text: string }[];
};

export default async function AdminPage() {
  const admin = await requireAdmin();
  const tz = admin.timezone;

  const rows = await query<AccessRow>("SELECT * FROM access_list ORDER BY requested_at DESC");
  const users = await query<{ id: string; email: string; name: string | null; created_at: Date; accounts: number; waiting: number; ig: string | null }>(
    `SELECT u.id, u.email, u.name, u.created_at, u.prefs->>'instagramUsername' AS ig,
            (SELECT COUNT(*)::int FROM connected_accounts a WHERE a.user_id = u.id) AS accounts,
            (SELECT COUNT(*)::int FROM posts p WHERE p.user_id = u.id AND p.status IN ('queued', 'uploading', 'processing')) AS waiting
       FROM users u`,
  );
  const connectedRows = await query<{ user_id: string; platform: string; name: string; status: string; testing: string | null; dry: string | null }>(
    "SELECT user_id, platform, name, status, meta->>'googleTestingMode' AS testing, meta->>'dryRun' AS dry FROM connected_accounts",
  );
  // Latest connection event per member and platform: tells the admin where someone got stuck.
  const attempts = await query<{ user_id: string; platform: string; action: string; reason: string | null; at: Date }>(
    `SELECT DISTINCT ON (user_id, detail->>'platform') user_id, detail->>'platform' AS platform, action, detail->>'reason' AS reason, at
       FROM audit_log
      WHERE user_id IS NOT NULL AND action IN ('account.connect_started', 'account.connect_failed', 'account.connected')
      ORDER BY user_id, detail->>'platform', at DESC`,
  );
  const googleTesting = connectedRows.some((r) => r.testing === "true");
  const logins = await query<{ email: string; at: Date }>(
    "SELECT detail->>'email' AS email, MAX(at) AS at FROM audit_log WHERE action = 'login' GROUP BY 1",
  );

  const byEmail = new Map<string, Person>();
  const person = (email: string): Person => {
    const e = email.toLowerCase();
    if (!byEmail.has(e)) {
      byEmail.set(e, {
        email: e, name: null, kind: "no-access", requestedAt: null, decidedAt: null, joinedAt: null, lastLogin: null,
        accounts: 0, waiting: 0, hasRow: false, connected: [], igUsername: null, problems: [],
      });
    }
    return byEmail.get(e)!;
  };
  for (const e of env.allowedEmails) person(e).kind = "starting-list";
  for (const r of rows) {
    const p = person(r.email);
    p.kind = r.status;
    p.name = r.name;
    p.requestedAt = r.requested_at;
    p.decidedAt = r.decided_at;
    p.hasRow = true;
  }
  for (const e of env.adminEmails) person(e).kind = "admin";
  for (const u of users) {
    const p = person(u.email);
    p.name = u.name ?? p.name;
    p.joinedAt = u.created_at;
    p.accounts = u.accounts;
    p.waiting = u.waiting;
    p.igUsername = u.ig;
    p.connected = connectedRows.filter((r) => r.user_id === u.id && r.dry !== "true").map((r) => ({ platform: r.platform, name: r.name, status: r.status }));
    for (const a of attempts.filter((a) => a.user_id === u.id)) {
      const label = a.platform === "youtube" ? "YouTube" : "Instagram";
      if (a.action === "account.connect_failed") p.problems.push({ platform: a.platform, text: `${label} failed ${fmtWhen(a.at, tz)}: ${a.reason}` });
      else if (a.action === "account.connect_started" && Date.now() - new Date(a.at).getTime() > 5 * 60_000) {
        p.problems.push({
          platform: a.platform,
          text:
            a.platform === "youtube"
              ? `Started connecting YouTube ${fmtWhen(a.at, tz)} but never came back: Google probably blocked them ("Access blocked" means the app is still in Testing mode).`
              : `Started connecting Instagram ${fmtWhen(a.at, tz)} but never came back: Instagram probably refused them (not an accepted Instagram Tester yet).`,
        });
      }
    }
  }
  for (const l of logins) if (l.email && byEmail.has(l.email.toLowerCase())) person(l.email).lastLogin = l.at;

  const all = [...byEmail.values()];
  const pending = all.filter((p) => p.kind === "pending").sort((a, b) => +new Date(b.requestedAt!) - +new Date(a.requestedAt!));
  const members = all.filter((p) => ["admin", "approved", "starting-list"].includes(p.kind)).sort((a, b) => (a.kind === "admin" ? -1 : b.kind === "admin" ? 1 : a.email.localeCompare(b.email)));
  const noAccess = all.filter((p) => p.kind === "blocked" || p.kind === "no-access");

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Admin</h1>
          <p>Only people you approve can sign in. New people who sign in with Google appear under &quot;Waiting for approval&quot;.</p>
        </div>
      </header>

      <section className="kpis" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <div className="card kpi">
          <div className="kpi-top"><span className={`kpi-icon ${pending.length ? "amber" : ""}`}><Icon name="clock" /></span></div>
          <div className="num">{pending.length}</div>
          <div className="lbl">Waiting for approval</div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-icon green"><Icon name="check" /></span></div>
          <div className="num">{members.length}</div>
          <div className="lbl">People with access</div>
        </div>
        <div className="card kpi">
          <div className="kpi-top"><span className="kpi-icon red"><Icon name="shield" /></span></div>
          <div className="num">{noAccess.length}</div>
          <div className="lbl">Denied or removed</div>
        </div>
      </section>

      <div className="dash-grid">
        <div className="col">
          <section className="card">
            <div className="card-title"><h3><Icon name="clock" size={18} /> Waiting for approval</h3></div>
            {!pending.length ? (
              <div className="empty" style={{ padding: 16 }}>
                <b>No requests</b>
                When someone new signs in with Google, they show up here and you get an email.
              </div>
            ) : (
              <div className="list">
                {pending.map((p) => (
                  <PersonRow key={p.email} p={p} tz={tz} sub={`Asked ${fmtWhen(p.requestedAt, tz)}`}>
                    <AccessButtons email={p.email} actions={["approve", "block"]} />
                  </PersonRow>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-title"><h3><Icon name="check" size={18} /> People with access</h3></div>
            <div className="list">
              {members.map((p) => (
                <PersonRow
                  key={p.email}
                  p={p}
                  tz={tz}
                  sub={
                    p.joinedAt
                      ? `${p.accounts} account${p.accounts === 1 ? "" : "s"} · ${p.waiting} waiting post${p.waiting === 1 ? "" : "s"} · last sign-in ${fmtWhen(p.lastLogin, tz)}`
                      : "Hasn't signed in yet"
                  }
                  badge={p.kind === "admin" ? "Admin" : p.kind === "starting-list" ? "From ALLOWED_EMAILS" : "Member"}
                  extra={<Connections p={p} />}
                >
                  {p.kind !== "admin" && <AccessButtons email={p.email} actions={["block"]} />}
                </PersonRow>
              ))}
            </div>
          </section>
        </div>

        <div className="col">
          <section className="card">
            <div className="card-title"><h3><Icon name="sparkles" size={18} /> So everyone can connect</h3></div>
            <div className="list">
              <Check
                ok={!googleTesting}
                title="Google: login screen published"
                text={
                  googleTesting ? (
                    <>A YouTube connection came back in <b>Testing</b> mode: only listed test users can connect, and logins expire after 7 days.</>
                  ) : (
                    <>Must be <b>In production</b> so any Google account can connect YouTube.</>
                  )
                }
                href="https://console.cloud.google.com/auth/audience"
                link="Google Cloud → Audience → Publish app"
              />
              <Check
                ok={features.instagram}
                title="Instagram: Meta app set up"
                text={features.instagram ? "INSTAGRAM_APP_ID and secret are set." : "INSTAGRAM_APP_ID is empty, so nobody can connect Instagram yet (SETUP.md step 4)."}
                href="https://developers.facebook.com/apps/"
                link="Meta for Developers"
              />
              {members
                .filter((m) => m.igUsername && !m.connected.some((c) => c.platform === "instagram"))
                .map((m) => (
                  <Check
                    key={m.email}
                    ok={false}
                    title={`Add @${m.igUsername} as an Instagram Tester`}
                    text={<>For {m.name || m.email}: Meta app → App roles → Roles → Add people → Instagram Tester. They then accept it in Instagram.</>}
                    href="https://developers.facebook.com/apps/"
                    link="Open Meta app"
                  />
                ))}
              <Check
                ok={features.seoEngine === "gemini"}
                title="Gemini: titles and suggestions"
                text={
                  features.seoEngine === "gemini"
                    ? `Using ${env.geminiModel}.`
                    : "GEMINI_API_KEY isn't set: titles use the built-in writer and there are no AI suggestions."
                }
                href="https://aistudio.google.com/apikey"
                link="Get a free key"
              />
            </div>
          </section>

          <section className="card">
            <div className="card-title"><h3><Icon name="plus" size={18} /> Give someone access</h3></div>
            <p className="small muted" style={{ marginTop: 0 }}>
              Enter the Google email they&apos;ll sign in with. They can sign in right away and get an email saying so.
            </p>
            <AddMember />
          </section>

          <section className="card">
            <div className="card-title"><h3><Icon name="shield" size={18} /> Denied or removed</h3></div>
            {!noAccess.length ? (
              <div className="small muted">Nobody.</div>
            ) : (
              <div className="list">
                {noAccess.map((p) => (
                  <PersonRow key={p.email} p={p} tz={tz} sub={p.decidedAt ? `Since ${fmtWhen(p.decidedAt, tz)}` : "Not on the list"}>
                    <AccessButtons email={p.email} actions={p.hasRow ? ["approve", "delete"] : ["approve"]} />
                  </PersonRow>
                ))}
              </div>
            )}
          </section>

          <section className="card small muted">
            <b style={{ color: "var(--text)" }}>How access works</b>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              <li>Admins ({env.adminEmails.join(", ") || "set ADMIN_EMAIL"}) always have access.</li>
              <li>Removing access signs the person out on their next click. Their scheduled posts keep going; remove them on the Schedule page if needed.</li>
              <li>Emails in ALLOWED_EMAILS are the starting list; you can still remove them here.</li>
            </ul>
          </section>
        </div>
      </div>
    </main>
  );
}

function Check({ ok, title, text, href, link }: { ok: boolean; title: string; text: React.ReactNode; href: string; link: string }) {
  return (
    <div className="list-item" style={{ alignItems: "flex-start" }}>
      <span className={`kpi-icon ${ok ? "green" : "amber"}`} style={{ width: 30, height: 30, borderRadius: 9, flex: "none" }}>
        <Icon name={ok ? "check" : "alert"} size={15} />
      </span>
      <div className="li-main">
        <b style={{ fontSize: ".88rem" }}>{title}</b>
        <div className="small muted">{text}</div>
        {!ok && (
          <a className="small" href={href} target="_blank" rel="noreferrer">
            {link} <Icon name="external" size={11} />
          </a>
        )}
      </div>
    </div>
  );
}

function Connections({ p }: { p: Person }) {
  if (!p.joinedAt) return null;
  return (
    <div className="small" style={{ marginTop: 6, display: "grid", gap: 4 }}>
      <div className="row" style={{ gap: 6 }}>
        {(["youtube", "instagram"] as const).map((platform) => {
          const acc = p.connected.filter((c) => c.platform === platform);
          return (
            <span key={platform} className="chip" style={{ opacity: acc.length ? 1 : 0.6 }}>
              <PlatformIcon platform={platform} size={13} />
              {acc.length ? acc.map((a) => a.name + (a.status === "ok" ? "" : " (reconnect)")).join(", ") : "not connected"}
            </span>
          );
        })}
        {p.igUsername && <span className="chip">IG username: @{p.igUsername}</span>}
      </div>
      {p.problems
        .filter((x) => !p.connected.some((c) => c.platform === x.platform && c.status === "ok"))
        .map((x) => (
          <div key={x.platform} style={{ color: "var(--warn)", whiteSpace: "normal" }}>
            <Icon name="alert" size={12} /> {x.text}
          </div>
        ))}
    </div>
  );
}

function PersonRow({ p, sub, badge, extra, children }: { p: Person; tz: string; sub: string; badge?: string; extra?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="list-item" style={{ flexWrap: "wrap" }}>
      <span className="avatar" aria-hidden="true">{(p.name || p.email).charAt(0).toUpperCase()}</span>
      {/* Wide enough that the buttons drop to their own line on phones instead of squeezing the name. */}
      <div className="li-main" style={{ flex: "1 1 220px" }}>
        <span className="li-title" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
          {p.name || p.email}
          {badge && <span className={`badge ${badge === "Admin" ? "queued" : "ok"}`} style={{ marginLeft: 8 }}>{badge}</span>}
        </span>
        <span className="li-sub" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{p.name ? `${p.email} · ` : ""}{sub}</span>
        {extra}
      </div>
      {children}
    </div>
  );
}
