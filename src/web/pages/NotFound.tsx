import { Link } from "react-router";
import { useTitle } from "../components/Shell";
import { Logo } from "../components/ui";

export function NotFound({ title = "This page isn't available", body = "The link may be mistyped, or you may not be a member of this group." }: { title?: string; body?: string }) {
  useTitle("Not found");
  return (
    <div className="narrow-page">
      <header className="narrow-head narrow-head-center">
        <Link to="/" className="appbar-home" aria-label="Splitdummy home">
          <Logo size={18} />
        </Link>
      </header>
      <main id="main" className="narrow-main">
        <h1 className="page-h1">{title}</h1>
        <p className="muted lede">{body}</p>
        <Link to="/groups" className="btn btn-outline">
          Go to my groups
        </Link>
      </main>
    </div>
  );
}
