/**
 * Id shapes (pure, no I/O).
 *
 * Every id the database mints (Stores, Variants, Orders, cart tokens) is a
 * UUID. Values that arrive from a request (a URL segment, a server action
 * argument, a cookie) are checked against this shape before they reach SQL,
 * so a malformed one is answered like an unknown one instead of raising
 * Postgres error 22P02.
 */

/** A UUID in its canonical 8-4-4-4-12 hex form, in either case. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a string holding a UUID (see UUID_PATTERN). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
