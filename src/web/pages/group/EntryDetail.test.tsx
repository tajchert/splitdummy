import "../../test/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("expense detail note and photos", () => {
  let api: MockApi;
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
    api = createMockApi();
  });
  afterEach(() => cleanup());

  it("shows the note as plain text and opens photos in a viewer", async () => {
    const view = await api.createProject({ name: "Ski", baseCurrency: "EUR", multiCurrencyEnabled: false, ownerDisplayName: "Maya" }, { idempotencyKey: crypto.randomUUID() });
    const pid = view.project.id;
    const photos = [
      await api.uploadAttachment(pid, new Blob(["a"], { type: "image/webp" }), { idempotencyKey: crypto.randomUUID() }),
      await api.uploadAttachment(pid, new Blob(["b"], { type: "image/webp" }), { idempotencyKey: crypto.randomUUID() }),
    ];
    await api.createEntry(pid, view.current.round.id, {
      type: "EXPENSE", description: "Lift passes", occurredAt: "2026-10-01", originalAmount: "9000", originalCurrency: "EUR",
      conversion: { method: "IDENTITY" }, payerMemberId: view.me.memberId, splitMode: "EQUAL", participants: [{ memberId: view.me.memberId }],
      note: "Line one\n<b>not bold</b>", attachmentIds: photos.map((p) => p.id),
    }, { idempotencyKey: crypto.randomUUID() });
    const entry = (await api.getProject(pid)).current.entries[0]!;

    renderAt(api, `/g/${pid}/e/${entry.id}`);
    const note = await screen.findByText(/Line one/);
    expect(note.textContent).toBe("Line one\n<b>not bold</b>");
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1 of 2" }));
    expect(screen.getByRole("dialog", { name: "Photo 1 of 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next photo" }));
    expect(screen.getByRole("dialog", { name: "Photo 2 of 2" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open full size" }).getAttribute("href")).toBe(api.attachmentUrl(pid, photos[1]!.id));
    fireEvent.click(screen.getByRole("button", { name: "Close photo" }));
    expect(screen.queryByRole("dialog", { name: /Photo \d of 2/ })).toBeNull();
  });
});
