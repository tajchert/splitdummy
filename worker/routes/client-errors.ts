import { Hono } from "hono";
import { ClientErrorReportSchema } from "@shared/api";
import type { AppEnv } from "../lib/context";
import { clientIp, parseWith, readJsonBody } from "../lib/http";
import { logError, scrubEmails } from "../lib/log";
import { enforceLimit } from "../lib/ratelimit";

/** Invite/join/sign-in tokens and IDs: long opaque runs. Hashed asset names are much shorter. */
const OPAQUE_RE = /[A-Za-z0-9_-]{20,}/g;

export const redactClientText = (text: string) => scrubEmails(text).replace(OPAQUE_RE, "<redacted>");

/** Path only: a query string or fragment can carry a token (`/invite#<token>`). */
export const redactClientPath = (path: string) => redactClientText(path.split(/[?#]/)[0] ?? "");

export const clientErrorRoutes = new Hono<AppEnv>();

/** Browser crashes land in Workers Logs (and Issues) next to the edge's own errors. */
clientErrorRoutes.post("/api/client-errors", async (c) => {
  await enforceLimit(c.env.RL_CLIENT_ERROR, `ip:${clientIp(c.req.raw)}`);
  const report = parseWith(ClientErrorReportSchema, await readJsonBody(c.req.raw, 8 * 1024));
  logError("client error", redactClientText(report.message), {
    requestId: c.get("requestId"),
    kind: report.kind,
    path: redactClientPath(report.path),
    stack: report.stack === undefined ? undefined : redactClientText(report.stack),
  });
  return c.body(null, 204);
});
