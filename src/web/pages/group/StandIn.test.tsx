import "../../test/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { InstructionDTO, MemberDTO, ProjectViewDTO } from "@shared/api";
import { ApiProvider } from "../../api/context";
import { createMockApi, type MockApi } from "../../api/mock";
import { ToastProvider } from "../../components/Toast";
import { AppRoutes } from "../../App";
import { Who } from "./parts";

const KEY = "splitdummy-mock-v3";
type MockState = { me: string | null; projects: Record<string, { project: { membersCanRename: boolean }; members: MemberDTO[]; principals: Record<string, string>; rounds: { round: { id: string; status: string; frozenAt: string | null }; instructions: InstructionDTO[] }[] }> };

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

/** Seed the demo, edit the stored state, then act as `principal`. */
function mockWith(principal: string, edit: (s: MockState) => void): MockApi {
  createMockApi();
  const s = JSON.parse(localStorage.getItem(KEY)!) as MockState;
  s.me = principal;
  edit(s);
  localStorage.setItem(KEY, JSON.stringify(s));
  return createMockApi();
}

const kai: MemberDTO = { id: "m_kai", displayName: "Kai", isOwner: false, isGuest: false, hasRecoverableAccount: true, joinedAt: "2026-10-01T12:00:00.000Z", status: "ACTIVE", referenced: true, accountDeleted: false, kind: "PERSON", inviteState: null, inviteExpiresAt: null };

/** Porto (owner Lea; placeholders Kid and Nina) with Kai added and the round settling on the given transfers. */
function settlingPorto(s: MockState, transfers: [string, string, InstructionDTO["state"]][]) {
  const po = s.projects.p_porto!;
  po.members.push(kai);
  po.principals.m_kai = "pr_kai";
  const r = po.rounds[po.rounds.length - 1]!;
  r.round.status = "SETTLING";
  r.round.frozenAt = "2026-10-04T10:00:00.000Z";
  r.instructions = transfers.map(([from, to, state], n) => ({
    id: `i_${n}`,
    roundId: r.round.id,
    fromMemberId: from,
    toMemberId: to,
    amount: "2500",
    currency: "EUR",
    exponent: 2,
    state,
    sentAt: state === "SENT" ? "2026-10-04T12:00:00.000Z" : null,
    confirmedAt: null,
    disputedAt: null,
    disputeNote: null,
    revision: state === "SENT" ? 2 : 1,
  }));
}

describe("owner stands in for placeholders", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
  });
  afterEach(() => cleanup());

  it("placeholder owes the owner: the owner marks it sent for them", async () => {
    const api = mockWith("pr_lea", (s) => settlingPorto(s, [["m_kid", "m_lea", "PROPOSED"]]));
    const sent = vi.spyOn(api, "markSent");
    renderAt(api, "/g/p_porto");
    const button = await screen.findByRole("button", { name: "Mark sent for Kid" });
    expect(screen.getByText(/Kid owes you/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Received/ })).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(sent).toHaveBeenCalledWith("p_porto", expect.any(String), "i_0", expect.anything(), expect.anything()));
  });

  it("owner paid a placeholder: the owner confirms receipt for them", async () => {
    const api = mockWith("pr_lea", (s) => settlingPorto(s, [["m_lea", "m_nina", "SENT"]]));
    const received = vi.spyOn(api, "markReceived");
    renderAt(api, "/g/p_porto");
    fireEvent.click(await screen.findByRole("button", { name: "Received (for Nina)" }));
    await waitFor(() => expect(received).toHaveBeenCalledWith("p_porto", expect.any(String), "i_0", expect.anything(), expect.anything()));
  });

  it("another member paid a placeholder: the owner confirms receipt for them; a placeholder paying a member is not the owner's task", async () => {
    const api = mockWith("pr_lea", (s) =>
      settlingPorto(s, [
        ["m_kai", "m_kid", "SENT"],
        ["m_nina", "m_kai", "SENT"],
      ]),
    );
    renderAt(api, "/g/p_porto");
    expect(await screen.findByRole("button", { name: "Received (for Kid)" })).toBeTruthy();
    expect(screen.getByText(/Did Kid get it\?/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Received (for Kai)" })).toBeNull();
    expect(screen.getAllByRole("region", { name: "Your task" })).toHaveLength(1);
  });
});

describe("Who", () => {
  afterEach(() => cleanup());
  it("tags placeholders and invited placeholders", () => {
    const base = { id: "", isOwner: false, isGuest: false, hasRecoverableAccount: false, joinedAt: "2026-10-01T00:00:00.000Z", status: "ACTIVE", referenced: false, accountDeleted: false, inviteExpiresAt: null } as const;
    const view = {
      me: { memberId: "m_lea", isOwner: true },
      members: [
        { ...base, id: "m_kid", displayName: "Kid", kind: "PLACEHOLDER", inviteState: null },
        { ...base, id: "m_nina", displayName: "Nina", kind: "PLACEHOLDER", inviteState: "INVITED" },
        { ...base, id: "m_kai", displayName: "Kai", kind: "PERSON", inviteState: null },
      ],
    } as unknown as ProjectViewDTO;
    render(
      <p>
        <span data-testid="kid"><Who view={view} id="m_kid" /></span>
        <span data-testid="nina"><Who view={view} id="m_nina" /></span>
        <span data-testid="kai"><Who view={view} id="m_kai" /></span>
      </p>,
    );
    expect(screen.getByTestId("kid").textContent).toBe("Kid placeholder");
    expect(screen.getByTestId("nina").textContent).toBe("Nina invited");
    expect(screen.getByTestId("kai").textContent).toBe("Kai");
  });
});

describe("rename lock", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
  });
  afterEach(() => cleanup());

  it("a member sees their name read-only, without Save, when the owner locked renaming", async () => {
    const api = mockWith("pr_kai", (s) => {
      const po = s.projects.p_porto!;
      po.members.push({ ...kai, referenced: false });
      po.principals.m_kai = "pr_kai";
      po.project.membersCanRename = false;
    });
    renderAt(api, "/g/p_porto/settings");
    const form = (await screen.findByRole("heading", { name: "Your name in this group" })).closest("form")!;
    const input = within(form).getByLabelText("Name") as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe("Kai");
    expect(within(form).queryByRole("button", { name: "Save" })).toBeNull();
    expect(within(form).getByText("The owner manages names in this group.")).toBeTruthy();
  });
});
