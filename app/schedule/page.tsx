import Link from "next/link";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtNum, fmtWhen, STATUS_LABEL } from "@/lib/format";
import PostActions from "@/components/PostActions";
import Icon, { PlatformIcon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Schedule" };

const FILTERS = {
  upcoming: { label: "Upcoming", where: "p.status IN ('queued', 'uploading', 'processing')", order: "p.scheduled_at ASC" },
  attention: { label: "Needs attention", where: "p.status = 'needs_attention'", order: "p.scheduled_at DESC" },
  published: { label: "Published", where: "p.status = 'published'", order: "p.published_at DESC" },
  all: { label: "All", where: "TRUE", order: "p.scheduled_at DESC" },
} as const;

type Row = {
  id: string;
  platform: string;
  account_name: string;
  title: string;
  status: string;
  scheduled_at: Date;
  published_at: Date | null;
  permalink: string | null;
  last_error: string | null;
  attempts: number;
  views: number | null;
};

export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const user = await requireUser();
  const { filter: raw } = await searchParams;
  const filter = (raw && raw in FILTERS ? raw : "upcoming") as keyof typeof FILTERS;
  const f = FILTERS[filter];
  const rows = await query<Row>(
    `SELECT p.id, p.platform, a.name AS account_name, p.title, p.status, p.scheduled_at, p.published_at, p.permalink, p.last_error, p.attempts,
            (SELECT views::int FROM metric_snapshots m WHERE m.post_id = p.id ORDER BY hours_after DESC LIMIT 1) AS views
       FROM posts p JOIN connected_accounts a ON a.id = p.account_id
      WHERE p.user_id = $1 AND ${f.where}
      ORDER BY ${f.order} LIMIT 300`,
    [user.id],
  );
  const counts = await query<{ k: string; n: number }>(
    `SELECT CASE WHEN status IN ('queued', 'uploading', 'processing') THEN 'upcoming' ELSE status END AS k, COUNT(*)::int AS n
       FROM posts WHERE user_id = $1 GROUP BY 1`,
    [user.id],
  );
  const count = (k: keyof typeof FILTERS) =>
    k === "all" ? counts.reduce((n, c) => n + c.n, 0) : counts.find((c) => c.k === (k === "attention" ? "needs_attention" : k))?.n ?? 0;

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Schedule</h1>
          <p>Every post, with times in {user.timezone.replace(/_/g, " ")}. Waiting posts can be moved or cancelled.</p>
        </div>
        <div className="page-actions">
          <Link className="btn primary" href="/upload"><Icon name="plus" size={18} /> Add clips</Link>
        </div>
      </header>
      <nav className="segmented" aria-label="Filter posts" style={{ marginBottom: 16 }}>
        {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((k) => (
          <Link key={k} href={`/schedule?filter=${k}`} className={k === filter ? "active" : ""} aria-current={k === filter ? "page" : undefined}>
            {FILTERS[k].label}
            <span className={`n${k === "attention" && count(k) > 0 ? " danger" : ""}`}>{count(k)}</span>
          </Link>
        ))}
      </nav>
      {!rows.length ? (
        <div className="card empty">
          <div className="empty-icon"><Icon name="calendar" size={22} /></div>
          <b>Nothing here</b>
          {filter === "upcoming" ? <Link href="/upload">Upload a video to schedule clips.</Link> : "No posts match this filter."}
        </div>
      ) : (
        <div className="table-wrap stackable">
          <table>
            <thead>
              <tr>
                <th>Clip</th>
                <th>{filter === "published" ? "Published" : "Scheduled"}</th>
                <th>Where</th>
                <th>Status</th>
                <th className="num">Views</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="cell-main">
                    {p.permalink ? (
                      <a className="cell-title" href={p.permalink} target="_blank" rel="noreferrer">{p.title} <Icon name="external" size={12} /></a>
                    ) : (
                      <span className="cell-title">{p.title}</span>
                    )}
                    {p.last_error && p.status !== "published" && (
                      <div className="small" style={{ color: p.status === "needs_attention" ? "var(--danger)" : "var(--warn)", marginTop: 4 }}>{p.last_error}</div>
                    )}
                  </td>
                  <td data-label={p.status === "published" ? "Published" : "Scheduled"} style={{ whiteSpace: "nowrap" }}>
                    {fmtWhen(p.status === "published" ? p.published_at : p.scheduled_at, user.timezone)}
                  </td>
                  <td data-label="Where">
                    <span className="cell-where"><PlatformIcon platform={p.platform} size={18} /> <span className="small">{p.account_name}</span></span>
                  </td>
                  <td data-label="Status">
                    <span className={`badge ${p.status}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
                    {p.attempts > 0 && p.status !== "published" && <div className="small muted">attempt {p.attempts}</div>}
                  </td>
                  <td data-label="Views" className="num">{fmtNum(p.views)}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <PostActions id={p.id} status={p.status} scheduledAt={new Date(p.scheduled_at).toISOString()} tz={user.timezone} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
