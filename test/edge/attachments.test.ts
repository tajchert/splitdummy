import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentDTO, EntryDTO, InvitationDTO, JoinResultDTO, ProjectViewDTO } from "@shared/api";
import { SECRET, includesAscii, jpeg, webp } from "../fixtures/images";
import { call, mockTurnstile, signIn, testEnv, uniqueEmail } from "./helpers";

beforeEach(() => {
  mockTurnstile();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function group() {
  const owner = await signIn(uniqueEmail("owner"));
  const created = await json<ProjectViewDTO>(
    await call("/api/projects", { cookie: owner, body: { name: "Trip", baseCurrency: "PLN", ownerDisplayName: "Ann", turnstileToken: "ok" } }),
    201,
  );
  const projectId = created.project.id;
  const invite = await json<InvitationDTO>(await call(`/api/projects/${projectId}/invitations`, { method: "POST", cookie: owner }), 201);
  const bob = await signIn(uniqueEmail("bob"));
  const token = decodeURIComponent(new URL(invite.url ?? "").hash.slice(1));
  const joined = await json<JoinResultDTO>(await call("/api/invitations/join", { cookie: bob, body: { token, displayName: "Bob" } }));
  return { owner, bob, projectId, roundId: created.current.round.id, ownerMemberId: created.me.memberId, bobMemberId: joined.memberId };
}

const uploadPath = (projectId: string) => `/api/projects/${projectId}/attachments`;
const upload = (projectId: string, cookie: string, bytes: Uint8Array, contentType = "image/webp", extra: Parameters<typeof call>[1] = {}) =>
  call(uploadPath(projectId), { cookie, raw: { body: bytes, contentType }, ...extra });

describe("photo upload", () => {
  it("stores a stripped image privately and serves it to its uploader with immutable caching", async () => {
    const g = await group();
    const a = await json<AttachmentDTO>(await upload(g.projectId, g.owner, webp({ width: 1600, height: 1200, exif: true, xmp: true })), 201);
    expect(a).toMatchObject({ id: expect.stringMatching(/^att_/), contentType: "image/webp", width: 1600, height: 1200 });

    const stored = await testEnv.ATTACHMENTS.get(`projects/${g.projectId}/attachments/${a.id}`);
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    expect(includesAscii(bytes, SECRET)).toBe(false);
    expect(stored!.httpMetadata?.contentType).toBe("image/webp");
    expect(a.bytes).toBe(bytes.length);

    const res = await call(`${uploadPath(g.projectId)}/${a.id}`, { cookie: g.owner });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("shows a photo to other members only once it is saved with an expense, and hides it after deletion", async () => {
    const g = await group();
    const a = await json<AttachmentDTO>(await upload(g.projectId, g.owner, jpeg({ exif: true }), "image/jpeg"), 201);
    const photo = `${uploadPath(g.projectId)}/${a.id}`;
    expect((await call(photo, { cookie: g.bob })).status).toBe(404);

    const entry = await json<EntryDTO>(
      await call(`/api/projects/${g.projectId}/rounds/${g.roundId}/entries`, {
        cookie: g.owner,
        body: {
          type: "EXPENSE", description: "Groceries", occurredAt: "2026-10-01", originalAmount: "4200", originalCurrency: "PLN",
          conversion: { method: "IDENTITY" }, payerMemberId: g.ownerMemberId, splitMode: "EQUAL",
          participants: [{ memberId: g.ownerMemberId }, { memberId: g.bobMemberId }], note: "Receipt attached", attachmentIds: [a.id],
        },
      }),
      201,
    );
    expect(entry.attachments.map((x) => x.id)).toEqual([a.id]);
    expect((await call(photo, { cookie: g.bob })).status).toBe(200);

    const stranger = await signIn(uniqueEmail("stranger"));
    expect((await call(photo, { cookie: stranger })).status).toBe(404);

    await json(await call(`/api/projects/${g.projectId}/rounds/${g.roundId}/entries/${entry.id}`, { method: "DELETE", cookie: g.owner, body: { expectedRevision: 1 } }));
    expect((await call(photo, { cookie: g.bob })).status).toBe(404);
  });

  it("rejects wrong types, mismatched bytes, oversize and oversized dimensions", async () => {
    const g = await group();
    expect((await upload(g.projectId, g.owner, webp(), "image/png")).status).toBe(422);
    expect((await upload(g.projectId, g.owner, webp(), "image/jpeg")).status).toBe(422);
    expect((await upload(g.projectId, g.owner, new Uint8Array([1, 2, 3]))).status).toBe(422);
    expect((await upload(g.projectId, g.owner, webp({ width: 5000, height: 1000 }))).status).toBe(422);
    const huge = new Uint8Array(1_500_001);
    huge.set(webp());
    expect((await upload(g.projectId, g.owner, huge)).status).toBe(413);
    const listed = await testEnv.ATTACHMENTS.list({ prefix: `projects/${g.projectId}/` });
    expect(listed.objects).toHaveLength(0);
  });

  it("requires membership, same origin and an idempotency key", async () => {
    const g = await group();
    const stranger = await signIn(uniqueEmail("stranger"));
    expect((await upload(g.projectId, stranger, webp())).status).toBe(404);
    expect((await upload(g.projectId, g.owner, webp(), "image/webp", { origin: "https://evil.example" })).status).toBe(403);
    expect((await upload(g.projectId, g.owner, webp(), "image/webp", { idempotencyKey: null })).status).toBe(422);
    expect((await upload(g.projectId, "", webp())).status).toBe(401);
  });

  it("repairs a failed R2 write when the client retries with the same key", async () => {
    const g = await group();
    const idempotencyKey = crypto.randomUUID();
    const broken = { ...testEnv, ATTACHMENTS: { put: async () => { throw new Error("r2 down"); } } } as unknown as Env;
    expect((await upload(g.projectId, g.owner, webp(), "image/webp", { idempotencyKey, env: broken })).status).toBe(500);
    const a = await json<AttachmentDTO>(await upload(g.projectId, g.owner, webp(), "image/webp", { idempotencyKey }), 201);
    const again = await json<AttachmentDTO>(await upload(g.projectId, g.owner, webp(), "image/webp", { idempotencyKey }), 201);
    expect(again.id).toBe(a.id);
    expect((await call(`${uploadPath(g.projectId)}/${a.id}`, { cookie: g.owner })).status).toBe(200);
  });

  it("does not recreate the R2 object when an upload is replayed after its photo was trashed and purged", async () => {
    const g = await group();
    const idempotencyKey = crypto.randomUUID();
    const a = await json<AttachmentDTO>(await upload(g.projectId, g.owner, webp(), "image/webp", { idempotencyKey }), 201);
    const entry = await json<EntryDTO>(
      await call(`/api/projects/${g.projectId}/rounds/${g.roundId}/entries`, {
        cookie: g.owner,
        body: {
          type: "EXPENSE", description: "Groceries", occurredAt: "2026-10-01", originalAmount: "4200", originalCurrency: "PLN",
          conversion: { method: "IDENTITY" }, payerMemberId: g.ownerMemberId, splitMode: "EQUAL",
          participants: [{ memberId: g.ownerMemberId }, { memberId: g.bobMemberId }], attachmentIds: [a.id],
        },
      }),
      201,
    );
    await json(await call(`/api/projects/${g.projectId}/rounds/${g.roundId}/entries/${entry.id}`, { method: "DELETE", cookie: g.owner, body: { expectedRevision: 1 } }));
    const key = `projects/${g.projectId}/attachments/${a.id}`;
    await testEnv.ATTACHMENTS.delete(key);

    const replay = await json<AttachmentDTO>(await upload(g.projectId, g.owner, webp(), "image/webp", { idempotencyKey }), 201);
    expect(replay.id).toBe(a.id);
    expect(await testEnv.ATTACHMENTS.get(key)).toBeNull();
  });

  it("documents both endpoints in OpenAPI", async () => {
    const doc = await json<{ paths: Record<string, Record<string, any>> }>(await call("/api/openapi.json"));
    const up = doc.paths["/api/projects/{projectId}/attachments"]!.post;
    expect(Object.keys(up.requestBody.content).sort()).toEqual(["image/jpeg", "image/webp"]);
    expect(doc.paths["/api/projects/{projectId}/attachments/{attachmentId}"]!.get.responses["200"].content["image/webp"]).toBeTruthy();
  });
});
