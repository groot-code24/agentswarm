"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DateTime } from "luxon";
import { api } from "./api";

export default function PostActions({ id, status, scheduledAt, tz }: { id: string; status: string; scheduledAt: string; tz: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(DateTime.fromISO(scheduledAt).setZone(tz).toFormat("yyyy-LL-dd'T'HH:mm"));

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      setEditing(false);
      router.refresh();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <span className="row">
        <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: "auto" }} />
        <button
          className="small primary"
          disabled={busy}
          onClick={() =>
            run(() => api(`/api/posts/${id}`, "PATCH", { scheduledAt: DateTime.fromISO(value, { zone: tz }).toISO() }))
          }
        >
          Save
        </button>
        <button className="small" onClick={() => setEditing(false)}>Cancel</button>
      </span>
    );
  }

  return (
    <span className="row">
      {status === "queued" && (
        <button className="small" disabled={busy} onClick={() => setEditing(true)}>Move</button>
      )}
      {status === "needs_attention" && (
        <button className="small primary" disabled={busy} onClick={() => run(() => api(`/api/posts/${id}`, "POST"))}>Retry</button>
      )}
      {(status === "queued" || status === "needs_attention") && (
        <button
          className="small danger"
          disabled={busy}
          onClick={() => confirm("Cancel this post? The clip won't be posted to this account.") && run(() => api(`/api/posts/${id}`, "DELETE"))}
        >
          Cancel post
        </button>
      )}
    </span>
  );
}
