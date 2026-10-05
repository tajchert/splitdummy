import { useEffect, useState } from "react";
import { installApp, useInstall } from "../lib/install";
import { Icon } from "./ui";

export function InstallApp() {
  const { prompt, installed } = useInstall();
  const [standalone, setStandalone] = useState(() =>
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true,
  );
  const [error, setError] = useState(false);
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  useEffect(() => {
    const media = window.matchMedia?.("(display-mode: standalone)");
    const changed = () => setStandalone(media?.matches === true);
    media?.addEventListener("change", changed);
    return () => media?.removeEventListener("change", changed);
  }, []);

  if (installed || standalone || (!ios && !prompt && !error)) return null;

  return (
    <section className="card card-tight install-app" aria-label="Install Splitdummy">
      {ios ? (
        <details>
          <summary className="small muted">Add to home screen</summary>
          <p className="small muted install-app-help">
            In Safari, open Share, then choose Add to Home Screen. If shown, keep Open as Web App enabled and tap Add.
          </p>
        </details>
      ) : (
        <>
          <p className="small muted">Keep Splitdummy on your home screen for easy access.</p>
          {prompt && (
            <button type="button" className="btn btn-ghost btn-sm align-start" onClick={() => {
              setError(false);
              void installApp().catch(() => setError(true));
            }}>
              <Icon name="download" size={16} />
              Install app
            </button>
          )}
          {error && <p className="tiny muted" role="status">Installation couldn't open. You can try your browser's install option instead.</p>}
        </>
      )}
    </section>
  );
}
