import { describe, expect, it } from "vitest";
import type { ProjectViewDTO } from "@shared/api";
import { nameOf } from "./project";

const view = {
  me: { memberId: "m_a" },
  members: [
    { id: "m_a", displayName: "Ann", isOwner: true },
    { id: "m_b", displayName: "Bob", isOwner: false },
  ],
} as unknown as ProjectViewDTO;

describe("nameOf", () => {
  it("tags you and the owner only when asked", () => {
    expect(nameOf(view, "m_a")).toBe("Ann");
    expect(nameOf(view, "m_a", { you: true })).toBe("Ann (you)");
    expect(nameOf(view, "m_a", { you: true, owner: true })).toBe("Ann (you, owner)");
    expect(nameOf(view, "m_a", { short: true, owner: true })).toBe("You");
    expect(nameOf(view, "m_b", { you: true, owner: true })).toBe("Bob");
    expect(nameOf({ ...view, me: { memberId: "m_b" } } as ProjectViewDTO, "m_a", { you: true, owner: true })).toBe("Ann (owner)");
  });
});
