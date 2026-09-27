"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

export default function CancelVideoButton({ id, name, waiting }: { id: string; name: string; waiting: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function cancel() {
    const what = waiting ? `Cancel all ${waiting} waiting post${waiting === 1 ? "" : "s"} of "${name}"` : `Remove the stored clips of "${name}"`;
    if (!confirm(`${what}? Their clip files are deleted to free space. Posts already published stay online.`)) return;
    setBusy(true);
    try {
      await api(`/api/sources/${id}`, "DELETE");
      router.refresh();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="small danger" onClick={cancel} disabled={busy}>
      {busy ? "Cancelling…" : waiting ? "Cancel remaining posts" : "Free space"}
    </button>
  );
}
