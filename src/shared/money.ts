/**
 * Splitdummy accounting core — CONTRACT.
 *
 * Pure, deterministic, BigInt-only. Shared by the Durable Object (authority)
 * and the web client (previews). Never use binary floating point for money.
 *
 * Conventions:
 * - "minor" amounts are bigint integer minor units (cents, yen, fils).
 * - In JSON they travel as decimal strings ("12345", "-500").
 * - Rates are base major units per ONE original major unit ("1 EUR = 4.30 PLN" → rate "4.30").
 * - Member IDs are opaque strings; tie-breaks use ascending lexicographic member ID.
 *
 * Every function below is implemented in src/shared/money/*.ts and re-exported here.
 */

export * from "./money/currencies";
export * from "./money/amount";
export * from "./money/rate";
export * from "./money/split";
export * from "./money/ledger";
export * from "./money/settlement";
