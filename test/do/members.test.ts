import { describe, expect, it } from "vitest";
import { createGroup } from "./helpers";

describe("member contract defaults", () => {
  it("existing members are PERSONs without invites; renaming is allowed by default", async () => {
    const g = await createGroup({ members: 1 });
    const view = await g.owner.view();
    expect(view.project.membersCanRename).toBe(true);
    for (const m of view.members) {
      expect(m).toMatchObject({ kind: "PERSON", inviteState: null, inviteExpiresAt: null, invitedEmail: null });
    }
    const bobView = await g.members[0]!.view();
    expect("invitedEmail" in bobView.members[0]!).toBe(false);
  });
});
