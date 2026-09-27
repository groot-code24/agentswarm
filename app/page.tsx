import Link from "next/link";
import { DateTime } from "luxon";
import { query, queryOne } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { bestTimes, listAccounts } from "@/lib/accounts";
import { fmtNum, fmtWhen, platformLabel, STATUS_LABEL } from "@/lib/format";
import Icon, { PlatformIcon } from "@/components/Icon";

export const dynamic = "force-dynamic";

type PostLine = { id: string; platform: string; account_name: string; title: string; scheduled_at: Date; published_at: Date | null; status: string; permalink: string | null; views: number | null };

export default async function Dashboard() {
  const user = await requireUser();
  const tz = user.timezone;
  const now = DateTime.now().setZone(tz);
  const accounts = await listAccounts(user.id);

  const perAccount = await Promise.all(
    accounts.map(async (a) => {
      const upcoming = await query<{ scheduled_at: Date }>(
        "SELECT scheduled_at FROM posts WHERE account_id = $1 AND status IN ('queued', 'uploading', 'processing') ORDER BY scheduled_at",
        [a.id],
      );
      const days = new Set(upcoming.map((p) => DateTime.fromJSDate(new Date(p.scheduled_at)).setZone(tz).toISODate())).size;
      const ppd = await queryOne<{ ppd: number | null }>(
        `SELECT sv.posts_per_day AS ppd FROM posts p JOIN clips c ON c.id = p.clip_id JOIN source_videos sv ON sv.id = c.source_video_id
          WHERE p.account_id = $1 AND sv.mode = 'automation' ORDER BY p.created_at DESC LIMIT 1`,
        [a.id],
      );
      const best = await bestTimes(a, tz, ppd?.ppd || 2);
      return { account: a, queued: upcoming.length, days, next: upcoming[0]?.scheduled_at ?? null, best };
    }),
  );

  const upcoming = await query<PostLine>(
    `SELECT p.id, p.platform, a.name AS account_name, p.title, p.scheduled_at, p.published_at, p.status, p.permalink, NULL::int AS views
       FROM posts p JOIN connected_accounts a ON a.id = p.account_id
      WHERE p.user_id = $1 AND p.status IN ('queued', 'uploading', 'processing', 'needs_attention')
      ORDER BY (p.status = 'needs_attention') DESC, p.scheduled_at LIMIT 6`,
    [user.id],
  );
  const recent = await query<PostLine>(
    `SELECT p.id, p.platform, a.name AS account_name, p.title, p.scheduled_at, p.published_at, p.status, p.permalink,
            (SELECT views::int FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY hours_after DESC LIMIT 1) AS views
       FROM posts p JOIN connected_accounts a ON a.id = p.account_id
      WHERE p.user_id = $1 AND p.status = 'published'
      ORDER BY p.published_at DESC LIMIT 6`,
    [user.id],
  );
  const week = await queryOne<{ posts: number; views: number | null }>(
    `SELECT COUNT(*)::int AS posts,
            SUM((SELECT views FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY hours_after DESC LIMIT 1))::int AS views
       FROM posts p WHERE p.user_id = $1 AND p.status = 'published' AND p.published_at >= now() - interval '7 days'`,
    [user.id],
  );

  // 14-day activity: the last 6 days + today (published) and the next 7 days (scheduled).
  const from = now.startOf("day").minus({ days: 6 });
  const to = now.startOf("day").plus({ days: 8 });
  const activityRows = await query<{ status: string; at: Date }>(
    `SELECT status, COALESCE(published_at, scheduled_at) AS at FROM posts
      WHERE user_id = $1 AND (
        (status = 'published' AND published_at >= $2) OR
        (status IN ('queued', 'uploading', 'processing') AND scheduled_at < $3))`,
    [user.id, from.toJSDate(), to.toJSDate()],
  );
  const activity = Array.from({ length: 14 }, (_, i) => {
    const day = from.plus({ days: i });
    return { day, key: day.toISODate(), published: 0, scheduled: 0 };
  });
  for (const r of activityRows) {
    const key = DateTime.fromJSDate(new Date(r.at)).setZone(tz).toISODate();
    const slot = activity.find((d) => d.key === key);
    if (slot) slot[r.status === "published" ? "published" : "scheduled"]++;
  }
  const actMax = Math.max(1, ...activity.map((d) => d.published + d.scheduled));
  const todayKey = now.toISODate();

  const reconnect = accounts.filter((a) => a.status === "needs_reconnect");
  const attention = upcoming.filter((p) => p.status === "needs_attention").length;
  const scheduled = perAccount.reduce((n, a) => n + a.queued, 0);
  const withQueue = perAccount.filter((a) => a.queued > 0);
  const daysLeft = withQueue.length ? Math.min(...withQueue.map((a) => a.days)) : 0;
  const low = !!accounts.length && daysLeft <= user.low_stock_days;
  const firstName = (user.name || user.email.split("@")[0]).split(" ")[0];
  const greeting = now.hour < 12 ? "Good morning" : now.hour < 17 ? "Good afternoon" : "Good evening";
  const nextPost = upcoming.find((p) => p.status !== "needs_attention");

  return (
    <main>
      <section className="hero">
        <div>
          <div className="eyebrow">{now.toFormat("cccc, d LLLL")}</div>
          <h1>
            {greeting}, <span className="grad-text">{firstName}</span>
          </h1>
          <p>
            {!accounts.length
              ? "Connect your YouTube and Instagram accounts to start posting clips automatically."
              : nextPost
                ? <>Next post goes out <b>{fmtWhen(nextPost.scheduled_at, tz).replace(/^(Today|Tomorrow)/, (c) => c.toLowerCase())}</b> on {platformLabel(nextPost.platform)}. {scheduled} post{scheduled === 1 ? "" : "s"} in the queue.</>
                : "Your queue is empty. Upload a video and we'll turn it into clips and schedule them at the best times."}
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn primary" href="/upload"><Icon name="upload" size={18} /> Upload video</Link>
          <Link className="btn" href="/schedule"><Icon name="calendar" size={18} /> Schedule</Link>
        </div>
      </section>

      <div className="stack" style={{ marginBottom: reconnect.length || attention ? 16 : 0 }}>
        {reconnect.map((a) => (
          <div key={a.id} className="notice error">
            <Icon name="alert" size={18} />
            <div>Posting to {platformLabel(a.platform)} <b>{a.name}</b> is paused because the connection stopped working. <Link href="/settings">Reconnect it</Link>.</div>
          </div>
        ))}
        {attention > 0 && (
          <div className="notice error">
            <Icon name="alert" size={18} />
            <div>{attention} post{attention === 1 ? " needs" : "s need"} your attention. <Link href="/schedule?filter=attention">Open the schedule</Link>.</div>
          </div>
        )}
      </div>

      {!accounts.length && (
        <section className="card stack" style={{ marginBottom: 16 }}>
          <div className="card-title"><h3><Icon name="sparkles" size={18} /> Get started in 3 steps</h3></div>
          <div className="steps">
            <div className="step"><b>Connect accounts</b>Link the YouTube channel and Instagram account you own.</div>
            <div className="step"><b>Upload a video</b>It&apos;s split into clips right in your browser, with nothing to install.</div>
            <div className="step"><b>Relax</b>Clips post at the best times, and you get an email when they run low.</div>
          </div>
          <div className="connect-grid">
            <a className="connect-card" href="/api/connect/youtube">
              <PlatformIcon platform="youtube" size={34} />
              <div className="cc-text"><b>Connect YouTube</b><span>Post clips as Shorts</span></div>
              <Icon name="arrow" size={18} />
            </a>
            <a className="connect-card" href="/api/connect/instagram">
              <PlatformIcon platform="instagram" size={34} />
              <div className="cc-text"><b>Connect Instagram</b><span>Post clips as Reels</span></div>
              <Icon name="arrow" size={18} />
            </a>
          </div>
          <div className="small muted">
            Google shows a &quot;hasn&apos;t verified this app&quot; notice the first time. That&apos;s expected for our private tool: choose{" "}
            <i>Advanced → Go to Clip Autopilot</i> and tick all boxes.
          </div>
        </section>
      )}

      <section className="kpis">
        <Kpi icon="send" tone="" value={fmtNum(week?.posts ?? 0)} label="Clips published" hint="last 7 days" />
        <Kpi icon="eye" tone="blue" value={fmtNum(week?.views ?? 0)} label="Views on those clips" hint="last 7 days" />
        <Kpi icon="calendar" tone="green" value={fmtNum(scheduled)} label="Posts scheduled" hint="in the queue" />
        <Kpi
          icon="clock"
          tone={low ? "red" : "amber"}
          value={String(daysLeft)}
          label={`Day${daysLeft === 1 ? "" : "s"} of clips left`}
          hint={low ? <Link href="/upload">Add more</Link> : "shortest account"}
        />
      </section>

      <div className="dash-grid">
        <div className="col">
          <section className="card">
            <div className="card-title">
              <h3><Icon name="chart" size={18} /> Posting activity</h3>
              <div className="legend">
                <span><i style={{ background: "var(--grad)" }} />Published</span>
                <span><i style={{ background: "rgba(139,123,255,.45)" }} />Scheduled</span>
              </div>
            </div>
            <div className="activity" role="img" aria-label="Posts per day for the last week and the next week">
              {activity.map((d) => {
                const total = d.published + d.scheduled;
                return (
                  <div key={d.key} className={`act-col${d.key === todayKey ? " today" : ""}`} title={`${d.day.toFormat("ccc d LLL")}: ${d.published} published, ${d.scheduled} scheduled`}>
                    <span className="act-val">{total || ""}</span>
                    <div className="act-track">
                      <div className="act-stack" style={{ height: total ? `${(total / actMax) * 100}%` : undefined }}>
                        {d.scheduled > 0 && <div className="act-bar future" style={{ flex: d.scheduled }} />}
                        {d.published > 0 && <div className="act-bar past" style={{ flex: d.published }} />}
                        {!total && <div className="act-bar" />}
                      </div>
                    </div>
                    <span className="act-lbl">{d.key === todayKey ? "Today" : d.day.toFormat("ccc").slice(0, 2)}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card">
            <div className="card-title">
              <h3><Icon name="clock" size={18} /> Next up</h3>
              <Link href="/schedule">View all <Icon name="arrow" size={14} /></Link>
            </div>
            {!upcoming.length ? (
              <Empty icon="calendar" title="Nothing scheduled" text={<><Link href="/upload">Upload a video</Link> to fill your queue.</>} />
            ) : (
              <div className="list">
                {upcoming.map((p) => (
                  <div key={p.id} className="list-item">
                    <span className="li-icon"><PlatformIcon platform={p.platform} size={20} /></span>
                    <div className="li-main">
                      <span className="li-title">{p.title}</span>
                      <span className="li-sub">{p.account_name}</span>
                    </div>
                    <div className="li-side">
                      <span className="li-time">{fmtWhen(p.scheduled_at, tz)}</span>
                      <span className={`badge ${p.status}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="col">
          {perAccount.length > 0 && (
            <section className="card">
              <div className="card-title">
                <h3><Icon name="link" size={18} /> Accounts</h3>
                <Link href="/settings">Manage <Icon name="arrow" size={14} /></Link>
              </div>
              <div className="stack">
                {perAccount.map(({ account, queued, days, next, best }) => {
                  const isLow = days <= user.low_stock_days;
                  return (
                    <div key={account.id} className={`card acct ${account.platform}`} style={{ boxShadow: "none", background: "var(--surface-2)" }}>
                      <div className="acct-head">
                        <span className="acct-avatar"><PlatformIcon platform={account.platform} size={24} /></span>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="acct-name">{account.name}</div>
                          <div className="acct-meta">{platformLabel(account.platform)}</div>
                        </div>
                        <span className={`badge ${account.status}`}>{account.status === "ok" ? "Connected" : "Reconnect"}</span>
                      </div>
                      <div>
                        <div className="spread small" style={{ marginBottom: 6 }}>
                          <span><b>{days}</b> <span className="muted">day{days === 1 ? "" : "s"} of clips left</span></span>
                          <span className="muted">{queued} post{queued === 1 ? "" : "s"}</span>
                        </div>
                        <div className={`meter${isLow ? " low" : ""}`}><div style={{ width: `${Math.min(100, (days / 14) * 100)}%` }} /></div>
                        <div className="small muted" style={{ marginTop: 6 }}>
                          {next ? <>Next: <span style={{ color: "var(--text-2)" }}>{fmtWhen(next, tz)}</span></> : <><Link href="/upload">Upload a video</Link> to schedule clips.</>}
                        </div>
                      </div>
                      <div>
                        <div className="small muted" style={{ marginBottom: 6 }}>Best times · {best.basis}</div>
                        <div className="chips">
                          {best.hours.map((h) => (
                            <span key={h} className="chip"><Icon name="bolt" size={12} />{String(h).padStart(2, "0")}:00</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-title">
              <h3><Icon name="send" size={18} /> Recently published</h3>
              <Link href="/analytics">Analytics <Icon name="arrow" size={14} /></Link>
            </div>
            {!recent.length ? (
              <Empty icon="send" title="Nothing published yet" text="Published clips and their views show up here." />
            ) : (
              <div className="list">
                {recent.map((p) => (
                  <div key={p.id} className="list-item">
                    <span className="li-icon"><PlatformIcon platform={p.platform} size={20} /></span>
                    <div className="li-main">
                      {p.permalink ? (
                        <a className="li-title" href={p.permalink} target="_blank" rel="noreferrer">{p.title}</a>
                      ) : (
                        <span className="li-title">{p.title}</span>
                      )}
                      <span className="li-sub">{fmtWhen(p.published_at, tz)}</span>
                    </div>
                    <div className="li-side">
                      <span className="views"><Icon name="eye" size={14} />{fmtNum(p.views)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function Kpi({ icon, tone, value, label, hint }: { icon: "send" | "eye" | "calendar" | "clock"; tone: string; value: string; label: string; hint: React.ReactNode }) {
  return (
    <div className="card kpi">
      <div className="kpi-top">
        <span className={`kpi-icon ${tone}`}><Icon name={icon} size={20} /></span>
        <span className="hint">{hint}</span>
      </div>
      <div className="num">{value}</div>
      <div className="lbl">{label}</div>
    </div>
  );
}

function Empty({ icon, title, text }: { icon: "calendar" | "send"; title: string; text: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} size={22} /></div>
      <b>{title}</b>
      {text}
    </div>
  );
}
