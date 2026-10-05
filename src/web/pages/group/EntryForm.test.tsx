import "../../test/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApiProvider } from "../../api/context";
import { createMockApi, type MockApi } from "../../api/mock";
import { ToastProvider } from "../../components/Toast";
import { AppRoutes } from "../../App";
import { ApiError } from "../../api/errors";

// The test environment's object URLs reject these File objects; previews don't matter here.
URL.createObjectURL = () => "blob:test";
URL.revokeObjectURL = () => {};

vi.mock("../../lib/receiptImage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/receiptImage")>()),
  compressReceipt: vi.fn(async (f: Blob) => ({ blob: new Blob([f], { type: "image/webp" }), width: 10, height: 10 })),
}));

const photoInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;
/** Every tile finished compressing and uploading (Save is disabled until then). */
const uploadsSettled = () => waitFor(() => expect(screen.queryByText(/Preparing…|Uploading…/)).toBeNull());
const pick = (...names: string[]) =>
  fireEvent.change(photoInput(), { target: { files: names.map((n) => new File(["img"], n, { type: "image/jpeg" })) } });

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

async function newSingleCurrencyGroup(api: MockApi) {
  const view = await api.createProject(
    { name: "Ski week", baseCurrency: "EUR", multiCurrencyEnabled: false, ownerDisplayName: "Maya" },
    { idempotencyKey: crypto.randomUUID() },
  );
  return view;
}

