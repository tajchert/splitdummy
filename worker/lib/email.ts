import { isProduction } from "./env";
import { logError } from "./log";

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

function parseFrom(from: string): EmailAddress {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return match ? { name: match[1] ?? "", email: match[2] ?? from } : { name: "Splitdummy", email: from.trim() };
}

/**
 * Sends one transactional email. Returns false on failure. Outside production a missing/broken
 * binding is tolerated (local dev has no real Email Service); callers decide whether to fail.
 */
export async function sendEmail(env: Env, to: string, content: EmailContent): Promise<boolean> {
  try {
    await env.EMAIL.send({ to, from: parseFrom(env.EMAIL_FROM), ...content });
    return true;
  } catch (err) {
    logError("email send failed", err, { subject: content.subject, production: isProduction(env) });
    return false;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Plain, accessible layout: real text, one obvious link, no images, readable without CSS. */
function layout(opts: { heading: string; paragraphs: string[]; action?: { label: string; url: string }; footer: string }): string {
  const p = (t: string) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#1f1d1a">${escapeHtml(t)}</p>`;
  const action = opts.action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(opts.action.url)}" style="display:inline-block;padding:12px 20px;background:#1f1d1a;color:#ffffff;text-decoration:none;border-radius:6px;font-size:16px">${escapeHtml(opts.action.label)}</a></p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#5c5750">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(opts.action.url)}</span></p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(opts.heading)}</title></head>
<body style="margin:0;padding:24px;background:#faf8f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<main style="max-width:520px;margin:0 auto">
<h1 style="font-size:22px;margin:0 0 16px;color:#1f1d1a">${escapeHtml(opts.heading)}</h1>
${opts.paragraphs.map(p).join("\n")}
${action}
<p style="margin:32px 0 0;font-size:13px;line-height:1.5;color:#5c5750">${escapeHtml(opts.footer)}</p>
</main></body></html>`;
}

export function signInEmail(link: string, purpose: "SIGN_IN" | "ATTACH"): EmailContent {
  const attach = purpose === "ATTACH";
  const subject = attach ? "Confirm your email for Splitdummy" : "Your Splitdummy sign-in link";
  const intro = attach
    ? "Confirm this email address to keep access to your Splitdummy groups on any device."
    : "Use the link below to sign in to Splitdummy.";
  const footer = "This link works once and expires in 15 minutes. If you didn't ask for it, you can ignore this email.";
  const label = attach ? "Confirm email" : "Sign in";
  return {
    subject,
    text: `${intro}\n\n${label}: ${link}\n\n${footer}\n`,
    html: layout({ heading: subject, paragraphs: [intro], action: { label, url: link }, footer }),
  };
}

export function notificationEmail(opts: { summary: string; projectUrl: string }): EmailContent {
  const subject = `Splitdummy: ${opts.summary}`.slice(0, 160);
  const footer = "You're receiving this because you're a member of this Splitdummy group.";
  return {
    subject,
    text: `${opts.summary}\n\nOpen the group: ${opts.projectUrl}\n\n${footer}\n`,
    html: layout({ heading: opts.summary, paragraphs: [], action: { label: "Open the group", url: opts.projectUrl }, footer }),
  };
}
