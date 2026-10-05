import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createHttpApi } from "./api/http";
import type { Api } from "./api/types";
import { App } from "./App";
import { listenForInstall } from "./lib/install";
import { applyStoredTheme } from "./lib/theme";
import { reloadForNewBuild } from "./lib/lazyPage";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/pages.css";

applyStoredTheme();
listenForInstall();

// A stale tab after a deploy: Vite couldn't preload a chunk's dependencies. Reload once for the new build.
window.addEventListener("vite:preloadError", (e) => {
  if (reloadForNewBuild()) e.preventDefault();
});

async function chooseApi(): Promise<{ api: Api; devPanel?: ComponentType }> {
  // Statically false in normal builds, so the mock chunk is never emitted.
  if (import.meta.env.VITE_MOCK === "1") {
    const { createMockApi } = await import("./api/mock");
    const api = createMockApi();
    return { api, devPanel: api.DevPanel };
  }
  return { api: createHttpApi() };
}

void chooseApi().then(({ api, devPanel }) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App api={api} devPanel={devPanel} />
    </StrictMode>,
  );
});
