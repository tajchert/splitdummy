/**
 * Structured operational logs. Never pass tokens, cookies, emails, or request/response
 * payloads here — only identifiers, op names, statuses, and error names.
 */
type Fields = Record<string, string | number | boolean | null | undefined>;

export function logInfo(msg: string, fields: Fields = {}): void {
  console.log(JSON.stringify({ level: "info", msg, ...fields }));
}

export function logError(msg: string, err: unknown, fields: Fields = {}): void {
  const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(JSON.stringify({ level: "error", msg, error, ...fields }));
}
