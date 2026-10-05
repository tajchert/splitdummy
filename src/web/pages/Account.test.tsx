import "../test/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApiProvider } from "../api/context";
import { ApiError } from "../api/errors";
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

/** Seed the demo, then act as `principal` (Lea owns only Porto and has no open transfers). */
function mockAs(principal: string): MockApi {
  createMockApi();
  const s = JSON.parse(localStorage.getItem("splitdummy-mock-v3")!);
  s.me = principal;
  localStorage.setItem("splitdummy-mock-v3", JSON.stringify(s));
  return createMockApi();
}

async function openDialog() {
  fireEvent.click(await screen.findByRole("button", { name: "Delete account…" }));
  return screen.findByRole("dialog");
}

describe("delete account", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
  });
  afterEach(() => cleanup());

  it("enables deletion only after typing DELETE, then signs out to the landing page", async () => {
    const api = mockAs("pr_lea");
    const del = vi.spyOn(api, "deleteAccount");
    renderAt(api, "/account");
    const dialog = await openDialog();
    expect(await within(dialog).findByText("Porto weekend")).toBeTruthy();
    expect(within(dialog).getByText("1 member")).toBeTruthy();
    const button = within(dialog).getByRole("button", { name: "Delete account" }) as HTMLButtonElement;
    const input = within(dialog).getByLabelText("Type DELETE to confirm");

    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "delete" } });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(del).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "DELETE" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del.mock.calls[0]![0]).toEqual({ confirm: "DELETE" });
    expect(await screen.findByText("Your account was deleted")).toBeTruthy();
    // Landed on the landing page.
    expect(await screen.findByText(/Joining a group from an invitation\?/)).toBeTruthy();
    expect(await api.getMe()).toBeNull();
  });

  it("is blocked while joined groups have unconfirmed transfers", async () => {
    const api = mockAs("pr_maya");
    renderAt(api, "/account");
    const dialog = await openDialog();
    expect(await within(dialog).findByText("You can't delete your account yet")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Kuwait offsite" }).getAttribute("href")).toBe("/g/p_kuwait");
    expect((within(dialog).getByLabelText("Type DELETE to confirm") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Delete account" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains a 409 ACCOUNT_HAS_OPEN_TRANSFERS from the server", async () => {
    const api = mockAs("pr_lea");
    api.deleteAccount = async () => {
      throw new ApiError(409, "ACCOUNT_HAS_OPEN_TRANSFERS", "Some of your transfers aren't confirmed yet.");
    };
    renderAt(api, "/account");
    const dialog = await openDialog();
    fireEvent.change(await within(dialog).findByLabelText("Type DELETE to confirm"), { target: { value: "DELETE" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete account" }));
    expect(await within(dialog).findByText("Some of your transfers aren't confirmed yet.")).toBeTruthy();
    expect(await api.getMe()).not.toBeNull();
  });
});

describe("API keys", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
  });
  afterEach(() => cleanup());

  it("creates a read-only key, shows its secret once and revokes it", async () => {
    const api = mockAs("pr_lea");
    renderAt(api, "/account");
    fireEvent.change(await screen.findByLabelText("Key name"), { target: { value: "My script" } });
    expect((screen.getByLabelText("Access") as HTMLSelectElement).value).toBe("READ");
    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    const secret = await screen.findByLabelText("New API key");
    expect((secret as HTMLInputElement).value).toMatch(/^sd_demo_/);
    fireEvent.click(screen.getByRole("button", { name: "Done, I saved it" }));
    expect(screen.queryByLabelText("New API key")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke My script" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke My script" })).toBeNull());
    expect(await api.listApiKeys()).toEqual([]);
  });

  it("makes the API documentation accessible without signing in", async () => {
    const api = createMockApi();
    await api.signOut({ idempotencyKey: crypto.randomUUID() });
    renderAt(api, "/docs/api");
    expect(await screen.findByRole("heading", { name: "API for scripts and AI tools" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "OpenAPI schema" }).getAttribute("href")).toBe("/api/openapi.json");
  });

  it("refreshes keys and clears the secret when a committed revoke loses its response", async () => {
    const api = mockAs("pr_lea");
    const revoke = api.revokeApiKey.bind(api);
    api.revokeApiKey = async (id) => {
      await revoke(id);
      throw new ApiError(0, "NETWORK", "Connection lost");
    };
    renderAt(api, "/account");
    fireEvent.change(await screen.findByLabelText("Key name"), { target: { value: "My script" } });
    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    expect(await screen.findByLabelText("New API key")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke My script" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revoke My script" })).toBeNull());
    expect(screen.queryByLabelText("New API key")).toBeNull();
  });
});
