import { env } from "cloudflare:workers";
import type { EntryInput, ProjectViewDTO } from "@shared/api";
import type { DoOp, DoResponse, Principal } from "../../worker/do/types";

let counter = 0;
const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function makePrincipal(opts: { recoverable?: boolean; kind?: "ACCOUNT" | "GUEST" } = {}): Principal {
  const recoverable = opts.recoverable ?? true;
  return {
    principalId: `pr_${uid()}`,
    kind: opts.kind ?? (recoverable ? "ACCOUNT" : "GUEST"),
    email: recoverable ? `${uid()}@example.com` : null,
    hasRecoverableAccount: recoverable,
  };
}

export type Stub = DurableObjectStub<import("../../worker/do/ProjectDO").ProjectDO>;

export function stubFor(projectId: string): Stub {
  return env.PROJECT.get(env.PROJECT.idFromName(projectId));
}

/** Calls the DO on behalf of one principal. */
export class Client {
  memberId = "";
  constructor(
    readonly stub: Stub,
    readonly projectId: string,
    readonly principal: Principal | null,
  ) {}

  async call(op: DoOp, params: Record<string, string> = {}, body: unknown = null, key: string | null = crypto.randomUUID()): Promise<DoResponse> {
    return this.stub.handle({
      op,
      principal: this.principal,
      params: { projectId: this.projectId, ...params },
      body,
      idempotencyKey: key,
      requestId: `req_${uid()}`,
    });
  }

  /** Call and assert a 2xx; returns the body. */
  async ok<T = any>(op: DoOp, params: Record<string, string> = {}, body: unknown = null, key?: string): Promise<T> {
    const res = await this.call(op, params, body, key);
    if (res.status >= 300) throw new Error(`${op} failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as T;
  }

  view(): Promise<ProjectViewDTO> {
    return this.ok<ProjectViewDTO>("getProject", {}, null, null);
  }
}

export interface Group {
  stub: Stub;
  projectId: string;
  owner: Client;
  roundId: string;
  members: Client[];
}

export async function createGroup(
  opts: { baseCurrency?: string; multiCurrencyEnabled?: boolean; members?: number; guests?: boolean } = {},
): Promise<Group> {
  const projectId = `p_${uid()}`;
  const stub = stubFor(projectId);
  const owner = new Client(stub, projectId, makePrincipal());
  const view = await owner.ok<ProjectViewDTO>("createProject", {}, {
    projectId,
    name: "Trip",
    baseCurrency: opts.baseCurrency ?? "PLN",
    multiCurrencyEnabled: opts.multiCurrencyEnabled ?? false,
    ownerDisplayName: "Alice",
  });
  owner.memberId = view.me.memberId;
  const group: Group = { stub, projectId, owner, roundId: view.project.activeRoundId!, members: [] };
  const names = ["Bob", "Carol", "Dan", "Eve", "Frank"];
  for (let i = 0; i < (opts.members ?? 1); i++) {
    group.members.push(await joinGroup(group, names[i] ?? `M${i}`, { recoverable: !opts.guests }));
  }
  return group;
}

export async function inviteToken(group: Group): Promise<string> {
  const inv = await group.owner.ok<{ url: string }>("createInvite");
  return inv.url.split("#")[1]!;
}

export async function joinGroup(group: Group, displayName: string, opts: { recoverable?: boolean } = {}): Promise<Client> {
  const token = await inviteToken(group);
  const client = new Client(group.stub, group.projectId, makePrincipal({ recoverable: opts.recoverable ?? false }));
  const res = await client.ok<{ memberId: string }>("join", { tokenSecret: token }, { displayName });
  client.memberId = res.memberId;
  return client;
}

export function expense(
  payer: string,
  participants: string[],
  amount: string,
  extra: Partial<EntryInput> = {},
): EntryInput {
  return {
    type: "EXPENSE",
    description: "Dinner",
    occurredAt: "2026-10-01",
    originalAmount: amount,
    originalCurrency: "PLN",
    conversion: { method: "IDENTITY" },
    payerMemberId: payer,
    splitMode: "EQUAL",
    participants: participants.map((memberId) => ({ memberId })),
    ...extra,
  };
}

export async function errorCode(res: Promise<DoResponse> | DoResponse): Promise<{ status: number; code: string; field?: string; details?: any }> {
  const r = await res;
  const body = r.body as { error?: { code: string; field?: string; details?: unknown } };
  return { status: r.status, code: body.error?.code ?? "OK", field: body.error?.field, details: body.error?.details };
}

/** Owner reviews then freezes, acknowledging whoever is not ready. */
export async function freezeNow(group: Group, reason?: string) {
  const review = await group.owner.ok("getReview", { roundId: group.roundId }, null, null);
  return group.owner.ok("freeze", { roundId: group.roundId }, {
    expectedReviewVersion: review.reviewVersion,
    acknowledgeNotReady: review.notReadyMemberIds,
    earlyFreezeReason: reason,
  });
}
