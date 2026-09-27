"use client";

import { useState } from "react";
import { api } from "./api";
import Icon from "./Icon";

type Check = { name: string; status: "ok" | "warn" | "fail"; detail: string };
const TONE = { ok: "green", warn: "amber", fail: "red" } as const;

// Tests the real services (Neon, R2, Google, Instagram, Resend, cron) with harmless requests.
export default function LiveChecks() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function runAll() {
    setBusy(true);
    setError("");
    try {
      setChecks((await api<{ checks: Check[] }>("/api/checks", "GET")).checks);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <button className="primary" onClick={runAll} disabled={busy}><Icon name="refresh" size={16} /> {busy ? "Checking…" : "Run live checks"}</button>
        <span className="small muted">Tests the real database, storage, Google, Instagram, email and scheduler. Nothing is posted.</span>
      </div>
      {error && <div className="notice error"><Icon name="alert" size={18} /><div>{error}</div></div>}
      {checks && (
        <div className="list">
          {checks.map((c) => (
            <div key={c.name} className="list-item" style={{ alignItems: "flex-start" }}>
              <span className={`kpi-icon ${TONE[c.status]}`} style={{ width: 32, height: 32, borderRadius: 10, flex: "none" }}>
                <Icon name={c.status === "ok" ? "check" : "alert"} size={16} />
              </span>
              <div className="li-main">
                <b style={{ fontSize: ".9rem" }}>{c.name}</b>
                <div className="small muted" style={{ overflowWrap: "anywhere" }}>{c.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
