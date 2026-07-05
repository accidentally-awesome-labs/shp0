import { describe, it, expect } from "vitest";

import { transitionDomainVerification } from "../src/domain-verification";

/**
 * Issue #14 — Custom Domain verification state machine (deep module, pure function).
 *
 * Per ADR-0005: DNS-based proof of control, re-verified periodically.
 * THE SECURITY GATE: verified → failed STOPS SERVING a domain (closes the
 * domain-expiry-takeover hole).
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
describe("Custom Domain verification state machine (Issue #14)", () => {
  // ── Cycle 1: pending → verified ──
  it("transitions pending → verified when DNS check passes", () => {
    const result = transitionDomainVerification("pending", "dns_ok");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("verified");
  });

  // ── Cycle 2: pending → failed ──
  it("transitions pending → failed when DNS check fails", () => {
    const result = transitionDomainVerification("pending", "dns_fail");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("failed");
  });

  // ── Cycle 3: verified → failed (THE SECURITY GATE) ──
  it("transitions verified → failed on re-verify failure (STOP SERVING)", () => {
    const result = transitionDomainVerification("verified", "dns_fail");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("failed");
  });

  // ── Cycle 4: failed → pending (retry) ──
  it("transitions failed → pending when merchant retries", () => {
    const result = transitionDomainVerification("failed", "retry");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("pending");
  });

  // ── Cycle 5: verified → verified is a no-op ──
  it("keeps verified → verified on re-verify success (no-op)", () => {
    const result = transitionDomainVerification("verified", "dns_ok");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("verified");
  });
});
