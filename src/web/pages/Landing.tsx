import { useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useSession } from "../api/context";
import { useTitle, UserChip } from "../components/Shell";
import { FinishTrack, Icon, Logo } from "../components/ui";

/** Accepts a full invitation URL (/join#token or /join/token), or the bare token. */
export function inviteTokenFrom(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/\/join(?:\/|#)([^/?#\s]+)/);
  if (m) return decodeURIComponent(m[1]!);
  if (/^[A-Za-z0-9_.-]{16,200}$/.test(s)) return s;
  return null;
}

function InviteBox({ compact }: { compact?: boolean }) {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = inviteTokenFrom(value);
    if (!t) {
      setError("That doesn't look like an invitation link. Paste the whole link you were sent.");
      return;
    }
    navigate({ pathname: "/join", hash: encodeURIComponent(t) });
  };
  return (
    <form className={compact ? "invite-inline" : "card invite-card"} onSubmit={submit} noValidate>
      {!compact && (
        <label htmlFor={id} className="field-label">
          Got an invitation link?
        </label>
      )}
      <div className="invite-row">
        {compact && <Icon name="link" size={20} className="muted" />}
        <input
          id={id}
          className={compact ? "invite-bare" : "input"}
          placeholder={compact ? "Paste a link or code" : "Paste link or code"}
          aria-label={compact ? "Invitation link or code" : undefined}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-err` : undefined}
          autoComplete="off"
        />
        <button type="submit" className="btn btn-ink invite-go" aria-label="Open invitation">
          <Icon name="arrow_forward" size={compact ? 18 : 20} />
        </button>
      </div>
      {error && (
        <span id={`${id}-err`} className="field-error">
          {error}
        </span>
      )}
    </form>
  );
}

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
          <div className="landing-invite-m">
            <InviteBox />
          </div>
          <div className="landing-invite-d">
            <InviteBox compact />
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
      </footer>
    </div>
  );
}
