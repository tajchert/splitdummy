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
  const s = JSON.parse(localStorage.getItem("splitdummy-mock-v2")!);
  s.me = principal;
  localStorage.setItem("splitdummy-mock-v2", JSON.stringify(s));
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
