/**
 * Structured operational logs. Never pass tokens, cookies, emails, or request/response
 * payloads here — only identifiers, op names, statuses, and error names.
 *
 * Objects, not JSON strings: Workers Logs indexes each field, so `requestId` etc. are filterable.
 */
type Fields = Record<string, string | number | boolean | null | undefined>;

export function logInfo(msg: string, fields: Fields = {}): void {
  console.log({ level: "info", msg, ...fields });
}

const EMAIL_RE = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g;

/** Replaces anything that looks like an email address. */
export const scrubEmails = (text: string) => text.replace(EMAIL_RE, "<email>");

export function logError(msg: string, err: unknown, fields: Fields = {}): void {
  // Upstream error messages (D1, Email Service) can echo addresses; scrub them.
  const error = scrubEmails(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  console.error({ level: "error", msg, error, ...fields });
}
