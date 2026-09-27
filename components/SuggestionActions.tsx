"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

export default function SuggestionActions({ id, status, canApply }: { id: string; status: string; canApply: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function act(action: "apply" | "reject" | "undo") {
    setBusy(true);
    try {
      await api(`/api/suggestions/${id}`, "POST", { action });
      router.refresh();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (status === "applied") {
    return <button className="small" disabled={busy} onClick={() => act("undo")}>Undo</button>;
  }
  if (status !== "proposed") return null;
  return (
    <div className="row">
      {canApply && <button className="primary small" disabled={busy} onClick={() => act("apply")}>Approve and apply</button>}
      <button className="small" disabled={busy} onClick={() => act("reject")}>{canApply ? "No thanks" : "Got it"}</button>
    </div>
  );
}

export function RefreshSuggestions() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api("/api/suggestions/refresh", "POST");
          router.refresh();
        } catch (err) {
          alert((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Checking…" : "Check now"}
    </button>
  );
}
