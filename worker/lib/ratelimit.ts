import { ApiError } from "./errors";
import { logError } from "./log";

/** Throws 429 RATE_LIMITED when the binding rejects `key`. A limiter outage fails open. */
export async function enforceLimit(limiter: RateLimit, key: string): Promise<void> {
  let success = true;
  try {
    ({ success } = await limiter.limit({ key }));
  } catch (err) {
    logError("rate limiter unavailable", err);
  }
  if (!success) throw new ApiError("RATE_LIMITED", "Too many attempts. Please wait a minute and try again.");
}
