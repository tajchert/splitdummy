import "../test/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApiProvider } from "../api/context";
import { createMockApi, type MockApi } from "../api/mock";
import { ToastProvider } from "../components/Toast";
import { AppRoutes } from "../App";

function renderAt(api: MockApi, path: string) {
  return render(
    <ApiProvider api={api}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ToastProvider>
    </ApiProvider>,
  );
}

describe("sign in page", () => {
  let api: MockApi;
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
    api = createMockApi();
    api.getConfig = async () => ({ turnstileSiteKey: "1x00000000000000000000AA", environment: "test" });
  });
  afterEach(() => cleanup());

  it("only offers My groups to a signed-in account", async () => {
    renderAt(api, "/signin");
    await screen.findByRole("heading", { name: "You're already signed in" });
    expect(screen.getByRole("link", { name: "Go to my groups" }).getAttribute("href")).toBe("/groups");
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button", { name: /sign-in link/ })).toBeNull();
    expect(document.querySelector(".turnstile")).toBeNull();
  });

  it("keeps the email form for guests", async () => {
    api.getMe = async () => ({ principalId: "pr_g", kind: "GUEST", email: null, displayName: "Kai" });
    renderAt(api, "/signin");
    await screen.findByLabelText("Email");
    await waitFor(() => expect(document.querySelector(".turnstile")).not.toBeNull());
  });
});
