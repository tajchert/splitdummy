import { describe, expect, it } from "vitest";
import { COMMON_CURRENCIES, CURRENCIES, getCurrency } from "./currencies";

describe("CURRENCIES", () => {
  it("has unique, sorted, well-formed codes with names", () => {
    const codes = CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(codes);
    for (const c of CURRENCIES) {
      expect(c.code).toMatch(/^[A-Z]{3}$/);
      expect([0, 2, 3]).toContain(c.exponent);
      expect(c.name.length).toBeGreaterThan(0);
    }
    expect(codes.length).toBeGreaterThanOrEqual(150);
  });

  it("uses ISO 4217 exponents for three- and zero-decimal currencies", () => {
    const by = (e: number) => CURRENCIES.filter((c) => c.exponent === e).map((c) => c.code);
    expect(by(3)).toEqual(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
    expect(by(0)).toEqual(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
    for (const code of ["EUR", "USD", "PLN", "GBP", "CHF", "HUF", "IDR", "IRR", "COP"]) expect(getCurrency(code)?.exponent).toBe(2);
  });

  it("excludes metals, funds, units of account, testing and withdrawn codes", () => {
    for (const code of ["XAU", "XAG", "XPD", "XPT", "XDR", "XSU", "XUA", "XBA", "XTS", "XXX", "BOV", "CHE", "CHW", "CLF", "COU", "MXV", "USN", "UYI", "UYW", "HRK", "ANG", "BGN", "CUC", "SLL", "ZWL", "VEF", "MRO", "STD", "BYR"]) {
      expect(getCurrency(code), code).toBeUndefined();
    }
  });

  it("keeps real X-prefixed currencies and recent replacements", () => {
    for (const code of ["XOF", "XAF", "XCD", "XPF", "XCG", "ZWG", "SLE", "VES", "VED", "MRU", "STN", "BYN"]) {
      expect(getCurrency(code), code).toBeDefined();
    }
  });

  it("lookup is exact and common picks are supported", () => {
    expect(getCurrency("KWD")).toEqual({ code: "KWD", exponent: 3, name: "Kuwaiti Dinar" });
    expect(getCurrency("eur")).toBeUndefined();
    expect(getCurrency("")).toBeUndefined();
    for (const code of COMMON_CURRENCIES) expect(getCurrency(code)).toBeDefined();
  });

  it("is immutable", () => {
    expect(Object.isFrozen(CURRENCIES)).toBe(true);
    expect(Object.isFrozen(CURRENCIES[0])).toBe(true);
  });
});
