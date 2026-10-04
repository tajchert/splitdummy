import { Hono } from "hono";
import { PRINCIPAL_HEADER } from "../do/types";
import { requireSession } from "../auth/middleware";
import { toPrincipal } from "../auth/principals";
import type { AppEnv } from "../lib/context";
import { isAllowedOrigin } from "../lib/env";
import { ApiError, notFound } from "../lib/errors";
import { PROJECT_ID_RE, projectStub } from "../lib/project";

export const liveRoutes = new Hono<AppEnv>();

/**
 * Authenticated WebSocket upgrade, forwarded to the project's DO. The principal header is
 * always set by the edge (client-supplied values are dropped); the DO checks membership.
 */
liveRoutes.get("/api/projects/:projectId/live", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new ApiError("VALIDATION", "Expected a WebSocket upgrade.", { status: 426 });
  }
  if (!isAllowedOrigin(c.env, c.req.header("origin"))) throw new ApiError("FORBIDDEN", "Cross-site request blocked.");
  const { principal } = await requireSession(c);
  const projectId = c.req.param("projectId");
  if (!PROJECT_ID_RE.test(projectId)) throw notFound();

  const headers = new Headers(c.req.raw.headers);
  headers.delete(PRINCIPAL_HEADER);
  headers.delete("cookie"); // the DO never needs the session token
  headers.set(PRINCIPAL_HEADER, JSON.stringify(toPrincipal(principal)));
  const res = await projectStub(c.env, projectId).fetch(new Request(c.req.url, { method: "GET", headers }));
  // Non-upgrade replies (e.g. 404 for non-members) get mutable headers for the shared middleware.
  return res.status === 101 ? res : new Response(res.body, res);
});
