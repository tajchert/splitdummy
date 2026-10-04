// Placeholder — owned by the authority (DO) workstream.
import { DurableObject } from "cloudflare:workers";
import type { DoRequest, DoResponse, ProjectDORpc } from "./types";

export class ProjectDO extends DurableObject<Env> implements ProjectDORpc {
  async handle(_req: DoRequest): Promise<DoResponse> {
    return { status: 501, body: { error: { code: "INTERNAL", message: "Not implemented yet" } } };
  }
}
