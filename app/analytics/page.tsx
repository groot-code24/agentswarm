import { query } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { bestTimes, listAccounts, ownPostViews } from "@/lib/accounts";
import { fmtNum, fmtWhen, platformLabel } from "@/lib/format";
import { formatHours, median } from "@/lib/planner";
import Icon, { PlatformIcon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics" };

type Perf = {
  id: string;
  platform: string;
  account_name: string;
  title: string;
  permalink: string | null;
  published_at: Date;
  format: string;
  clip_length: number;
  v1: number | null;
  v24: number | null;
  v72: number | null;
  v168: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  avg_watch_sec: number | null;
  duration: number;
};

export default async function AnalyticsPage() {
  const user = await requireUser();
  const tz = user.timezone;
  const accounts = await listAccounts(user.id);

  const perAccount = await Promise.all(
    accounts.map(async (a) => {
      const own = await ownPostViews(a.id);
      const best = await bestTimes(a, tz, 2);
      return { account: a, posts: own.length, median24: own.length ? median(own.map((p) => p.views)) : null, best };
    }),
  );

  const rows = await query<Perf>(
    `SELECT p.id, p.platform, a.name AS account_name, p.title, p.permalink, p.published_at, sv.format, sv.clip_length, c.duration,
            MAX(CASE WHEN m.hours_after = 1 THEN m.views END)::int AS v1,
            MAX(CASE WHEN m.hours_after = 24 THEN m.views END)::int AS v24,
            MAX(CASE WHEN m.hours_after = 72 THEN m.views END)::int AS v72,
            MAX(CASE WHEN m.hours_after = 168 THEN m.views END)::int AS v168,
            (ARRAY_AGG(m.likes ORDER BY m.hours_after DESC))[1]::int AS likes,
            (ARRAY_AGG(m.comments ORDER BY m.hours_after DESC))[1]::int AS comments,
            (ARRAY_AGG(m.shares ORDER BY m.hours_after DESC))[1]::int AS shares,
            (ARRAY_AGG(m.saves ORDER BY m.hours_after DESC))[1]::int AS saves,
            (ARRAY_AGG(m.avg_watch_sec ORDER BY m.hours_after DESC))[1] AS avg_watch_sec
       FROM posts p
       JOIN connected_accounts a ON a.id = p.account_id
       JOIN clips c ON c.id = p.clip_id
       JOIN source_videos sv ON sv.id = c.source_video_id
       LEFT JOIN metric_snapshots m ON m.post_id = p.id
      WHERE p.user_id = $1 AND p.status = 'published'
      GROUP BY p.id, a.name, sv.format, sv.clip_length, c.duration
      ORDER BY p.published_at DESC
      LIMIT 100`,
    [user.id],
  );

  const groups = (key: (r: Perf) => string) => {
    const m = new Map<string, number[]>();
    for (const r of rows) if (r.v24 != null) m.set(key(r), [...(m.get(key(r)) || []), r.v24]);
    return [...m].map(([k, v]) => ({ k, n: v.length, med: median(v) })).sort((a, b) => b.med - a.med);
  };
  const byFormat = groups((r) => `${platformLabel(r.platform)} · ${r.format === "vertical" ? "Vertical 9:16" : "Original shape"}`);
  const byLength = groups((r) => `${r.clip_length}s clips`);

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>Views are checked 1 hour, 24 hours, 3 days and 7 days after each post. Each account is compared only with itself.</p>
        </div>
      </header>

      {!accounts.length && (
        <div className="card empty">
          <div className="empty-icon"><Icon name="chart" size={22} /></div>
          <b>No accounts yet</b>
          <a href="/settings">Connect an account</a> to see analytics.
        </div>
      )}
      <div className="cards">
        {perAccount.map(({ account, posts, median24, best }) => {
          const max = Math.max(...best.scores);
          return (
            <div key={account.id} className={`card acct ${account.platform}`}>
              <div className="acct-head">
                <span className="acct-avatar"><PlatformIcon platform={account.platform} size={24} /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="acct-name">{account.name}</div>
                  <div className="acct-meta">{platformLabel(account.platform)}</div>
                </div>
              </div>
              <div className="two-col" style={{ gap: 10 }}>
                <div className="chip" style={{ justifyContent: "space-between", borderRadius: 12, padding: "8px 12px" }}>
                  <span className="muted">Posts measured</span><b>{posts}</b>
                </div>
                <div className="chip" style={{ justifyContent: "space-between", borderRadius: 12, padding: "8px 12px" }}>
                  <span className="muted">Typical views (24 h)</span><b>{fmtNum(median24)}</b>
                </div>
              </div>
              <div>
                <div className="small muted" style={{ marginBottom: 8 }}>
                  Best hours: <b style={{ color: "var(--text)" }}>{formatHours(best.hours)}</b> · based on {best.basis}
                </div>
                <div className="bars" aria-label="Score by hour of day">
                  {best.scores.map((s, h) => (
                    <div key={h} className={best.hours.includes(h) ? "pick" : ""} style={{ height: `${Math.max(3, (s / max) * 100)}%` }} title={`${h}:00`} />
                  ))}
                </div>
                <div className="bars-axis">{Array.from({ length: 24 }, (_, h) => <span key={h}>{h % 6 === 0 ? h : ""}</span>)}</div>
              </div>
            </div>
          );
        })}
      </div>

      {(byFormat.length > 0 || byLength.length > 0) && (
        <>
          <h2>What works best</h2>
          <div className="two-col">
            <CompareTable title="Format" rows={byFormat} />
            <CompareTable title="Clip length" rows={byLength} />
          </div>
        </>
      )}

      <h2>Every clip</h2>
      {!rows.length ? (
        <div className="card empty">
          <div className="empty-icon"><Icon name="send" size={22} /></div>
          <b>No published clips yet</b>
          Stats appear an hour after the first post goes out.
        </div>
      ) : (
        <div className="table-wrap stackable">
          <table>
            <thead>
              <tr>
                <th>Clip</th><th>Published</th><th>Where</th>
                <th className="num">1 h</th><th className="num">24 h</th><th className="num">3 d</th><th className="num">7 d</th>
                <th className="num">Likes</th><th className="num">Comments</th><th className="num">Shares</th><th className="num">Saves</th><th className="num">Avg watch</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="cell-main">
                    {r.permalink ? <a className="cell-title" href={r.permalink} target="_blank" rel="noreferrer">{r.title}</a> : <span className="cell-title">{r.title}</span>}
                  </td>
                  <td data-label="Published" style={{ whiteSpace: "nowrap" }}>{fmtWhen(r.published_at, tz)}</td>
                  <td data-label="Where"><span className="cell-where"><PlatformIcon platform={r.platform} size={18} /> {platformLabel(r.platform)}</span></td>
                  <td data-label="Views after 1 h" className="num">{fmtNum(r.v1)}</td>
                  <td data-label="24 h" className="num">{fmtNum(r.v24)}</td>
                  <td data-label="3 days" className="num">{fmtNum(r.v72)}</td>
                  <td data-label="7 days" className="num">{fmtNum(r.v168)}</td>
                  <td data-label="Likes" className="num">{fmtNum(r.likes)}</td>
                  <td data-label="Comments" className="num">{fmtNum(r.comments)}</td>
                  <td data-label="Shares" className="num">{fmtNum(r.shares)}</td>
                  <td data-label="Saves" className="num">{fmtNum(r.saves)}</td>
                  <td data-label="Avg watch" className="num">{r.avg_watch_sec != null ? `${r.avg_watch_sec.toFixed(1)}s / ${Math.round(r.duration)}s` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function CompareTable({ title, rows }: { title: string; rows: { k: string; n: number; med: number }[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>{title}</th><th className="num">Posts</th><th className="num">Typical views (24 h)</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k}><td>{r.k}</td><td className="num">{r.n}</td><td className="num">{fmtNum(r.med)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
