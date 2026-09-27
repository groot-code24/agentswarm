"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Icon, { type IconName } from "./Icon";

type Props = {
  name: string;
  email: string;
  suggestions: number;
  attention: number;
  dryRun: boolean;
};

type Item = { href: string; label: string; icon: IconName; badge?: number; danger?: boolean };

// Desktop: full sidebar. Tablet: icon rail. Phone: top bar + slide-in drawer + bottom tab bar.
export default function Sidebar({ name, email, suggestions, attention, dryRun }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const sections: { title: string; items: Item[] }[] = [
    {
      title: "Overview",
      items: [
        { href: "/", label: "Dashboard", icon: "home" },
        { href: "/analytics", label: "Analytics", icon: "chart" },
      ],
    },
    {
      title: "Publish",
      items: [
        { href: "/upload", label: "Upload", icon: "upload" },
        { href: "/schedule", label: "Schedule", icon: "calendar", badge: attention, danger: true },
        { href: "/suggestions", label: "Suggestions", icon: "bulb", badge: suggestions },
      ],
    },
    { title: "Account", items: [{ href: "/settings", label: "Settings", icon: "settings" }] },
  ];
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const initial = (name || email).trim().charAt(0).toUpperCase();

  return (
    <>
      <header className="mobile-bar">
        <button className="icon-btn" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
          <Icon name="menu" />
        </button>
        <Link href="/" className="brand">
          <Logo />
          <span>Clip Autopilot</span>
        </Link>
        <Link href="/upload" className="icon-btn accent" aria-label="Upload a video">
          <Icon name="plus" />
        </Link>
      </header>

      <div className={`scrim${open ? " show" : ""}`} onClick={() => setOpen(false)} aria-hidden="true" />

      <aside className={`sidebar${open ? " open" : ""}`} aria-label="Main navigation">
        <div className="sb-head">
          <Link href="/" className="brand" title="Clip Autopilot">
            <Logo />
            <span className="sb-label">Clip Autopilot</span>
          </Link>
          <button className="icon-btn sb-close" onClick={() => setOpen(false)} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>

        <Link href="/upload" className="btn primary sb-cta" title="New upload">
          <Icon name="plus" size={18} />
          <span className="sb-label">New upload</span>
        </Link>

        <nav className="sb-nav">
          {sections.map((s) => (
            <div key={s.title} className="sb-group">
              <div className="sb-section">{s.title}</div>
              {s.items.map((it) => (
                <Link
                  key={it.href}
                  href={it.href}
                  className={`sb-link${isActive(it.href) ? " active" : ""}`}
                  aria-current={isActive(it.href) ? "page" : undefined}
                  title={it.label}
                >
                  <Icon name={it.icon} />
                  <span className="sb-label">{it.label}</span>
                  {!!it.badge && <span className={`sb-badge${it.danger ? " danger" : ""}`}>{it.badge}</span>}
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div className="sb-foot">
          {dryRun && (
            <div className="dry-card" title="Nothing is really posted. Set DRY_RUN=false to go live.">
              <Icon name="shield" size={16} />
              <span className="sb-label">Dry run: nothing is posted</span>
            </div>
          )}
          <div className="user-card">
            <span className="avatar" aria-hidden="true">{initial}</span>
            <div className="sb-label user-meta">
              <b>{name || email.split("@")[0]}</b>
              <span>{email}</span>
            </div>
            <form action="/api/auth/logout" method="post">
              <button className="icon-btn" type="submit" title="Log out" aria-label="Log out">
                <Icon name="logout" size={18} />
              </button>
            </form>
          </div>
        </div>
      </aside>

      <nav className="tabbar" aria-label="Quick navigation">
        <TabLink href="/" label="Home" icon="home" active={isActive("/")} />
        <TabLink href="/schedule" label="Schedule" icon="calendar" active={isActive("/schedule")} dot={attention > 0} />
        <Link href="/upload" className={`tab tab-main${isActive("/upload") ? " active" : ""}`} aria-label="Upload">
          <span className="tab-fab"><Icon name="plus" size={22} /></span>
        </Link>
        <TabLink href="/analytics" label="Analytics" icon="chart" active={isActive("/analytics")} />
        <button className="tab" onClick={() => setOpen(true)} aria-label="More">
          <span className="tab-icon">
            <Icon name="menu" />
            {suggestions > 0 && <i className="tab-dot" />}
          </span>
          <span>More</span>
        </button>
      </nav>
    </>
  );
}

function TabLink({ href, label, icon, active, dot }: { href: string; label: string; icon: IconName; active: boolean; dot?: boolean }) {
  return (
    <Link href={href} className={`tab${active ? " active" : ""}`}>
      <span className="tab-icon">
        <Icon name={icon} />
        {dot && <i className="tab-dot danger" />}
      </span>
      <span>{label}</span>
    </Link>
  );
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none">
        <path d="M4 7.5 20 4M4 7.5h16V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
        <path d="M10.5 11v5.5l4.5-2.75z" fill="#fff" />
      </svg>
    </span>
  );
}
