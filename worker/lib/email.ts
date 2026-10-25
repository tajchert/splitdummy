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

// Light palette from src/web/styles/tokens.css. Emails declare light-only; clients that force dark
// mode still get readable text because every color pair here is high contrast.
const C = {
  bg: "#f7f2ea",
  surface: "#fffcf7",
  line: "#e2d8c8",
  ink: "#2a2420",
  ink2: "#6b6058",
  accent: "#c24e28",
  green: "#2d6e4e",
  greenSoft: "#d9ebdf",
};
const FONT = `'DM Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif`;

/** The checker strip from the settled screen, as table cells so it survives every client. */
function checkerStrip(): string {
  const row = (offset: number) =>
    `<tr>${Array.from({ length: 40 }, (_, i) => `<td style="width:2.5%;height:8px;font-size:0;line-height:0;background:${(i + offset) % 2 === 0 ? C.ink : C.surface}">&nbsp;</td>`).join("")}</tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed">${row(0)}${row(1)}</table>`;
}

interface Hero {
  /** Animated finish flag, pill and oversized heading for the round's last step. */
  celebrate?: boolean;
  eyebrow?: string;
  heading: string;
  sub?: string;
}

/**
 * Branded, accessible layout: real text, one obvious link, readable with images and CSS off.
 * Table-based so Outlook keeps the card; the only image is decorative and has alt text.
 */
function layout(opts: Hero & { paragraphs: string[]; action: { label: string; url: string }; footer: string; preheader?: string }): string {
  const origin = new URL(opts.action.url).origin;
  const p = (t: string) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.55;color:${C.ink}">${escapeHtml(t)}</p>`;
  const center = opts.celebrate ? "center" : "left";
  const eyebrow = opts.eyebrow
    ? `<p style="margin:0 0 8px;font-size:13px;line-height:1.4;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:${C.accent}">${escapeHtml(opts.eyebrow)}</p>`
    : "";
  const celebration = opts.celebrate
    ? `<p style="margin:0 0 18px"><span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${C.greenSoft};color:${C.green};font-size:13px;font-weight:600;line-height:1.3">&#9679;&nbsp;Settled</span></p>
<img src="${origin}/email/finish-flag.gif" width="96" height="96" alt="A checkered finish flag" style="display:block;margin:0 auto 14px;width:96px;height:96px;border:0">`
    : "";
  const heading = opts.celebrate
    ? `<h1 style="margin:0 0 8px;font-size:44px;line-height:1;letter-spacing:-0.045em;font-weight:700;color:${C.ink}">${escapeHtml(opts.heading)}</h1>`
    : `<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;letter-spacing:-0.02em;font-weight:700;color:${C.ink}">${escapeHtml(opts.heading)}</h1>`;
  const sub = opts.sub ? `<p style="margin:0 0 22px;font-size:16px;line-height:1.5;color:${C.ink2}">${escapeHtml(opts.sub)}</p>` : "";
  const url = escapeHtml(opts.action.url);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${escapeHtml(opts.heading)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};-webkit-text-size-adjust:100%">
${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(opts.preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg}"><tr><td align="center" style="padding:28px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
<tr><td style="padding:0 4px 16px"><a href="${origin}" style="text-decoration:none;color:${C.ink};font-size:17px;font-weight:700;letter-spacing:-0.02em"><img src="${origin}/app-icon-192.png" width="28" height="28" alt="" style="vertical-align:middle;border:0;border-radius:8px;margin-right:8px">Splitdummy</a></td></tr>
<tr><td style="background:${C.surface};border:1px solid ${C.line};border-radius:20px;overflow:hidden">
${opts.celebrate ? checkerStrip() : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${center}" style="padding:${opts.celebrate ? "30px 28px 30px" : "28px 28px 26px"};text-align:${center}">
${celebration}${eyebrow}${heading}${sub}
${opts.paragraphs.map(p).join("\n")}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${center}" style="margin:10px ${opts.celebrate ? "auto" : "0"} 0"><tr><td style="border-radius:12px;background:${C.accent}">
<a href="${url}" style="display:inline-block;padding:14px 24px;font-size:16px;font-weight:600;line-height:1.2;color:#ffffff;text-decoration:none;border-radius:12px">${escapeHtml(opts.action.label)}</a>
</td></tr></table>
</td></tr></table>
</td></tr>
<tr><td style="padding:18px 8px 0;font-size:13px;line-height:1.55;color:${C.ink2}">
<p style="margin:0 0 10px">Button not working? Paste this link into your browser:<br><a href="${url}" style="color:${C.ink2};word-break:break-all">${url}</a></p>
<p style="margin:0">${escapeHtml(opts.footer)}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
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

export function notificationEmail(opts: {
  kind?: string;
  projectName?: string;
  summary: string;
  lines?: string[];
  projectUrl: string;
}): EmailContent {
  const footer = "You're receiving this because you're a member of this Splitdummy group.";
  const lines = opts.lines ?? [];
  const body = lines.length > 0 ? `\n\n${lines.map((l) => `- ${l}`).join("\n")}` : "";

  if (opts.kind === "ROUND_SETTLED") {
    // The end of the journey: worth a moment of celebration rather than a status line.
    const subject = `🏁 ${opts.summary}`.slice(0, 160);
    const sub = opts.projectName ? `${opts.projectName} is squared away.` : opts.summary;
    const intro = "Every payment is done and confirmed, so nobody owes anyone anything. Nice work, everyone.";
    const label = "See the summary";
    return {
      subject,
      text: `All settled.\n\n${sub}\n\n${intro}${body}\n\n${label}: ${opts.projectUrl}\n\n${footer}\n`,
      html: layout({
        celebrate: true,
        heading: "All settled.",
        sub,
        preheader: intro,
        paragraphs: [intro, ...lines],
        action: { label, url: opts.projectUrl },
        footer,
      }),
    };
  }

  const subject = `Splitdummy: ${opts.summary}`.slice(0, 160);
  return {
    subject,
    text: `${opts.summary}${body}\n\nOpen the group: ${opts.projectUrl}\n\n${footer}\n`,
    html: layout({
      ...(opts.projectName ? { eyebrow: opts.projectName } : {}),
      heading: opts.summary,
      paragraphs: lines,
      action: { label: "Open the group", url: opts.projectUrl },
      footer,
    }),
  };
}

export function memberInviteEmail(opts: { inviterName: string; projectName: string; displayName: string; url: string; expiresAt: string }): EmailContent {
  const subject = `${opts.inviterName} invited you to “${opts.projectName}” on Splitdummy`.slice(0, 160);
  const intro = `${opts.inviterName} added you to “${opts.projectName}” as ${opts.displayName} to share expenses.`;
  const footer = `This invitation works until ${opts.expiresAt.slice(0, 10)} (UTC). Joining confirms this email address. If you weren't expecting it, you can ignore this email.`;
  const label = `Join ${opts.projectName}`.slice(0, 60);
  return {
    subject,
    text: `${intro}\n\n${label}: ${opts.url}\n\n${footer}\n`,
    html: layout({ heading: subject, paragraphs: [intro], action: { label, url: opts.url }, footer }),
  };
}
