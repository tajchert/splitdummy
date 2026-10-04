import { describe, expect, it } from "vitest";
import * as money from "@shared/money";

describe("@shared/money barrel", () => {
  it("re-exports the implemented contract", () => {
    for (const name of [
      "CURRENCIES",
      "getCurrency",
      "parseAmount",
      "formatMinor",
      "parseRate",
      "rateToString",
      "rateFromString",
      "convertToBase",
      "deriveDisplayRate",
      "splitEqual",
      "apportion",
      "computeEntry",
      "computeBalances",
      "planSettlement",
    ]) {
      expect(money, name).toHaveProperty(name);
    }
    expect(money.formatMinor(43000n, 2)).toBe("430.00");
  });
});
