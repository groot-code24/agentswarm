import Link from "next/link";
import { query } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtNum, fmtWhen, STATUS_LABEL } from "@/lib/format";
import PostActions from "@/components/PostActions";
import CancelVideoButton from "@/components/CancelVideoButton";
import { queueBytes, queueCapBytes } from "@/lib/schedule";
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
  // Uploaded videos that still hold clips or waiting posts: storage use and a way to cancel a whole batch.
  const videos = await query<{ id: string; filename: string; title: string; waiting: number; next_at: Date | null; last_at: Date | null; bytes: number }>(
    `WITH s AS (
       SELECT sv.id, sv.filename, sv.title, sv.created_at,
              (SELECT COUNT(*)::int FROM posts p JOIN clips c ON c.id = p.clip_id
                WHERE c.source_video_id = sv.id AND p.status IN ('queued', 'needs_attention')) AS waiting,
              (SELECT MIN(p.scheduled_at) FROM posts p JOIN clips c ON c.id = p.clip_id WHERE c.source_video_id = sv.id AND p.status = 'queued') AS next_at,
              (SELECT MAX(p.scheduled_at) FROM posts p JOIN clips c ON c.id = p.clip_id WHERE c.source_video_id = sv.id AND p.status = 'queued') AS last_at,
              (SELECT COALESCE(SUM(c.bytes), 0)::float8 FROM clips c WHERE c.source_video_id = sv.id AND c.status IN ('uploading', 'ready', 'scheduled')) AS bytes
         FROM source_videos sv WHERE sv.user_id = $1)
     SELECT * FROM s WHERE waiting > 0 OR bytes > 0 ORDER BY next_at NULLS LAST, created_at DESC`,
    [user.id],
  );
  const used = await queueBytes(user.id);
  const cap = queueCapBytes();
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
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
      {videos.length > 0 && (
        <section className="card" style={{ marginBottom: 20 }}>
          <div className="card-title">
            <h3><Icon name="film" size={18} /> Videos in your queue</h3>
            <span className="small muted">Storage: <b style={{ color: used > cap ? "var(--danger)" : "var(--text)" }}>{mb(used)}</b> of {mb(cap)}</span>
          </div>
          <div className={`meter${used > cap * 0.85 ? " low" : ""}`} style={{ marginBottom: 12 }}>
            <div style={{ width: `${Math.min(100, (used / cap) * 100)}%` }} />
          </div>
          <div className="list">
            {videos.map((v) => (
              <div key={v.id} className="list-item" style={{ flexWrap: "wrap" }}>
                <span className="li-icon"><Icon name="film" size={18} /></span>
                <div className="li-main">
                  <span className="li-title">{v.title || v.filename}</span>
                  <span className="li-sub">
                    {v.waiting} waiting post{v.waiting === 1 ? "" : "s"} · {mb(v.bytes)}
                    {v.next_at && <> · {fmtWhen(v.next_at, user.timezone)} → {fmtWhen(v.last_at, user.timezone)}</>}
                  </span>
                </div>
                <CancelVideoButton id={v.id} name={v.title || v.filename} waiting={v.waiting} />
              </div>
            ))}
          </div>
        </section>
      )}
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
