"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import Icon from "./Icon";

type Action = "approve" | "block" | "delete";

async function change(email: string, action: Action) {
  await api("/api/admin/access", "POST", { email, action });
}

/** Buttons on one row of the Admin panel. */
export function AccessButtons({ email, actions }: { email: string; actions: Action[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const LABEL: Record<Action, string> = { approve: "Approve", block: "Remove access", delete: "Delete" };
  const CONFIRM: Partial<Record<Action, string>> = {
    block: `Remove access for ${email}? They're signed out immediately and can't sign in again until you approve them.`,
    delete: `Delete ${email} from the list? If they sign in again, you'll get a new request.`,
  };
  async function run(action: Action) {
    if (CONFIRM[action] && !confirm(CONFIRM[action])) return;
    setBusy(true);
    try {
      await change(email, action);
      router.refresh();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="row" style={{ flexWrap: "nowrap" }}>
      {actions.map((a) => (
        <button key={a} className={`small ${a === "approve" ? "primary" : a === "block" ? "danger" : ""}`} disabled={busy} onClick={() => run(a)}>
          {a === "approve" && <Icon name="check" size={14} />}
          {LABEL[a]}
        </button>
      ))}
    </span>
  );
}

/** "Give someone access" form: approves the email right away and emails them. */
export function AddMember() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await change(email, "approve");
      setMsg({ ok: true, text: `${email} can sign in now (they were emailed).` });
      setEmail("");
      router.refresh();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={add} className="stack">
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <input type="email" required placeholder="their-google-email@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="primary" type="submit" disabled={busy || !email}>
          <Icon name="plus" size={16} /> Give access
        </button>
      </div>
      {msg && <div className="small" style={{ color: msg.ok ? "var(--ok)" : "var(--danger)" }}>{msg.text}</div>}
    </form>
  );
}
