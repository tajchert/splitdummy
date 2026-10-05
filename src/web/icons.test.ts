import { describe, expect, it } from "vitest";
import html from "../../index.html?raw";

const files = import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Same extraction rules as used to build the index.html subset. */
function usedIcons(): Set<string> {
  const names = new Set<string>();
  for (const s of Object.values(files)) {
    for (const m of s.matchAll(/<Icon\b[^>]*?name=\{([^}]*)\}/gs)) for (const n of m[1]!.matchAll(/"([a-z][a-z0-9_]+)"/g)) names.add(n[1]!);
    for (const m of s.matchAll(/<Icon\b[^>]*?name="([a-z0-9_]+)"/gs)) names.add(m[1]!);
    for (const m of s.matchAll(/\bicon[A-Za-z]*\s*[:=]\s*"([a-z_]+)"/g)) names.add(m[1]!);
    for (const m of s.matchAll(/confirmIcon="([a-z_]+)"/g)) names.add(m[1]!);
    for (const m of s.matchAll(/[A-Z_]+: "([a-z_]+)",/g)) names.add(m[1]!);
  }
  // Status words that the patterns above also pick up.
  for (const w of ["active", "offline"]) names.delete(w);
  return names;
}

describe("icon font subset", () => {
  it("index.html requests every icon the UI uses, sorted", () => {
    const list = html.match(/icon_names=([a-z0-9_,]+)/)?.[1]?.split(",") ?? [];
    expect(list.length).toBeGreaterThan(10);
    expect(list).toEqual([...list].sort());
    expect([...usedIcons()].filter((n) => !list.includes(n))).toEqual([]);
  });
});
