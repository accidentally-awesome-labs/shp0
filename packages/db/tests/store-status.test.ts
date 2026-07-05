import { describe, it, expect } from "vitest";

import { transitionStoreStatus } from "../src/store-status";

/**
 * Issue #16 — Store status state machine (deep module, pure function).
 *
 * States: active → suspended → terminated.
 * - active → suspended (operator suspends for ToS violation)
 * - suspended → active (operator reinstates)
 * - suspended → terminated (operator terminates)
 * - terminated is terminal (no transitions out)
 * - active → terminated is BLOCKED (must suspend first — two-step protection)
 *
 * Pure function — no I/O. Like the Order FSM, the reducer is unit-testable.
 */
describe("Store status state machine (Issue #16)", () => {
  // ── Cycle 1: active → suspended ──
  it("transitions active → suspended", () => {
    const result = transitionStoreStatus("active", "suspend");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("suspended");
  });

  // ── Cycle 2: suspended → active (reinstate) ──
  it("transitions suspended → active (reinstate)", () => {
    const result = transitionStoreStatus("suspended", "reinstate");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("active");
  });

  // ── Cycle 3: suspended → terminated ──
  it("transitions suspended → terminated", () => {
    const result = transitionStoreStatus("suspended", "terminate");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status).toBe("terminated");
  });

  // ── Cycle 4: active → terminated is BLOCKED (two-step protection) ──
  it("blocks active → terminated (must suspend first)", () => {
    const result = transitionStoreStatus("active", "terminate");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_transition");
  });

  // ── Cycle 5: terminated is terminal (no transitions out) ──
  it("blocks all transitions from terminated (terminal state)", () => {
    expect(transitionStoreStatus("terminated", "reinstate").ok).toBe(false);
    expect(transitionStoreStatus("terminated", "suspend").ok).toBe(false);
    expect(transitionStoreStatus("terminated", "terminate").ok).toBe(false);
  });
});
