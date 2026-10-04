import type { ConfigDTO } from "@shared/api";

export type Environment = ConfigDTO["environment"];

export function environmentOf(env: Env): Environment {
  const value: string = env.ENVIRONMENT;
  return value === "production" || value === "staging" || value === "test" ? value : "development";
}

export const isProduction = (env: Env) => environmentOf(env) === "production";
/** Local dev and tests: relaxed origin check, optional Turnstile, tolerant email. */
export const isLocal = (env: Env) => {
  const e = environmentOf(env);
  return e === "development" || e === "test";
};

/** Origin allowed for cookie-authenticated mutations and WebSocket upgrades. */
export function isAllowedOrigin(env: Env, origin: string | null | undefined): boolean {
  if (!origin) return false;
  if (origin === env.APP_ORIGIN) return true;
  if (!isLocal(env)) return false;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
