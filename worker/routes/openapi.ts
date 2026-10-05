import { Hono } from "hono";
import { z } from "zod";
import * as api from "@shared/api";
import { PUBLIC_API_ENDPOINTS } from "@shared/public-api";
import { apiGuide } from "@shared/api-guide";
import type { AppEnv } from "../lib/context";

// Document core response fields while allowing additive fields from the shared DTOs.
const id = z.string();
const money = z.string().describe('Integer minor units, e.g. "1250" = 12.50 for a currency with exponent 2.');
const nullableText = z.string().nullable();
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const member = object({ id, displayName: z.string(), isOwner: z.boolean(), isGuest: z.boolean(),
  hasRecoverableAccount: z.boolean(), joinedAt: z.string(), status: z.enum(["ACTIVE", "LEFT", "REMOVED"]), referenced: z.boolean(), accountDeleted: z.boolean(),
  kind: z.enum(["PERSON", "PLACEHOLDER"]), inviteState: z.enum(["INVITED", "INVITE_EXPIRED"]).nullable(), inviteExpiresAt: nullableText, invitedEmail: nullableText.optional() });
const project = object({ id, name: z.string(), ownerMemberId: id, baseCurrency: z.string(), baseExponent: z.number(),
  multiCurrencyEnabled: z.boolean(), membersCanRename: z.boolean(), baseCurrencyLocked: z.boolean(), activeRoundId: id.nullable(), version: z.number(), createdAt: z.string() });
const round = object({ id, sequence: z.number(), status: z.enum(["COLLECTING", "SETTLING", "SETTLED"]),
  ledgerVersion: z.number(), reviewVersion: z.number(), createdAt: z.string(), frozenAt: nullableText, settledAt: nullableText,
  earlyFreezeReason: nullableText, frozenByMemberId: nullableText, scheduledFreezeDate: nullableText,
  scheduledFreezeTimeZone: nullableText, scheduledFreezeAt: nullableText, frozenBySchedule: z.boolean() });
const amounts = z.array(object({ memberId: id, originalAmount: money, baseAmount: money }));
const entry = object({ id, roundId: id, type: z.enum(["EXPENSE", "REFUND", "ADJUSTMENT"]), creatorMemberId: id,
  lastEditedByMemberId: nullableText, occurredAt: z.string(), description: z.string(), originalAmount: money, originalCurrency: z.string(),
  originalExponent: z.number(), baseAmount: money, baseCurrency: z.string(), baseExponent: z.number(),
  conversion: object({ method: z.enum(["IDENTITY", "MANUAL_RATE", "ACTUAL_BASE_AMOUNT"]), rate: z.string(),
    rateSource: z.enum(["IDENTITY", "OWNER_DEFAULT", "ENTRY_OVERRIDE", "ACTUAL_CHARGE"]), rateSetByMemberId: nullableText,
    rateSetAt: nullableText, note: nullableText }), payerMemberId: nullableText, splitMode: z.enum(["EQUAL", "EXACT"]).nullable(),
  contributions: amounts, allocations: amounts, adjustmentEffects: amounts.nullable(), correctedEntryId: nullableText,
  correctedRoundId: nullableText, revision: z.number(), createdAt: z.string(), updatedAt: z.string() });
const instruction = object({ id, roundId: id, fromMemberId: id, toMemberId: id, amount: money, currency: z.string(), exponent: z.number(),
  state: z.enum(["PROPOSED", "SENT", "CONFIRMED", "DISPUTED"]), sentAt: nullableText, confirmedAt: nullableText,
  disputedAt: nullableText, disputeNote: nullableText, revision: z.number() });
const readiness = object({ memberId: id, ready: z.boolean(), markedAt: nullableText });
const roundView = object({ round, entries: z.array(entry), readiness: z.array(readiness),
  balances: z.array(object({ memberId: id, paid: money, share: money, adjustments: money, net: money.describe("Positive receives, negative owes."),
    confirmedProgress: money.nullable(), remaining: money.nullable() })), instructions: z.array(instruction),
  totals: object({ expenses: money, refunds: money, adjustments: money }),
  currencySubtotals: z.array(object({ currency: z.string(), exponent: z.number(), expenses: money, refunds: money, baseEquivalent: money })) });
const invitation = object({ id, createdAt: z.string(), expiresAt: z.string(), revokedAt: nullableText, url: z.string().optional() });
const rate = object({ currency: z.string(), rate: z.string(), setByMemberId: id, setAt: z.string(), revision: z.number() });
const projectView = object({ project, me: object({ memberId: id, isOwner: z.boolean() }), members: z.array(member),
  rates: z.array(rate), current: roundView, rounds: z.array(round), invitations: z.array(invitation).nullable() });
