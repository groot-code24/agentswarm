"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DateTime } from "luxon";
import { api } from "./api";

type Props = { id: string; status: string; scheduledAt: string; tz: string; platform: string; title: string; caption: string };

export default function PostActions({ id, status, scheduledAt, tz, platform, title, caption }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<null | "time" | "text">(null);
  const [value, setValue] = useState(DateTime.fromISO(scheduledAt).setZone(tz).toFormat("yyyy-LL-dd'T'HH:mm"));
  const [newTitle, setNewTitle] = useState(title);
  const [newCaption, setNewCaption] = useState(caption);
  const captionLimit = platform === "instagram" ? 2200 : 5000;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      setEditing(null);
      router.refresh();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (editing === "time") {
    return (
      <span className="row">
        <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: "auto" }} />
        <button
          className="small primary"
          disabled={busy}
          onClick={() => run(() => api(`/api/posts/${id}`, "PATCH", { scheduledAt: DateTime.fromISO(value, { zone: tz }).toISO() }))}
        >
          Save
        </button>
        <button className="small" onClick={() => setEditing(null)}>Cancel</button>
      </span>
    );
  }

  if (editing === "text") {
    return (
      <div className="stack" style={{ minWidth: "min(420px, 80vw)", whiteSpace: "normal", textAlign: "left" }}>
        {platform === "youtube" && (
          <label className="field" style={{ margin: 0 }}>
            <span>Title ({newTitle.length}/100)</span>
            <input type="text" maxLength={100} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
          </label>
        )}
        <label className="field" style={{ margin: 0 }}>
          <span>
            {platform === "youtube" ? "Description" : "Caption"} ({newCaption.length}/{captionLimit})
          </span>
          <textarea rows={6} maxLength={captionLimit} value={newCaption} onChange={(e) => setNewCaption(e.target.value)} />
        </label>
        <span className="row">
          <button
            className="small primary"
            disabled={busy || !newTitle.trim()}
            onClick={() =>
              run(() =>
                api(`/api/posts/${id}`, "PATCH", {
                  // Instagram has no separate title; keep the first caption line as its label.
                  title: platform === "youtube" ? newTitle : newCaption.split("\n")[0].slice(0, 100) || newTitle,
                  caption: newCaption,
                }),
              )
            }
          >
            Save text
          </button>
          <button className="small" onClick={() => setEditing(null)}>Cancel</button>
        </span>
      </div>
    );
  }

  const canEdit = status === "queued" || status === "needs_attention";
  return (
    <span className="row">
      {canEdit && (
        <button className="small" disabled={busy} onClick={() => setEditing("text")}>Edit text</button>
      )}
      {status === "queued" && (
        <button className="small" disabled={busy} onClick={() => setEditing("time")}>Move</button>
      )}
      {status === "needs_attention" && (
        <button className="small primary" disabled={busy} onClick={() => run(() => api(`/api/posts/${id}`, "POST"))}>Retry</button>
      )}
      {canEdit && (
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
