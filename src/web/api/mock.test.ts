import "../test/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { createMockApi } from "./mock";

const KEY = "splitdummy-mock-v3";
const NINA = "p_porto.demo-member-invite-0001";
let n = 0;
const o = () => ({ idempotencyKey: `k-mock-test-${++n}` });

function as(principal: string | null, edit?: (s: any) => void) {
  createMockApi();
  const s = JSON.parse(localStorage.getItem(KEY)!);
  s.me = principal;
  edit?.(s);
  localStorage.setItem(KEY, JSON.stringify(s));
  return createMockApi();
}

describe("mock member invites", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/?latency=0");
  });

  it("a claimed invite previews as CLAIMED (already a member for the claimer) and can't be accepted again", async () => {
    const api = as(null);
    await api.acceptMemberInvite({ token: NINA }, o());
    const p = await api.previewMemberInvite(NINA);
    expect(p.status).toBe("CLAIMED");
    expect(p.alreadyMemberProjectId).toBe("p_porto");
    await expect(api.acceptMemberInvite({ token: NINA }, o())).rejects.toMatchObject({ status: 409, code: "INVITE_INVALID", details: { status: "CLAIMED" } });
  });

  it("rejects an email another live placeholder invite already uses", async () => {
    const api = as("pr_lea");
    await expect(api.addMember("p_porto", { displayName: "Nina 2", email: "nina@example.com" }, o())).rejects.toMatchObject({ status: 422, field: "email" });
    await expect(api.inviteMember("p_porto", "m_kid", { email: "NINA@example.com" }, o())).rejects.toMatchObject({ status: 422, field: "email", message: "Someone in this group was already invited with this email." });
    await expect(api.inviteMember("p_porto", "m_nina", { email: "nina@example.com" }, o())).resolves.toMatchObject({ inviteState: "INVITED" });
  });

  it("logs on-behalf settlement under the placeholder's name, marked by the owner", async () => {
    const api = as("pr_lea", (s) => {
      const r = s.projects.p_porto.rounds.at(-1);
      r.round.status = "SETTLING";
      r.instructions = [{ id: "i_1", roundId: r.round.id, fromMemberId: "m_kid", toMemberId: "m_lea", amount: "100", currency: "EUR", exponent: 2, state: "PROPOSED", sentAt: null, confirmedAt: null, disputedAt: null, disputeNote: null, revision: 1 }];
    });
    const view = await api.getProject("p_porto");
    await api.markSent("p_porto", view.current.round.id, "i_1", { expectedRevision: 1 }, o());
    const h = await api.getHistory("p_porto");
    expect(JSON.stringify(h)).toContain("Kid sent Lea their repayment (marked by Lea)");
  });
});
