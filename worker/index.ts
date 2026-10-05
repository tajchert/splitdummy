import { Hono } from "hono";
import { apiKeyAuth, originGuard } from "./auth/middleware";
import type { AppEnv } from "./lib/context";
import { ApiError } from "./lib/errors";
import { logError } from "./lib/log";
import { handleQueue } from "./queue/consumer";
import { handleScheduled } from "./queue/scheduled";
import { accountRoutes } from "./routes/account";
import { authRoutes } from "./routes/auth";
import { invitationRoutes } from "./routes/invitations";
import { liveRoutes } from "./routes/live";
import { projectRoutes } from "./routes/projects";
import { apiKeyRoutes } from "./routes/api-keys";
import { openApiRoutes } from "./routes/openapi";

export { ProjectDO } from "./do/ProjectDO";

export const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => {
  const requestId = `req_${crypto.randomUUID()}`;
  c.set("requestId", requestId);
  c.set("session", undefined);
  await next();
  if (c.res.status === 101) return; // WebSocket handshake responses are immutable
  c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("X-Request-Id", requestId);
  c.res.headers.set("X-Content-Type-Options", "nosniff");
});
app.use("/api/*", apiKeyAuth);
app.use("/api/*", originGuard);

app.route("/", authRoutes);
app.route("/", accountRoutes);
app.route("/", apiKeyRoutes);
app.route("/", openApiRoutes);
app.route("/", liveRoutes);
app.route("/", invitationRoutes);
app.route("/", projectRoutes);

// Hashed build files. A stale tab asking for a chunk from a previous deploy must get a 404 (the client
// then reloads), not the SPA's index.html served as JavaScript.
app.get("/assets/*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 200 && (res.headers.get("Content-Type") ?? "").startsWith("text/html")) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" } });
  }
  return res;
});

app.notFound((c) => c.json(new ApiError("NOT_FOUND", "Not found.").toBody(), 404));

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json(err.toBody(), err.status as 400);
  const requestId = c.get("requestId");
  logError("unhandled error", err, { requestId, path: new URL(c.req.url).pathname, method: c.req.method });
  return c.json(
    new ApiError("INTERNAL", "Something went wrong. Please try again.", { details: { requestId } }).toBody(),
    500,
  );
});

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    await handleQueue(batch, env);
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
} satisfies ExportedHandler<Env, unknown>;
