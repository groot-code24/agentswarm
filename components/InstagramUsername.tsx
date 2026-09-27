"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

/** Member tells the admin their Instagram username (needed for the Instagram Tester invite). */
export default function InstagramUsername({ current }: { current: string }) {
  const router = useRouter();
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<{ username: string }>("/api/settings/instagram", "POST", { username: value });
      setValue(res.username);
      setMsg({ ok: true, text: "Saved. The admin can now send you the tester invite." });
      router.refresh();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} className="stack">
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input type="text" placeholder="your_instagram_username" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="submit" disabled={busy || !value.trim() || value.trim().replace(/^@/, "").toLowerCase() === current}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {msg && <div className="small" style={{ color: msg.ok ? "var(--ok)" : "var(--danger)" }}>{msg.text}</div>}
    </form>
  );
}