describe("expense form", () => {
  let api: MockApi;
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
    api = createMockApi();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("saves a note and an uploaded photo with the expense", async () => {
    const view = await newSingleCurrencyGroup(api);
    renderAt(api, `/g/${view.project.id}/new`);
    fireEvent.change(await screen.findByLabelText("What was it?", { selector: "input" }), { target: { value: "Groceries" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), { target: { value: "42" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "Split the wine separately next time" } });
    pick("bill.jpg");
    await screen.findByRole("button", { name: "Remove photo 1" });
    await uploadsSettled();
    fireEvent.submit(document.getElementById("entry-form")!);
    await waitFor(async () => {
      const saved = (await api.getProject(view.project.id)).current.entries.find((e) => e.description === "Groceries");
      expect(saved).toMatchObject({ note: "Split the wine separately next time", attachments: [expect.objectContaining({ contentType: "image/webp" })] });
    });
  });

  it("blocks saving while an upload failed, and retries it", async () => {
    const view = await newSingleCurrencyGroup(api);
    const real = api.uploadAttachment.bind(api);
    const spy = vi.spyOn(api, "uploadAttachment").mockRejectedValueOnce(new Error("offline")).mockImplementation(real);
    renderAt(api, `/g/${view.project.id}/new`);
    fireEvent.change(await screen.findByLabelText("What was it?", { selector: "input" }), { target: { value: "Taxi" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), { target: { value: "15" } });
    pick("taxi.jpg");
    fireEvent.click(await screen.findByRole("button", { name: "Retry photo 1" }));
    await uploadsSettled();
    fireEvent.submit(document.getElementById("entry-form")!);
    await waitFor(async () => {
      expect((await api.getProject(view.project.id)).current.entries.find((e) => e.description === "Taxi")?.attachments).toHaveLength(1);
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps uploaded photo ids in the unsent draft", async () => {
    const view = await newSingleCurrencyGroup(api);
    renderAt(api, `/g/${view.project.id}/new`);
    fireEvent.change(await screen.findByLabelText("What was it?", { selector: "input" }), { target: { value: "Hotel" } });
    pick("hotel.jpg");
    await screen.findByRole("button", { name: "Remove photo 1" });
    await waitFor(() => {
      const draft = JSON.parse(localStorage.getItem(`splitdummy-draft:${view.project.id}:new-EXPENSE`) ?? "{}");
      expect(draft.attachmentIds).toHaveLength(1);
    });
  });

  it("drops the draft's photos when the restored draft is discarded", async () => {
    const view = await newSingleCurrencyGroup(api);
    renderAt(api, `/g/${view.project.id}/new`);
    fireEvent.change(await screen.findByLabelText("What was it?", { selector: "input" }), { target: { value: "Hotel" } });
    pick("hotel.jpg");
    await uploadsSettled();
    await waitFor(() => expect(JSON.parse(localStorage.getItem(`splitdummy-draft:${view.project.id}:new-EXPENSE`) ?? "{}").attachmentIds).toHaveLength(1));
    cleanup();

    renderAt(api, `/g/${view.project.id}/new`);
    await screen.findByRole("button", { name: "Remove photo 1" });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove photo 1" })).toBeNull());
  });

  it("marks the photo the server rejected", async () => {
    const view = await newSingleCurrencyGroup(api);
    vi.spyOn(api, "createEntry").mockRejectedValueOnce(
      new ApiError(422, "VALIDATION", "This photo isn't available. Remove it and add it again.", "attachmentIds.0"),
    );
    renderAt(api, `/g/${view.project.id}/new`);
    fireEvent.change(await screen.findByLabelText("What was it?", { selector: "input" }), { target: { value: "Fuel" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), { target: { value: "60" } });
    pick("fuel.jpg");
    await screen.findByRole("button", { name: "Remove photo 1" });
    await uploadsSettled();
    fireEvent.submit(document.getElementById("entry-form")!);
    expect(await screen.findAllByText("This photo isn't available. Remove it and add it again.")).not.toHaveLength(0);
  });

  it("tags placeholder members in the participant picker without changing the checkbox name", async () => {
    const st = JSON.parse(localStorage.getItem("splitdummy-mock-v3")!);
    st.me = "pr_lea";
    localStorage.setItem("splitdummy-mock-v3", JSON.stringify(st));
    renderAt(createMockApi(), "/g/p_porto/new");
    const box = await screen.findByRole("checkbox", { name: "Kid" });
    expect(box.parentElement?.querySelector(".chip-sm")?.textContent).toBe("placeholder");
  });

  it("shows a currency selector only when the group allows other currencies", async () => {
    renderAt(api, "/g/p_lisbon/new");
    expect(await screen.findByRole("combobox", { name: "Currency" })).toBeTruthy();
    cleanup();

    const view = await newSingleCurrencyGroup(api);
    renderAt(api, `/g/${view.project.id}/new`);
    await screen.findByText("New expense");
    expect(screen.queryByRole("combobox", { name: "Currency" })).toBeNull();
    expect(screen.getByLabelText("in EUR").textContent).toBe("EUR");
  });

  it("shows the conversion fields only for a foreign currency", async () => {
    renderAt(api, "/g/p_lisbon/new");
    const currency = await screen.findByRole("combobox", { name: "Currency" });
    expect(screen.queryByText(/This saved conversion will not change automatically/)).toBeNull();
    fireEvent.change(currency, { target: { value: "GBP" } });
    // The owner's saved GBP rate is prefilled, with who set it.
    expect(await screen.findByText(/This saved conversion will not change automatically/)).toBeTruthy();
    expect((screen.getByLabelText("1 GBP =") as HTMLInputElement).value).toBe("1.17");
    expect(screen.getByText(/Group rate saved by Maya/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), { target: { value: "100.00" } });
    expect(await screen.findByText("100.00 GBP → 117.00 EUR")).toBeTruthy();
  });

  it("validates inline and keeps what was typed", async () => {
    const view = await newSingleCurrencyGroup(api);
    renderAt(api, `/g/${view.project.id}/new`);
    const amount = (await screen.findByRole("textbox", { name: "Amount" })) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "12.345" } });
    fireEvent.submit(document.getElementById("entry-form")!);
    expect(await screen.findByText("Enter a description")).toBeTruthy();
    expect(screen.getByText("EUR has at most 2 decimal places")).toBeTruthy();
    expect(amount.value).toBe("12.345");
    expect(amount.getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps a labelled unsent draft when the round froze before saving", async () => {
    const view = await newSingleCurrencyGroup(api);
    const pid = view.project.id;
    const rid = view.current.round.id;
    renderAt(api, `/g/${pid}/new`);
    fireEvent.change(await screen.findByLabelText("What was it?", { selector: "input" }), { target: { value: "Lift passes" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Amount" }), { target: { value: "90" } });

    // Meanwhile the owner freezes from another device.
    const review = await api.getReview(pid, rid);
    await api.freeze(pid, rid, { expectedReviewVersion: review.reviewVersion, acknowledgeNotReady: review.notReadyMemberIds, earlyFreezeReason: "Done" }, { idempotencyKey: crypto.randomUUID() });

    fireEvent.submit(document.getElementById("entry-form")!);
    expect(await screen.findByText("Not saved")).toBeTruthy();
    expect((screen.getByLabelText("What was it?", { selector: "input" }) as HTMLInputElement).value).toBe("Lift passes");
    await waitFor(() => expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).some((k) => k.startsWith(`splitdummy-draft:${pid}`))).toBe(true));
  });
});
