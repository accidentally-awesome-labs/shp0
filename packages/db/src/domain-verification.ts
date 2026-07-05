/**
 * Custom Domain verification state machine (Issue #14, ADR-0005).
 *
 * DNS-based proof of control, re-verified periodically. THE SECURITY GATE:
 * verified → failed STOPS SERVING a domain — closes the domain-expiry-takeover
 * hole (if a domain lapses and is re-registered, DNS stops validating and the
 * platform stops mapping it to the old Store).
 *
 * States: pending → verified → failed.
 * Transitions:
 *   pending → verified   (dns_ok — start serving)
 *   pending → failed     (dns_fail — never served)
 *   verified → failed    (dns_fail — STOP SERVING, the security gate)
 *   failed → pending     (retry — merchant re-attempts after fixing DNS)
 *   verified → verified  (dns_ok — no-op, already verified)
 *
 * Pure function — no I/O. Like the Order FSM and Store Status FSM.
 */

export type DomainVerificationStatus = "pending" | "verified" | "failed";
export type DomainVerificationEvent = "dns_ok" | "dns_fail" | "retry";

export type DomainVerificationResult =
  | { ok: true; status: DomainVerificationStatus }
  | { ok: false; reason: "invalid_transition" };

/** Allowed transitions: [fromStatus][event] → toStatus */
const TRANSITIONS: Partial<
  Record<DomainVerificationStatus, Partial<Record<DomainVerificationEvent, DomainVerificationStatus>>>
> = {
  pending: {
    dns_ok: "verified",
    dns_fail: "failed",
  },
  verified: {
    dns_ok: "verified", // no-op (already verified, re-verify passes)
    dns_fail: "failed", // THE SECURITY GATE — stop serving
  },
  failed: {
    retry: "pending", // merchant re-attempts after fixing DNS
  },
};

/**
 * Attempt a domain verification transition.
 * Pure function — returns the new status or an error if the transition is invalid.
 */
export function transitionDomainVerification(
  current: DomainVerificationStatus,
  event: DomainVerificationEvent,
): DomainVerificationResult {
  const target = TRANSITIONS[current]?.[event];
  if (!target) {
    return { ok: false, reason: "invalid_transition" };
  }
  return { ok: true, status: target };
}