const review = object({ roundId: id, reviewVersion: z.number(), ledgerVersion: z.number(), notReadyMemberIds: z.array(id), view: roundView,
  proposedTransfers: z.array(object({ fromMemberId: id, toMemberId: id, amount: money })) });
const ok = object({ ok: z.literal(true) });
const actionResult = object({ instruction, round });
const error = object({ error: object({ code: z.string(), message: z.string(), field: z.string().optional(), details: z.record(z.string(), z.unknown()).optional() }) });

interface Operation {
  summary: string;
  description?: string;
  body?: z.ZodType;
  response?: z.ZodType;
  created?: boolean;
}
const operations: Partial<Record<keyof typeof api.ENDPOINTS, Operation>> = {
  me: { summary: "Get your account identity", response: object({ principalId: id, kind: z.enum(["ACCOUNT", "GUEST"]), email: nullableText, displayName: nullableText }) },
  listProjects: { summary: "List your groups", response: z.array(object({ id, name: z.string(), baseCurrency: z.string(), isOwner: z.boolean(),
    roundStatus: z.enum(["COLLECTING", "SETTLING", "SETTLED"]).nullable(), roundSequence: z.number().nullable(), nextAction: nullableText, updatedAt: z.string() })) },
  createProject: { summary: "Create a group", body: api.CreateProjectSchema.omit({ turnstileToken: true }), response: projectView, created: true },
  getProject: { summary: "Get members, expenses, balances and current round", response: projectView },
  updateSettings: { summary: "Update group settings", description: "Owner only. Send the current project.version as expectedVersion.", body: api.UpdateSettingsSchema, response: project },
  putRate: { summary: "Set a currency exchange rate", description: "Owner only. Rate converts the original currency to the base currency.", body: api.PutRateSchema, response: rate },
  deleteRate: { summary: "Remove a currency exchange rate", description: "Owner only.", response: ok },
  createInvite: { summary: "Create an invitation", description: "Owner only. Invitation URL is returned once.", response: invitation, created: true },
  revokeInvite: { summary: "Revoke an invitation", description: "Owner only.", response: invitation },
  addMember: { summary: "Add a person by name", description: "Owner only. With an email, sends a 7-day invitation that lets them claim this spot.", body: api.AddMemberSchema, response: member.extend({ emailSent: z.boolean().nullable() }), created: true },
  renameMember: { summary: "Rename a member", description: "Owner only.", body: api.RenameMemberSchema, response: member },
  inviteMember: { summary: "Email an invitation to a placeholder", description: "Owner only. Replaces any earlier link.", body: api.InviteMemberSchema, response: member.extend({ emailSent: z.boolean().nullable() }) },
  cancelMemberInvite: { summary: "Cancel a placeholder's email invitation", description: "Owner only.", response: member },
  removeMember: { summary: "Remove a group member", description: "Owner only. Referenced members cannot be removed.", response: member },
  leave: { summary: "Leave a group", response: member },
  renameMe: { summary: "Change your name in a group", description: "403 when the owner has locked names (project.membersCanRename = false); the owner can always rename.", body: api.RenameMemberSchema, response: member },
  transferOwnership: { summary: "Offer group ownership to a member", description: "Owner only. Recipient must accept the offer.", body: api.TransferOwnershipSchema, response: project },
  acceptOwnership: { summary: "Accept an ownership offer", response: project },
  createEntry: { summary: "Add an expense or refund", description: "Collecting round only. Amounts are strings in minor units. EQUAL omits participant amounts; EXACT amounts must sum to originalAmount. IDENTITY is for the base currency.", body: api.EntryInputSchema, response: entry, created: true },
  updateEntry: { summary: "Edit an expense or refund", description: "Collecting round only. Creator or owner; send the latest entry.revision as expectedRevision.", body: api.UpdateEntrySchema, response: entry },
  deleteEntry: { summary: "Delete an expense or refund", description: "Collecting round only. Creator or owner; send the latest entry.revision as expectedRevision.", body: api.DeleteEntrySchema, response: ok },
  createAdjustment: { summary: "Correct a historical entry", description: "Owner only. Signed base effects must sum to zero. Creates a correction in the current collecting round.", body: api.AdjustmentInputSchema, response: entry, created: true },
  readiness: { summary: "Mark yourself ready or not ready", body: api.ReadinessSchema, response: readiness },
  review: { summary: "Preview balances and proposed settlement transfers", response: review },
  freeze: { summary: "Freeze expenses and start settlement", description: "Owner only. Get a fresh review first and pass reviewVersion as expectedReviewVersion. If members are not ready, acknowledge exactly those member IDs; earlyFreezeReason is optional.", body: api.FreezeSchema, response: object({ round, instructions: z.array(instruction) }) },
  freezeSchedule: { summary: "Schedule or cancel automatic freezing", description: "Owner only. Freezes at the end of the date in the IANA timeZone. Use date: null to cancel.", body: api.FreezeScheduleSchema, response: round },
  getRound: { summary: "Get a current or historical round", response: roundView },
  sent: { summary: "Record that you sent a transfer", description: "Sender only; the owner may also act for a placeholder sender. This records a real-world payment; it does not move money.", body: api.InstructionActionSchema, response: actionResult },
  received: { summary: "Confirm that you received a transfer", description: "Recipient only; the owner may also act for a placeholder recipient. This records a real-world payment; it does not move money.", body: api.InstructionActionSchema, response: actionResult },
  dispute: { summary: "Dispute a transfer", description: "Recipient only; the owner may also act for a placeholder recipient.", body: api.InstructionActionSchema, response: actionResult },
  startRound: { summary: "Start the next round", description: "Owner only; previous round must be settled.", response: round, created: true },
  history: { summary: "Get round history and audit events", response: object({ rounds: z.array(round), events: z.array(object({
    id, at: z.string(), actorMemberId: nullableText, action: z.string(), roundId: nullableText, entityId: nullableText,
    summary: z.string(), details: z.record(z.string(), z.unknown()).nullable() })) }) },
  export: { summary: "Export the group as CSV" },
};

