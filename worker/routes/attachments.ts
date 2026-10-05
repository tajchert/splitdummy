/** Receipt photos: raw-body upload (validated, metadata stripped) and member-only download. */
import { Hono } from "hono";
import { ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, MAX_IMAGE_EDGE, type AttachmentDTO } from "@shared/api";
import { requireIdempotencyKey, requireSession } from "../auth/middleware";
import { toPrincipal } from "../auth/principals";
import { attachmentKey } from "../lib/attachments";
import type { AppEnv } from "../lib/context";
import { sha256HexBytes } from "../lib/crypto";
import { ApiError, notFound } from "../lib/errors";
import { readBodyBytes } from "../lib/http";
import { sniffImage, stripMetadata } from "../lib/image";
import { callProject, isOk, toHttpResponse } from "../lib/project";
import { enforceLimit } from "../lib/ratelimit";
import { splitEndpoint, validateParams } from "./projects";

export const attachmentRoutes = new Hono<AppEnv>();

attachmentRoutes.post(splitEndpoint("uploadAttachment").path, async (c) => {
  const { principal } = await requireSession(c);
  const params = c.req.param() as Record<string, string>;
  validateParams(params);
  const projectId = params.projectId!;
  const idempotencyKey = requireIdempotencyKey(c);
  await enforceLimit(c.env.RL_UPLOAD, `principal:${principal.id}`);

  const declared = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(declared)) {
    throw new ApiError("VALIDATION", "Upload a JPEG or WebP image.", { field: "Content-Type" });
  }
  const raw = await readBodyBytes(c.req.raw, MAX_ATTACHMENT_BYTES);
  const info = sniffImage(raw);
  if (!info || info.type !== declared) throw new ApiError("VALIDATION", "This file isn't a valid JPEG or WebP image.");
  if (info.width > MAX_IMAGE_EDGE || info.height > MAX_IMAGE_EDGE) {
    throw new ApiError("VALIDATION", `Photos can be at most ${MAX_IMAGE_EDGE} pixels on each side.`);
  }
  const bytes = stripMetadata(raw, info.type);
  const principalArg = toPrincipal(principal);
  const requestId = c.get("requestId");

  const res = await callProject(c.env, {
    op: "registerAttachment",
    projectId,
    principal: principalArg,
    params,
    body: { contentType: info.type, bytes: bytes.length, width: info.width, height: info.height, sha256: await sha256HexBytes(bytes) },
    idempotencyKey,
    requestId,
  });
  if (isOk(res)) {
    const dto = res.body as AttachmentDTO;
    // A replay (same key) returns the original registration even if the photo was since trashed or purged,
    // so only write the bytes while the DO still serves the photo; this also repairs a put that failed earlier.
    const live = await callProject(c.env, {
      op: "readAttachment",
      projectId,
      principal: principalArg,
      params: { ...params, attachmentId: dto.id },
      requestId,
    });
    if (live.status === 200) {
      await c.env.ATTACHMENTS.put(attachmentKey(projectId, dto.id), bytes, { httpMetadata: { contentType: dto.contentType } });
    }
  }
  return toHttpResponse(c, res, "registerAttachment");
});

attachmentRoutes.get(splitEndpoint("getAttachment").path, async (c) => {
  const { principal } = await requireSession(c);
  const params = c.req.param() as Record<string, string>;
  validateParams(params);
  const projectId = params.projectId!;
  const res = await callProject(c.env, { op: "readAttachment", projectId, principal: toPrincipal(principal), params, requestId: c.get("requestId") });
  if (!isOk(res)) return toHttpResponse(c, res, "readAttachment");
  const dto = res.body as AttachmentDTO;
  const object = await c.env.ATTACHMENTS.get(attachmentKey(projectId, dto.id));
  if (!object) throw notFound("This photo isn't available.");
  return c.body(object.body, 200, {
    "Content-Type": dto.contentType,
    "Content-Length": String(object.size),
    // Ids are never reused and objects never change.
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline",
  });
});
