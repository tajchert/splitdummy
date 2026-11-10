import "../test/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAllDrafts, findRejectedDraft, saveDraft } from "./drafts";
import { emptyDraft } from "./entryForm";
import type { ProjectViewDTO } from "@shared/api";

const draft = (rejected: boolean) => ({ ...emptyDraft("EXPENSE", { project: { baseCurrency: "EUR" }, me: { memberId: "m1" } } as unknown as ProjectViewDTO, "2026-03-01", ["m1"]), description: "Lift passes", rejected });
const keys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).sort();

describe("drafts", () => {
  beforeEach(() => localStorage.clear());

  it("finds a rejected draft even when another key of the project holds invalid JSON", () => {
    for (const corruptFirst of [true, false]) {
      localStorage.clear();
      if (corruptFirst) localStorage.setItem("splitdummy-draft:p1:edit-a", "{not json");
      saveDraft("p1", "new-EXPENSE", draft(true));
      if (!corruptFirst) localStorage.setItem("splitdummy-draft:p1:edit-a", "{not json");
      expect(findRejectedDraft("p1")).toMatchObject({ slot: "new-EXPENSE", draft: { description: "Lift passes", rejected: true } });
    }
  });

  it("ignores drafts that were not rejected, and other projects", () => {
    saveDraft("p1", "new-EXPENSE", draft(false));
    saveDraft("p2", "new-EXPENSE", draft(true));
    expect(findRejectedDraft("p1")).toBeNull();
  });

  it("clears the drafts of every project and leaves other keys alone", () => {
    saveDraft("p1", "new-EXPENSE", draft(false));
    saveDraft("p1", "edit-e1", draft(false));
    saveDraft("p2", "new-REFUND", draft(true));
    saveDraft("p3", "new-EXPENSE", draft(false));
    localStorage.setItem("splitdummy-mock-v3", "{}");
    localStorage.setItem("other", "x");
    clearAllDrafts();
    expect(keys()).toEqual(["other", "splitdummy-mock-v3"]);
  });
});
