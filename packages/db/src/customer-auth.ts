/**
 * Customer auth helpers (Issue #13).
 *
 * Password hashing uses Node's built-in scrypt (no new deps).
 * Customer identity is per-Store and RLS-scoped — unlike Merchant identity
 * (global, better-auth), a Customer exists in exactly one Store.
 */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Hash a password using scrypt.
 * Returns a string in the format "salt:hash" (both hex-encoded).
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a stored hash.
 * Constant-time comparison (timingSafeEqual) to prevent timing attacks.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const hashBuf = Buffer.from(hash, "hex");
  const testBuf = scryptSync(password, salt, 64);
  if (hashBuf.length !== testBuf.length) return false;
  return timingSafeEqual(hashBuf, testBuf);
}
