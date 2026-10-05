import { afterEach, describe, expect, it, vi } from "vitest";
import { redactClientPath, redactClientText } from "../../worker/routes/client-errors";
import { call, mockTurnstile, signIn, testEnv, uniqueEmail } from "./helpers";

const P = `p_${"ab".repeat(16)}`;

afterEach(() => {
  vi.restoreAllMocks();
});

function withAnalytics() {
  const writeDataPoint = vi.fn();
  const env = { ...testEnv, ANALYTICS: { writeDataPoint } } as unknown as Env;
  return { env, writeDataPoint };
}

describe("request analytics", () => {
  it("records the endpoint name, route pattern, client kind, status and duration", async () => {
    const { env, writeDataPoint } = withAnalytics();
    await call("/api/config", { env });
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const point = writeDataPoint.mock.calls[0]![0];
    expect(point.indexes).toEqual(["config"]);
    expect(point.blobs).toEqual(["config", "GET", "/api/config", "none"]);
    expect(point.doubles[0]).toBe(200);
    expect(point.doubles[1]).toBeGreaterThanOrEqual(0);
  });

  it("uses the route pattern, never the IDs in the URL", async () => {
    const { env, writeDataPoint } = withAnalytics();
    const res = await call(`/api/projects/${P}`, { env });
    expect(res.status).toBe(401);
    const point = writeDataPoint.mock.calls[0]![0];
    expect(point.blobs).toEqual(["getProject", "GET", "/api/projects/:projectId", "none"]);
    expect(point.doubles[0]).toBe(401);
    expect(JSON.stringify(point)).not.toContain(P);
  });

  it("marks signed-in requests and unmatched paths", async () => {
    mockTurnstile();
    const cookie = await signIn(uniqueEmail("an"));
    const { env, writeDataPoint } = withAnalytics();
    await call("/api/me", { env, cookie });
    await call("/api/nope", { env });
    expect(writeDataPoint.mock.calls[0]![0].blobs).toEqual(["me", "GET", "/api/me", "session"]);
    expect(writeDataPoint.mock.calls[1]![0].blobs[0]).toBe("unmatched");
    expect(writeDataPoint.mock.calls[1]![0].doubles[0]).toBe(404);
  });

  it("attributes middleware rejections to the guarded endpoint", async () => {
    const { env, writeDataPoint } = withAnalytics();
    const res = await call("/api/client-errors", { body: {}, origin: "https://evil.example", env });
    expect(res.status).toBe(403);
    expect(writeDataPoint.mock.calls[0]![0].blobs.slice(0, 3)).toEqual(["reportClientError", "POST", "/api/client-errors"]);
  });

  it("never fails the request when the dataset is unavailable", async () => {
    const env = { ...testEnv, ANALYTICS: undefined } as unknown as Env;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call("/api/config", { env })).status).toBe(200);
  });
});

describe("client error reports", () => {
  const report = {
    kind: "error",
    message: "TypeError: x is undefined (for ana@example.com)",
    stack: "at f (https://splitdummy.app/assets/index-Bx1.js:1:20)",
    path: `/join/${P}.abcdefghijklmnopqrstuvwxyz?x=1#frag`,
  };

  it("logs a redacted report and answers 204", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("/api/client-errors", { body: report });
    expect(res.status).toBe(204);
    expect(errors).toHaveBeenCalledOnce();
    const logged = errors.mock.calls[0]![0] as Record<string, unknown>;
    expect(logged).toMatchObject({
      level: "error",
      msg: "client error",
      kind: "error",
      error: "TypeError: x is undefined (for <email>)",
      path: "/join/<redacted>.<redacted>",
      stack: report.stack,
    });
    expect(JSON.stringify(logged)).not.toContain(P);
  });

  it("rejects malformed reports and cross-site posts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call("/api/client-errors", { body: { ...report, kind: "nope" } })).status).toBe(422);
    expect((await call("/api/client-errors", { body: report, origin: "https://evil.example" })).status).toBe(403);
  });

  it("is rate limited per IP", async () => {
    const env = { ...testEnv, RL_CLIENT_ERROR: { limit: async () => ({ success: false }) } } as unknown as Env;
    const res = await call("/api/client-errors", { body: report, env });
    expect(res.status).toBe(429);
  });

  it("redacts tokens, emails, queries and fragments", () => {
    expect(redactClientPath("/invite#secret")).toBe("/invite");
    expect(redactClientPath("/g/p_0123456789abcdef0123456789abcdef/balance?x=1")).toBe("/g/<redacted>/balance");
    expect(redactClientText("Failed for bob@example.org")).toBe("Failed for <email>");
    expect(redactClientText("chunk index-Bx1y2z.js")).toBe("chunk index-Bx1y2z.js");
  });
});
