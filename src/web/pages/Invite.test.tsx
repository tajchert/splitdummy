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

function mockAs(principal: string | null): MockApi {
  createMockApi();
  const s = JSON.parse(localStorage.getItem("splitdummy-mock-v3")!);
  s.me = principal;
  localStorage.setItem("splitdummy-mock-v3", JSON.stringify(s));
  return createMockApi();
}

describe("accept email invite", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
  });
  afterEach(() => cleanup());

  it("shows the spot name, accepts with Join and lands in the group", async () => {
    const api = mockAs(null);
    const accept = vi.spyOn(api, "acceptMemberInvite");
    renderAt(api, "/invite/p_porto.demo-member-invite-0001");
    const input = (await screen.findByLabelText("Your name")) as HTMLInputElement;
    expect(input.value).toBe("Nina");
    expect(screen.getByRole("heading", { name: "Porto weekend" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith({ token: "p_porto.demo-member-invite-0001", displayName: "Nina" }, expect.anything()));
    expect(await screen.findByText("Porto weekend")).toBeTruthy();
  });

  it("a signed-in browser still gets Join, with a note about switching accounts", async () => {
    renderAt(mockAs("pr_lea"), "/invite/p_porto.demo-member-invite-0001");
    expect(await screen.findByRole("button", { name: "Join" })).toBeTruthy();
    expect(screen.getByText(/You're signed in as .*Joining switches this browser to the invited email's account\./)).toBeTruthy();
    expect(screen.queryByText("You're already in")).toBeNull();
  });

  it("unknown links explain what happened", async () => {
    renderAt(mockAs(null), "/invite/p_porto.nope-nope-nope-nope");
    expect(await screen.findByText("This invitation isn't available")).toBeTruthy();
  });
});
