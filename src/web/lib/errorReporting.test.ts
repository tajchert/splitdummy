import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/errors";
import { listenForErrors, reportClientError } from "./errorReporting";

let fetchMock: ReturnType<typeof vi.fn>;
let stop: () => void;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/g/p_1/balance?x=1#token");
  stop = listenForErrors();
});
afterEach(() => {
  stop();
  vi.unstubAllGlobals();
});

const sentBody = (i: number) => JSON.parse(fetchMock.mock.calls[i]![1].body as string);

describe("reportClientError", () => {
  it("posts the error with the path only (no query or fragment)", () => {
    reportClientError("render", new TypeError("x is undefined"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/client-errors");
    expect(sentBody(0)).toMatchObject({ kind: "render", message: "TypeError: x is undefined", path: "/g/p_1/balance" });
  });

  it("skips duplicates, API errors, and stops after five reports", () => {
    reportClientError("error", new Error("same"));
    reportClientError("error", new Error("same"));
    reportClientError("unhandledrejection", new ApiError(500, "INTERNAL", "Something went wrong."));
    for (let i = 0; i < 10; i++) reportClientError("error", new Error(`e${i}`));
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("reports uncaught errors from our own scripts, not cross-origin ones", () => {
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("ours"), filename: `${window.location.origin}/assets/a.js` }));
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("extension"), filename: "chrome-extension://x/a.js" }));
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sentBody(0).message).toBe("Error: ours");
  });

  it("does nothing once stopped", () => {
    stop();
    reportClientError("error", new Error("late"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