function jsonSchema(schema: z.ZodType, io: "input" | "output" = "output") {
  const { $schema: _dialect, ...result } = z.toJSONSchema(schema, { io });
  return result;
}
const errors = Object.fromEntries(Object.entries({ 401: "Invalid, expired or revoked key", 403: "Read-only key or insufficient permissions",
  404: "Unavailable or not a member", 409: "Stale revision, frozen round, state or idempotency conflict", 422: "Invalid input", 429: "Rate limited", 500: "Unexpected error" })
  .map(([status, description]) => [status, { description, content: { "application/json": { schema: jsonSchema(error) } } }]));

export function openApiDocument(origin: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, endpoint] of Object.entries(PUBLIC_API_ENDPOINTS)) {
    const definition = operations[key as keyof typeof operations];
    if (!definition || !endpoint) throw new Error(`Missing public API documentation: ${key}`);
    const [method, template] = endpoint.split(" ");
    const path = template!.replace(/:([A-Za-z]+)/g, "{$1}");
    const parameters: Record<string, unknown>[] = [...template!.matchAll(/:([A-Za-z]+)/g)].map((match) => ({
      name: match[1], in: "path", required: true, schema: { type: "string" },
    }));
    if (method !== "GET") parameters.push({ name: "Idempotency-Key", in: "header", required: true,
      description: "New UUID per logical action. Reuse the same key and body for retries.",
      schema: { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_.:-]{8,128}$" } });
    paths[path] ??= {};
    paths[path][method!.toLowerCase()] = {
      operationId: key, summary: definition.summary,
      description: [definition.description, method !== "GET" ? "Requires a read/write API key. Existing group roles still apply." : "Available with read-only or read/write keys."].filter(Boolean).join(" "),
      security: [{ bearerAuth: [] }], parameters,
      ...(definition.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(definition.body, "input") } } } } : {}),
      responses: { [definition.created ? "201" : "200"]: { description: "Success", content: key === "export"
        ? { "text/csv": { schema: { type: "string" } } }
        : { "application/json": { schema: jsonSchema(definition.response ?? ok) } } }, ...errors },
    };
  }
  return { openapi: "3.1.0", info: { title: "Splitdummy API", version: "1.0.0",
    description: "Use your groups from scripts and AI tools. Create a personal API key in Account on the website. Keys expire after 90 days and can be revoked immediately. Amounts are integer minor-unit strings. See /docs/api for examples." },
    servers: [{ url: origin }], paths,
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "Personal API key",
      description: "Create a key in Account → API keys. Use Authorization: Bearer sd_…" } } } };
}

export const openApiRoutes = new Hono<AppEnv>();
openApiRoutes.get("/api/openapi.json", (c) => c.json(openApiDocument(c.env.APP_ORIGIN)));
openApiRoutes.get("/api/docs", (c) => {
  c.header("Content-Type", "text/plain; charset=utf-8");
  return c.body(apiGuide(c.env.APP_ORIGIN));
});
