import "../test/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("create group", () => {
  let api: MockApi;
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
    api = createMockApi();
    // Turnstile configured, as on staging/production.
    api.getConfig = async () => ({ turnstileSiteKey: "1x00000000000000000000AA", environment: "test" });
  });
  afterEach(() => cleanup());

  it("doesn't render Turnstile for a signed-in account and submits without a token", async () => {
    const create = vi.spyOn(api, "createProject");
    renderAt(api, "/groups/new");
    const name = await screen.findByLabelText("Group name");
    // Prefilled from the account name.
    expect((screen.getByLabelText("Your name in this group") as HTMLInputElement).value).toBe("Maya");
    await waitFor(() => expect(document.querySelector(".turnstile")).toBeNull());
    fireEvent.change(name, { target: { value: "Ski week" } });
    fireEvent.click(screen.getByRole("button", { name: "Create group" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect("turnstileToken" in create.mock.calls[0]![0]).toBe(false);
    expect(screen.queryByText("Complete the check above the button first.")).toBeNull();
  });

  it("keeps Turnstile for a guest with an email", async () => {
    api.getMe = async () => ({ principalId: "pr_ines", kind: "GUEST", email: "ines@example.com", displayName: "Ines" });
    renderAt(api, "/groups/new");
    await screen.findByLabelText("Group name");
    await waitFor(() => expect(document.querySelector(".turnstile")).not.toBeNull());
  });

  it("has a close button back to My groups", async () => {
    renderAt(api, "/groups/new");
    const close = await screen.findByRole("link", { name: "Close" });
    expect(close.getAttribute("href")).toBe("/groups");
  });
});
