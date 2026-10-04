/** Plain (ungrouped, "."-separated) decimal rendering of minor units for audit summaries and CSV. */
export function minorToDecimal(minor: bigint | string, exponent: number): string {
  const value = typeof minor === "string" ? BigInt(minor) : minor;
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(exponent + 1, "0");
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? "" : `.${digits.slice(-exponent)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

export const money = (minor: bigint | string, exponent: number, currency: string) =>
  `${minorToDecimal(minor, exponent)} ${currency}`;
