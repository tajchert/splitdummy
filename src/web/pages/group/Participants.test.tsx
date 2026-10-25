import "../../test/storage";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ApiProvider } from "../../api/context";
import { createMockApi, type MockApi } from "../../api/mock";
import { ToastProvider } from "../../components/Toast";
import { AppRoutes } from "../../App";

let api: MockApi;
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/?latency=0");
  api = createMockApi();
});
afterEach(() => cleanup());

it("lists everyone in a collapsed People card while settling", async () => {
  const view = await api.getProject("p_lisbon");
  const roundId = view.current.round.id;
  const review = await api.getReview("p_lisbon", roundId);
  await api.freeze("p_lisbon", roundId, { expectedReviewVersion: review.reviewVersion, acknowledgeNotReady: review.notReadyMemberIds }, { idempotencyKey: "freeze-people" });

  render(
    <ApiProvider api={api}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/g/p_lisbon"]}>
          <AppRoutes />
        </MemoryRouter>
      </ToastProvider>
    </ApiProvider>,
  );
  const details = (await screen.findByText("People")).closest("details")!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("Maya you owner");
  expect(details.textContent).toContain("Kai");
  expect(details.textContent).toContain("Ana");
});
