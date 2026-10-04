import type { Context } from "hono";
import type { SessionRecord } from "../auth/session";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    requestId: string;
    /** undefined = not looked up yet; null = no valid session. */
    session: SessionRecord | null | undefined;
  };
}

export type AppContext = Context<AppEnv>;
