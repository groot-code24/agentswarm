import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { env } from "@/lib/env";
import { queryOne } from "@/lib/db";
import { currentUser } from "@/lib/session";
import Sidebar from "@/components/Sidebar";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Clip Autopilot", template: "%s · Clip Autopilot" },
  description: "Split long videos into clips and post them to YouTube Shorts and Instagram Reels at the best times.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0a0c11",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser().catch(() => null);
  let openSuggestions = 0;
  let attention = 0;
  if (user) {
    const counts = await queryOne<{ s: number; a: number }>(
      `SELECT (SELECT COUNT(*)::int FROM suggestions WHERE user_id = $1 AND status = 'proposed') AS s,
              (SELECT COUNT(*)::int FROM posts WHERE user_id = $1 AND status = 'needs_attention') AS a`,
      [user.id],
    );
    openSuggestions = counts?.s ?? 0;
    attention = counts?.a ?? 0;
  }
  return (
    <html lang="en" className={inter.variable}>
      <body>
        {user ? (
          <div className="shell">
            <Sidebar name={user.name ?? ""} email={user.email} suggestions={openSuggestions} attention={attention} dryRun={env.dryRun} />
            <div className="content">{children}</div>
          </div>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
