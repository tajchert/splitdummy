import { ENDPOINTS } from "@shared/api";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { AppEnv } from "./context";
import { logError } from "./log";

/** "POST /api/projects" → "createProject", so queries read in product terms. */
const ENDPOINT_NAMES = new Map(
  Object.entries(ENDPOINTS).map(([name, spec]) => [spec.split("?")[0] ?? spec, name]),
);

/**
 * Writes one Analytics Engine data point per API request: what was called, by which client
 * kind, the status and the latency. Route patterns only — never IDs, IPs, or user identifiers.
 *
 * Dataset columns: index1 = endpoint · blob1 = endpoint, blob2 = method, blob3 = route pattern,
 * blob4 = client ("apiKey" | "session" | "none": no session was used) · double1 = status, double2 = duration ms.
 */
export const requestAnalytics: MiddlewareHandler<AppEnv> = async (c, next) => {
  const started = Date.now();
  await next();
  try {
    const method = c.req.method;
    // A middleware answered (origin guard, bad API key): attribute it to the route it guarded.
    // Only unmatched paths end with "/api/*" as their last matched route.
    let route = routePath(c);
    if (route === "/api/*") route = routePath(c, -1);
    const endpoint = ENDPOINT_NAMES.get(`${method} ${route}`) ?? (route === "/api/*" ? "unmatched" : `${method} ${route}`);
    const session = c.get("session");
    const client = session?.apiKey ? "apiKey" : session ? "session" : "none";
    c.env.ANALYTICS.writeDataPoint({
      indexes: [endpoint],
      blobs: [endpoint, method, route, client],
      doubles: [c.res.status, Date.now() - started],
    });
  } catch (err) {
    logError("analytics write failed", err);
  }
};
