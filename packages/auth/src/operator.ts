/**
 * Operator (platform admin) authorization policy — Issue #52, decision #73.
 *
 * An Operator runs the platform itself: they can list every Store and suspend,
 * reinstate or terminate any of them. Being an Operator is not a Store Role and
 * comes from no Membership. It is granted by an allowlist of Merchant user ids
 * (better-auth `user.id`) in the SHP0_OPERATOR_USER_IDS environment variable.
 *
 * - User ids, never emails: Merchant emails are not verified, so an email
 *   allowlist would make whoever signs up with that address first an Operator.
 * - Fails closed: unset, empty or separator-only means nobody is an Operator.
 * - No wildcard: every entry is a literal id, matched exactly.
 *
 * Pure and dependency-free (no I/O, no environment reads) so it is safe to
 * import anywhere and is unit-tested without a database. Callers pass the raw
 * variable in. Never log the parsed allowlist.
 */

/** The environment variable holding the comma-separated Operator user ids. */
export const OPERATOR_USER_IDS_ENV = "SHP0_OPERATOR_USER_IDS";

/**
 * Parse the raw SHP0_OPERATOR_USER_IDS value into a set of user ids.
 * Splits on commas, trims whitespace and drops empty entries.
 */
export function parseOperatorUserIds(
  raw: string | null | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (typeof raw !== "string") return ids;
  for (const entry of raw.split(",")) {
    const id = entry.trim();
    if (id.length > 0) ids.add(id);
  }
  return ids;
}

/**
 * Whether `userId` is an Operator under the given allowlist. Exact,
 * case-sensitive match on the whole id; a missing or empty id never matches.
 */
export function isOperator(
  userId: string | null | undefined,
  operatorUserIds: ReadonlySet<string>,
): boolean {
  if (typeof userId !== "string" || userId.length === 0) return false;
  return operatorUserIds.has(userId);
}
