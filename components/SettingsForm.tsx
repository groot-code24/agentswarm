"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

export default function SettingsForm({ timezone, lowStockDays }: { timezone: string; lowStockDays: number }) {
  const router = useRouter();
  const [tz, setTz] = useState(timezone);
  const [days, setDays] = useState(lowStockDays);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Read from the browser after hydration (server and browser lists can differ).
  const [zones, setZones] = useState<string[]>([timezone]);
  const [browserTz, setBrowserTz] = useState("");
  useEffect(() => {
    if (typeof Intl.supportedValuesOf === "function") setZones(Intl.supportedValuesOf("timeZone"));
    setBrowserTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "");
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/settings", "POST", { timezone: tz, lowStockDays: days });
      setMsg({ ok: true, text: "Saved. New schedules use this timezone." });
      router.refresh();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="two-col">
      <label className="field">
        <span>Timezone (posting times are planned in this timezone)</span>
        <select value={tz} onChange={(e) => setTz(e.target.value)} style={{ width: "100%" }}>
          {!zones.includes(tz) && <option value={tz}>{tz}</option>}
          {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
        </select>
        {browserTz && browserTz !== tz && (
          <button type="button" className="small" style={{ marginTop: 6 }} onClick={() => setTz(browserTz)}>Use this device&apos;s timezone ({browserTz})</button>
        )}
      </label>
      <label className="field">
        <span>Warn me by email when this many days of clips are left</span>
        <input type="number" min={1} max={14} value={days} onChange={(e) => setDays(Number(e.target.value))} />
      </label>
      <div className="row">
        <button className="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        {msg && <span className="small" style={{ color: msg.ok ? "var(--ok)" : "var(--danger)" }}>{msg.text}</span>}
      </div>
    </div>
  );
}
