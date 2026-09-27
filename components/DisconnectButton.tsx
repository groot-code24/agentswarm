"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";

export default function DisconnectButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function disconnect() {
    if (!confirm(`Disconnect ${name}? Its upcoming posts are cancelled and its post history and stats are removed.`)) return;
    setBusy(true);
    try {
      await api(`/api/accounts/${id}`, "DELETE");
      router.refresh();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="small danger" onClick={disconnect} disabled={busy}>
      {busy ? "Disconnecting…" : "Disconnect"}
    </button>
  );
}
