/**
 * ADR-0004 — Money as integer minor units, never floats.
 *
 * All monetary amounts in the platform are signed integers in minor units
 * (e.g. cents for USD). This module provides the two edge conversions
 * (parse input, format display) and one arithmetic helper (applyPercent),
 * all using pure integer math. No floating-point enters the data model.
 */

/** ISO 4217 decimal exponents (0 = no decimals, 2 = cents, 3 = fils). */
const EXPONENTS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  BHD: 3,
};

/** Currency symbols for display formatting. */
const SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  CAD: "$",
  AUD: "$",
  JPY: "¥",
  KRW: "₩",
  KWD: "د.ك",
  BHD: ".د.ب",
};

function exponent(currency: string): number {
  return EXPONENTS[currency] ?? 2;
}

function symbol(currency: string): string {
  return SYMBOLS[currency] ?? "";
}

/**
 * Parse a decimal string (e.g. "19.99", "$100") into integer minor units.
 *
 * Uses string splitting — no float — so there is zero representation error.
 */
export function parseMoney(input: string, currency: string): number {
  // Strip whitespace and common currency symbols.
  const cleaned = input.trim().replace(/^[$€£¥₩]/, "");

  // Must be a valid decimal (optional dot, digits on both sides or just one side).
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`Invalid money amount: "${input}"`);
  }

  const exp = exponent(currency);
  const [whole, frac = ""] = cleaned.split(".");
  const paddedFrac = frac.padEnd(exp, "0").slice(0, exp);
  const result = Number(whole!) * 10 ** exp + Number(paddedFrac);

  if (result < 0) throw new Error("Money amounts cannot be negative");
  return result;
}

/**
 * Format integer minor units into a display string with the currency symbol.
 *
 * Uses integer division/modulo — no float — so formatting is exact.
 */
export function formatMoney(minorUnits: number, currency: string): number | string {
  const exp = exponent(currency);
  const sym = symbol(currency);
  const divisor = 10 ** exp;

  if (exp === 0) return `${sym}${minorUnits}`;

  const whole = Math.floor(minorUnits / divisor);
  const frac = minorUnits % divisor;
  const fracStr = String(frac).padStart(exp, "0");
  return `${sym}${whole}.${fracStr}`;
}

/**
 * Apply a percentage to a minor-unit amount, rounding half-up.
 *
 * `basisPoints` is the percentage in basis points (100 = 1%, 1000 = 10%, 5000 = 50%).
 *
 * Pure integer math: `floor((amount * basisPoints + 5000) / 10000)`.
 * The +5000 (half of 10000) ensures round-half-up for positive values.
 */
export function applyPercent(
  amount: number,
  basisPoints: number,
): number {
  return Math.floor((amount * basisPoints + 5000) / 10000);
}
