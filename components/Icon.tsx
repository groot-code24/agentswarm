// Small inline icon set (stroke icons, 24×24), so the app needs no icon library.
const PATHS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  upload: "M12 16V4m0 0L7 9m5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3",
  calendar: "M8 3v3m8-3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm3 8h2m4 0h2m-8 4h2m4 0h2",
  chart: "M4 20V10m6 10V4m6 16v-7m4 7H3",
  bulb: "M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.3 7.3 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.3 7.3 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z",
  logout: "M15 17l5-5-5-5m5 5H9m3 9H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6 6 18",
  clock: "M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 8h4m-4 4h4m-4 4h4m8-8h4m-4 4h4m-4 4h4",
  send: "M22 2 11 13m11-11-7 20-4-9-9-4z",
  alert: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  check: "M20 6 9 17l-5-5",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  external: "M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  sparkles: "M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z",
  link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1m2 5a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  refresh: "M20 11a8 8 0 0 0-14.9-3M4 4v4h4m-4 5a8 8 0 0 0 14.9 3M20 20v-4h-4",
  shield: "M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z",
  bolt: "M13 2 3 14h9l-1 8 10-12h-9z",
} as const;

export type IconName = keyof typeof PATHS | "youtube" | "instagram";

export default function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  if (name === "youtube") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
        <rect x="1.5" y="4.5" width="21" height="15" rx="4.5" fill="#ff3b30" />
        <path d="M10 8.8v6.4l5.5-3.2z" fill="#fff" />
      </svg>
    );
  }
  if (name === "instagram") {
    // Gradient comes from CSS (.ig-icon): SVG gradient ids clash when the icon appears many times.
    return (
      <span className={`ig-icon ${className ?? ""}`} style={{ width: size, height: size }} aria-hidden="true">
        <svg width={size * 0.72} height={size * 0.72} viewBox="0 0 24 24">
          <rect x="3" y="3" width="18" height="18" rx="5.5" fill="none" stroke="#fff" strokeWidth="2.2" />
          <circle cx="12" cy="12" r="4.2" fill="none" stroke="#fff" strokeWidth="2.2" />
          <circle cx="17.2" cy="6.8" r="1.3" fill="#fff" />
        </svg>
      </span>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function PlatformIcon({ platform, size = 18 }: { platform: string; size?: number }) {
  return <Icon name={platform === "youtube" ? "youtube" : "instagram"} size={size} />;
}
