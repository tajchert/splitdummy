import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InstallApp } from "./InstallApp";
import { listenForInstall } from "../lib/install";

let stopListening: () => void;

beforeEach(() => {
  stopListening = listenForInstall();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList));
});
afterEach(() => {
  cleanup();
  act(() => { window.dispatchEvent(new Event("appinstalled")); });
  stopListening();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("stays hidden in browsers without an install prompt", () => {
  render(<InstallApp />);
  expect(screen.queryByRole("region", { name: "Install Splitdummy" })).toBeNull();
});

it("keeps an earlier install event until the account option is used, then consumes it", async () => {
  let prompts = 0;
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.assign(event, { prompt: async () => { prompts++; }, userChoice: Promise.resolve({ outcome: "dismissed" }) });
  act(() => { window.dispatchEvent(event); });
  render(<InstallApp />);
  expect(event.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Install app" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Install app" })).toBeNull());
  expect(prompts).toBe(1);
});

it("offers collapsed iPhone instructions and hides them after installation", () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone) AppleWebKit Safari/604.1");
  render(<InstallApp />);
  const summary = screen.getByText("Add to home screen");
  expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
  expect(screen.getByText(/Share/)).toBeTruthy();
  act(() => { window.dispatchEvent(new Event("appinstalled")); });
  expect(screen.queryByText("Add to home screen")).toBeNull();
});

it("stays hidden when launched as an installed app", () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone");
  vi.mocked(window.matchMedia).mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList);
  render(<InstallApp />);
  expect(screen.queryByText("Add to home screen")).toBeNull();
});

it("shows browser-menu guidance if the installation prompt cannot open", async () => {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  Object.assign(event, { prompt: async () => { throw new Error("Unavailable"); }, userChoice: Promise.resolve({ outcome: "dismissed" }) });
  act(() => { window.dispatchEvent(event); });
  render(<InstallApp />);
  fireEvent.click(screen.getByRole("button", { name: "Install app" }));
  expect(await screen.findByRole("status")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Install app" })).toBeNull();
});
