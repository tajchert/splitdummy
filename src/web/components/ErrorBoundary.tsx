import { Component, type ReactNode } from "react";
import { Icon, Logo } from "./ui";

/** Last-resort screen so a render or chunk-load error never leaves a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="narrow-page">
        <header className="narrow-head narrow-head-center">
          <a href="/" className="appbar-home" aria-label="Splitdummy home">
            <Logo size={18} />
          </a>
        </header>
        <main id="main" className="narrow-main" role="alert">
          <span className="inbox-icon" aria-hidden="true">
            <Icon name="refresh" size={30} />
          </span>
          <h1 className="page-h1">This page didn't load</h1>
          <p className="muted lede">Splitdummy may have just been updated. Reload to get the latest version. Nothing you saved is lost.</p>
          <button type="button" className="btn btn-primary btn-block" onClick={() => window.location.reload()}>
            <Icon name="refresh" size={20} />
            Reload
          </button>
        </main>
      </div>
    );
  }
}
