import { ApiError } from "../lib/errors";
import { isLocal } from "../lib/env";
import { logError } from "../lib/log";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

interface SiteverifyResult {
  success: boolean;
  hostname?: string;
  "error-codes"?: string[];
}

/**
 * Server-side Turnstile validation. Fails closed in staging/production; in local dev/tests a
 * missing secret disables the check (configure Cloudflare's always-pass test keys to exercise it).
 */
export async function verifyTurnstile(env: Env, token: string | undefined, remoteIp: string): Promise<void> {
  const secret: string | undefined = env.TURNSTILE_SECRET;
  if (!secret) {
    if (isLocal(env)) return;
    logError("turnstile secret missing", new Error("TURNSTILE_SECRET unset"));
    throw new ApiError("INTERNAL", "Verification is temporarily unavailable.");
  }
  if (!token) throw failed();

  let result: SiteverifyResult;
  try {
    const body = new FormData();
    body.append("secret", secret);
    body.append("response", token);
    if (remoteIp !== "unknown") body.append("remoteip", remoteIp);
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body });
    if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
    result = await res.json<SiteverifyResult>();
  } catch (err) {
    logError("turnstile siteverify failed", err);
    throw new ApiError("TURNSTILE_FAILED", "We couldn't verify you're human. Please try again.", { status: 503 });
  }

  if (!result.success) throw failed();
  // Test keys report hostname "example.com"; only enforce the hostname on deployed environments.
  if (!isLocal(env) && result.hostname && result.hostname !== new URL(env.APP_ORIGIN).hostname) throw failed();
}

const failed = () =>
  new ApiError("TURNSTILE_FAILED", "Please complete the human check and try again.", { field: "turnstileToken" });
