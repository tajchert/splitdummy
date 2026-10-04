import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createHttpApi } from "./api/http";
import type { Api } from "./api/types";
import { App } from "./App";
import { applyStoredTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/pages.css";

applyStoredTheme();

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
