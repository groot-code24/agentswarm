import { query } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fmtWhen } from "@/lib/format";
import SuggestionActions, { RefreshSuggestions } from "@/components/SuggestionActions";
import type { SuggestionRow } from "@/lib/suggestions";
import Icon, { PlatformIcon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Suggestions" };

type Row = SuggestionRow & { account_name: string | null; platform: string | null; decided_at: Date | null };

export default async function SuggestionsPage() {
  const user = await requireUser();
  const rows = await query<Row>(
    `SELECT s.*, a.name AS account_name, a.platform FROM suggestions s LEFT JOIN connected_accounts a ON a.id = s.account_id
      WHERE s.user_id = $1 ORDER BY (s.status = 'proposed') DESC, s.created_at DESC LIMIT 100`,
    [user.id],
  );
  const open = rows.filter((r) => r.status === "proposed");
  const past = rows.filter((r) => r.status !== "proposed");

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Suggestions</h1>
          <p>Ideas to get more views, based on your own numbers. Nothing changes until you press Approve, and applied changes can be undone.</p>
        </div>
        <div className="page-actions"><RefreshSuggestions /></div>
      </header>

      {!open.length && (
        <div className="card empty">
          <div className="empty-icon"><Icon name="bulb" size={22} /></div>
          <b>No open suggestions</b>
          They appear once there&apos;s enough data (usually after 10–20 posts per account) and are checked daily.
        </div>
      )}
      <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 380px), 1fr))" }}>
        {open.map((s) => (
          <div key={s.id} className="card stack" style={{ display: "flex", flexDirection: "column" }}>
            <div className="spread" style={{ alignItems: "flex-start" }}>
              <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
                <span className={`kpi-icon${s.can_apply ? "" : " blue"}`} style={{ flex: "none" }}><Icon name={s.can_apply ? "sparkles" : "bulb"} size={20} /></span>
                <div>
                  <h3 style={{ margin: 0 }}>{s.title}</h3>
                  {s.account_name && s.platform && (
                    <span className="small muted cell-where" style={{ marginTop: 4 }}><PlatformIcon platform={s.platform} size={14} /> {s.account_name}</span>
                  )}
                </div>
              </div>
              <span className="badge proposed">{s.can_apply ? "Needs approval" : "Advice"}</span>
            </div>
            <div className="small" style={{ color: "var(--text-2)" }}><b style={{ color: "var(--text)" }}>What we saw:</b> {s.evidence}</div>
            <div className="small" style={{ color: "var(--text-2)" }}><b style={{ color: "var(--text)" }}>{s.can_apply ? "What will change:" : "What to try:"}</b> {s.change_summary}</div>
            <div style={{ marginTop: "auto", paddingTop: 14 }}><SuggestionActions id={s.id} status={s.status} canApply={s.can_apply} /></div>
          </div>
        ))}
      </div>

      {past.length > 0 && (
        <>
          <h2>History</h2>
          <div className="table-wrap stackable">
            <table>
              <thead><tr><th>Suggestion</th><th>Decision</th><th>When</th><th></th></tr></thead>
              <tbody>
                {past.map((s) => (
                  <tr key={s.id}>
                    <td className="cell-main"><span className="cell-title">{s.title}</span></td>
                    <td data-label="Decision"><span className={`badge ${s.status}`}>{s.status}</span></td>
                    <td data-label="When" className="small muted">{fmtWhen(s.decided_at ?? s.created_at, user.timezone)}</td>
                    <td><SuggestionActions id={s.id} status={s.status} canApply={s.can_apply} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
