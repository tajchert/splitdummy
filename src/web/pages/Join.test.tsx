import "../test/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApiProvider } from "../api/context";
import { createMockApi, type MockApi } from "../api/mock";
import { ToastProvider } from "../components/Toast";
import { AppRoutes } from "../App";

const TOKEN = "p_porto.demo-invite-token-0001";
const MAYA = "pr_maya"; // verified account, not a member of Porto in the mock seed

function renderAt(api: MockApi, path: string | { pathname: string; search?: string; state?: unknown }) {
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

describe("join by link", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
  });
  afterEach(() => cleanup());

  it("a verified account sees one Join button and no guest option", async () => {
    const api = mockAs(MAYA);
    const join = vi.spyOn(api, "join");
    renderAt(api, `/join/${TOKEN}`);
    const button = await screen.findByRole("button", { name: "Join" });
    expect(screen.queryByText(/guest/i)).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(join).toHaveBeenCalledTimes(1));
  });

  it("signed out: asks for name and email and sends a sign-in link that returns to auto-join", async () => {
    const api = mockAs(null);
    const request = vi.spyOn(api, "requestSignIn");
    renderAt(api, `/join/${TOKEN}`);
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Maya" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "maya@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a link" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const body = request.mock.calls[0]![0];
    expect(body.next).toBe(`/join/${encodeURIComponent(TOKEN)}?name=Maya&auto=1`);
    expect(await screen.findByText("Check your inbox")).toBeTruthy();
  });

  it("returning from the magic link with auto=1 joins exactly once", async () => {
    const api = mockAs(MAYA);
    const join = vi.spyOn(api, "join");
    renderAt(api, { pathname: `/join/${encodeURIComponent(TOKEN)}`, search: "?name=Maya&auto=1", state: { justSignedIn: true } });
    await waitFor(() => expect(join).toHaveBeenCalledTimes(1));
    expect(join.mock.calls[0]![0]).toMatchObject({ displayName: "Maya" });
    await new Promise((r) => setTimeout(r, 50));
    expect(join).toHaveBeenCalledTimes(1);
  });

  it("a crafted auto=1 link without the magic-link hand-off does not join; it prefills the name and waits for a click", async () => {
    const api = mockAs(MAYA);
    const join = vi.spyOn(api, "join");
    renderAt(api, `/join/${encodeURIComponent(TOKEN)}?name=Mia&auto=1`);
    const button = await screen.findByRole("button", { name: "Join" });
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Mia");
    await new Promise((r) => setTimeout(r, 50));
    expect(join).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(join).toHaveBeenCalledTimes(1));
  });
});
