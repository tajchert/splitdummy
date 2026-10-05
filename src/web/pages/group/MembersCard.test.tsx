import "../../test/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApiProvider } from "../../api/context";
import { createMockApi, type MockApi } from "../../api/mock";
import { ToastProvider } from "../../components/Toast";
import { AppRoutes } from "../../App";

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

/** Seed the demo, then act as `principal` (Lea owns Porto, which has the placeholders Kid and Nina). */
function mockAs(principal: string): MockApi {
  createMockApi();
  const s = JSON.parse(localStorage.getItem("splitdummy-mock-v3")!);
  s.me = principal;
  localStorage.setItem("splitdummy-mock-v3", JSON.stringify(s));
  return createMockApi();
}

describe("members card", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
  });
  afterEach(() => cleanup());

  it("shows placeholder and invited chips and adds a person with an email", async () => {
    const api = mockAs("pr_lea");
    const add = vi.spyOn(api, "addMember");
    renderAt(api, "/g/p_porto/settings");
    expect(await screen.findByText("Placeholder")).toBeTruthy();
    expect(screen.getByText(/^Invited · expires/)).toBeTruthy();
    expect(screen.getByText("nina@example.com")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Omar" } });
    fireEvent.change(within(dialog).getByLabelText(/Email/), { target: { value: "omar2@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add & send invite" }));
    await waitFor(() => expect(add).toHaveBeenCalledWith("p_porto", { displayName: "Omar", email: "omar2@example.com" }, expect.anything()));
  });

  it("manages a member: rename, resend, cancel", async () => {
    const api = mockAs("pr_lea");
    const rename = vi.spyOn(api, "renameMember");
    const cancel = vi.spyOn(api, "cancelMemberInvite");
    renderAt(api, "/g/p_porto/settings");
    fireEvent.click(await screen.findByRole("button", { name: "Manage Nina" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Nina K" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith("p_porto", "m_nina", { displayName: "Nina K" }, expect.anything()));
    // One mutation drives the sheet: wait for the rename (and its refresh) to finish before the next action.
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Cancel invite" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel invite" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("p_porto", "m_nina", expect.anything()));
  });

  it("locking self-renaming makes 'Your name' read-only for members", async () => {
    const owner = mockAs("pr_lea");
    renderAt(owner, "/g/p_porto/settings");
    fireEvent.click(await screen.findByRole("switch", { name: /Members can change their own name/ }));
    await waitFor(async () => expect((await owner.getProject("p_porto")).project.membersCanRename).toBe(false));
  });
});
