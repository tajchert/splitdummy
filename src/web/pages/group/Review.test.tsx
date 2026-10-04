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

describe("review & freeze", () => {
  let api: MockApi;
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
    api = createMockApi();
  });
  afterEach(() => cleanup());

  it("needs the acknowledgement but not a reason when someone isn't finished", async () => {
    const freeze = vi.spyOn(api, "freeze");
    renderAt(api, "/g/p_lisbon/review");
    expect(await screen.findByLabelText("Reason (optional)")).toBeTruthy();
    const buttons = () => screen.getAllByRole("button", { name: "Freeze & start settling" }) as HTMLButtonElement[];
    expect(buttons().every((b) => b.disabled)).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /I'm freezing even though Kai, Ana aren't finished/ }));
    expect(buttons().every((b) => !b.disabled)).toBe(true);

    fireEvent.click(buttons()[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Everyone will see that you froze before Kai, Ana finished.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Freeze & start settling/ }));

    await waitFor(() => expect(freeze).toHaveBeenCalledTimes(1));
    const body = freeze.mock.calls[0]![2];
    expect([...body.acknowledgeNotReady!].sort()).toEqual(["m_ana", "m_kai"]);
    expect("earlyFreezeReason" in body).toBe(false);
    await waitFor(async () => expect((await api.getProject("p_lisbon")).current.round.status).toBe("SETTLING"));
  });

  it("sends the reason when one is given and quotes it in the confirmation", async () => {
    const freeze = vi.spyOn(api, "freeze");
    renderAt(api, "/g/p_lisbon/review");
    fireEvent.change(await screen.findByLabelText("Reason (optional)"), { target: { value: "  Kai said he's done  " } });
    fireEvent.click(screen.getByRole("checkbox", { name: /I'm freezing even though/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Freeze & start settling" })[0]!);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Kai, Ana will see your reason: “Kai said he's done”")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Freeze & start settling/ }));
    await waitFor(() => expect(freeze).toHaveBeenCalledTimes(1));
    expect(freeze.mock.calls[0]![2].earlyFreezeReason).toBe("Kai said he's done");
  });
});
