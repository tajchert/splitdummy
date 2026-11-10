import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { memberInviteEmail, sendEmail } from "./email";

const testEnv = env as Env;
const INVITER = "Zelda Quimby";
const GROUP = "Secret Ski Trip";

const invite = () =>
  memberInviteEmail({
    inviterName: INVITER,
    projectName: GROUP,
    displayName: "Link",
    url: "https://example.test/join#token=abc",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendEmail", () => {
  it("logs a fixed kind, never the subject, when sending fails", async () => {
    const send = vi.fn(async () => {
      throw new Error("provider down");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = { ...testEnv, EMAIL: { send } } as unknown as Env;
    expect(await sendEmail(fake, "to@example.com", invite())).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
    const logged = spy.mock.calls[0]![0] as Record<string, unknown>;
    expect(logged).toMatchObject({ msg: "email send failed", kind: "member_invite" });
    expect(logged).not.toHaveProperty("subject");
    const text = JSON.stringify(logged);
    expect(text).not.toContain(INVITER);
    expect(text).not.toContain(GROUP);
  });

  it("hands the provider only to, from, subject, text and html", async () => {
    const send = vi.fn(async () => ({ messageId: "x" }));
    const fake = { ...testEnv, EMAIL: { send } } as unknown as Env;
    expect(await sendEmail(fake, "to@example.com", invite())).toBe(true);
    const sent = (send.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(sent.to).toBe("to@example.com");
    expect(sent.subject).toContain(INVITER);
  });
});
