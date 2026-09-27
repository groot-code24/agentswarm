import { redirect } from "next/navigation";
import { configProblems, features } from "@/lib/env";
import { currentUser } from "@/lib/session";
import LoginForms from "@/components/LoginForms";
import Icon from "@/components/Icon";
import { Logo } from "@/components/Sidebar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; requested?: string }> }) {
  const problems = configProblems();
  if (!problems.length && (await currentUser().catch(() => null))) redirect("/");
  const { error, requested } = await searchParams;
  return (
    <div className="auth">
      <section className="auth-hero">
        <div className="brand"><Logo size={36} /> Clip Autopilot</div>
        <div>
          <h1>
            Turn long videos into <span className="grad-text">Shorts &amp; Reels</span> on autopilot.
          </h1>
          <p className="lead">Upload once. Clips are posted to YouTube and Instagram at the times your audience is watching.</p>
        </div>
        <div className="features">
          <div className="feature">
            <span className="kpi-icon"><Icon name="film" /></span>
            <div><b>Split in your browser</b><span>Fast clip cutting with nothing to install, and a live time estimate.</span></div>
          </div>
          <div className="feature">
            <span className="kpi-icon blue"><Icon name="clock" /></span>
            <div><b>Posts at the best times</b><span>At least 2 a day, learned from your own audience.</span></div>
          </div>
          <div className="feature">
            <span className="kpi-icon green"><Icon name="sparkles" /></span>
            <div><b>Suggestions that grow views</b><span>Only applied when you approve, and always undoable.</span></div>
          </div>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <h2>Welcome back</h2>
          <p className="muted" style={{ margin: "0 0 20px" }}>Private tool. Sign in with Google; new people need the admin&apos;s approval first.</p>
          <div className="stack">
            {problems.length > 0 && (
              <div className="notice error">
                <Icon name="alert" size={18} />
                <div>
                  <b>Setup needed before anyone can sign in:</b>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {problems.map((p) => <li key={p}>{p}</li>)}
                  </ul>
                </div>
              </div>
            )}
            {requested && (
              <div className="notice ok">
                <Icon name="clock" size={18} />
                <div>
                  <b>Request sent.</b> The admin needs to approve <b>{requested}</b> before you can sign in. You&apos;ll get an email when
                  it&apos;s approved; then sign in with Google again.
                </div>
              </div>
            )}
            {error && (
              <div className="notice error">
                <Icon name="alert" size={18} />
                <div>{error}</div>
              </div>
            )}
            {!problems.length && (
              <div className="card">
                <LoginForms google={features.googleLogin} dev={features.devLogin} />
              </div>
            )}
          </div>
          <p className="fine"><Icon name="shield" size={12} /> Only people the admin has approved can sign in.</p>
        </div>
      </section>
    </div>
  );
}
