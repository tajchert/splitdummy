import { Link } from "react-router";
import { useSession } from "../api/context";
import { useTitle, UserChip } from "../components/Shell";
import { FinishTrack, Icon, Logo } from "../components/ui";

export function Landing() {
  useTitle("Split the costs. Know when you're done.");
  const { me } = useSession();
  const createTo = me ? "/groups/new" : "/signin?next=%2Fgroups%2Fnew";
  return (
    <div className="landing">
      <header className="landing-bar">
        <Logo size={20} />
        <nav className="landing-nav" aria-label="Account">
          {me ? (
            <>
              <Link to="/groups" className="link-strong">
                My groups
              </Link>
              <UserChip />
            </>
          ) : (
            <Link to="/signin" className="link-strong">
              Sign in
            </Link>
          )}
          <Link to={createTo} className="btn btn-primary btn-md landing-nav-cta">
            Create a group
          </Link>
        </nav>
      </header>

      <main id="main" className="landing-main">
        <section className="landing-hero">
          <h1 className="landing-h1">
            Split the costs. <span className="logo-accent">Know when you're done.</span>
          </h1>
          <p className="landing-lede landing-lede-m">
            Add the trip's expenses together. Once everyone has finished, you get a fixed list of who pays whom, and you can see when it's all settled.
          </p>
          <p className="landing-lede landing-lede-d">
            For trips, flats and events. Everyone adds what they paid and marks when they're finished. The owner freezes the list, everyone pays back, and the group ends{" "}
            <b>All settled</b>.
          </p>
          <div className="landing-ctas">
            <Link to={createTo} className="btn btn-primary btn-lg">
              Create a group
            </Link>
            {me ? (
              <Link to="/groups" className="btn btn-outline btn-lg">
                My groups
              </Link>
            ) : (
              <Link to="/signin" className="btn btn-outline btn-lg">
                <span className="landing-lede-m">Sign in with email</span>
                <span className="landing-lede-d">Sign in</span>
              </Link>
            )}
          </div>
          <div className="landing-steps">
            <div className="track track-landing" aria-hidden="true">
              <span className="track-seg" style={{ background: "var(--accent)" }} />
              <span className="track-seg" style={{ background: "var(--accent)", opacity: 0.55 }} />
              <span className="track-seg" style={{ background: "var(--accent)", opacity: 0.3 }} />
              <span className="track-flag" style={{ opacity: 1 }} />
            </div>
            <ol className="landing-step-list">
              <li>
                <Icon name="receipt_long" size={20} />
                Collect
              </li>
              <li>
                <Icon name="lock" size={20} />
                Freeze
              </li>
              <li>
                <Icon name="handshake" size={20} />
                Settle
              </li>
            </ol>
          </div>
        </section>

        <aside className="landing-demo" aria-label="Example: a group that is settling up">
          <div className="landing-demo-head">
            <b>Lisbon trip</b>
            <span className="pill pill-blue">
              <span className="pill-dot" aria-hidden="true" />
              Settling
            </span>
          </div>
          <FinishTrack progress={[1, 1, 0]} size="lg" decorative />
          {[
            { who: "Kai → Maya", amt: "152.40", st: "✓ Confirmed", cls: "pill-green" },
            { who: "Ana → Maya", amt: "180.12", st: "Sent", cls: "pill-blue" },
            { who: "Tom → Maya", amt: "62.65", st: "To send", cls: "pill-neutral" },
          ].map((t) => (
            <div key={t.who} className="landing-demo-row">
              <span className="landing-demo-who">{t.who}</span>
              <b className="amount">
                {t.amt} <span className="amount-code">EUR</span>
              </b>
              <span className={`pill pill-sm ${t.cls}`}>{t.st}</span>
            </div>
          ))}
          <p className="small muted">1 of 3 confirmed. The amounts are fixed once the list is frozen.</p>
        </aside>
      </main>

      <footer className="landing-foot">
        <span className="meta-item">
          <Icon name="language" size={16} />
          EN
        </span>
        <span>Splitdummy never moves money.</span>
        <span className="landing-foot-links">
          <Link to="/docs/api">API docs</Link>
          <Link to="/privacy">Privacy</Link>
          <a href="https://github.com/tajchert/splitdummy" rel="noopener">GitHub</a>
        </span>
      </footer>
    </div>
  );
}
