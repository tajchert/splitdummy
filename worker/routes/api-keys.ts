import { Hono } from "hono";
import { CreateApiKeySchema } from "@shared/api";
import { issueApiKey, listApiKeys } from "../auth/api-keys";
import { requireSession } from "../auth/middleware";
import type { AppContext, AppEnv } from "../lib/context";
import { ApiError, notFound } from "../lib/errors";
import { parseWith, readJsonBody } from "../lib/http";
import { enforceLimit } from "../lib/ratelimit";

async function account(c: AppContext) {
  const session = await requireSession(c);
  if (session.apiKey || session.principal.kind !== "ACCOUNT") throw new ApiError("FORBIDDEN", "Sign in with your email on the website to manage API keys.");
  return session.principal;
}
export const apiKeyRoutes = new Hono<AppEnv>();
apiKeyRoutes.get("/api/me/api-keys", async (c) => {
  const principal = await account(c);
  return c.json(await listApiKeys(c.env.DB, principal.id));
});
// Creation deliberately isn't automatically retried: the secret cannot be retrieved/replayed.
apiKeyRoutes.post("/api/me/api-keys", async (c) => {
  const principal = await account(c);
  await enforceLimit(c.env.RL_MUTATION, `principal:${principal.id}`);
  const input = parseWith(CreateApiKeySchema, await readJsonBody(c.req.raw));
  return c.json(await issueApiKey(c.env.DB, principal.id, input.name, input.scope), 201);
});
apiKeyRoutes.delete("/api/me/api-keys/:keyId", async (c) => {
  const principal = await account(c);
  await enforceLimit(c.env.RL_MUTATION, `principal:${principal.id}`);
  const result = await c.env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND principal_id = ?")
    .bind(c.req.param("keyId"), principal.id).run();
  if (result.meta.changes === 0) throw notFound();
  return c.json({ ok: true });
});
