/**
 * Store status state machine (Issue #16).
 *
 * States: active → suspended → terminated.
 *
 * Transitions (two-step protection — can't terminate without suspending first):
 *   active → suspended     (suspend)
 *   suspended → active      (reinstate)
 *   suspended → terminated  (terminate)
 *
 * terminated is terminal — no transitions out.
 * active → terminated is BLOCKED (must suspend first).
 *
 * Pure function — no I/O. Like the Order FSM (#9), the reducer is unit-testable.
 */

export type StoreStatus = "active" | "suspended" | "terminated";
export type StoreEvent = "suspend" | "reinstate" | "terminate";

export type StoreStatusResult =
  | { ok: true; status: StoreStatus }
  | { ok: false; reason: "invalid_transition" };

/** Allowed transitions: [fromStatus][event] → toStatus */
const TRANSITIONS: Partial<Record<StoreStatus, Partial<Record<StoreEvent, StoreStatus>>>> = {
  active: {
    suspend: "suspended",
    // terminate is deliberately absent — two-step protection
  },
  suspended: {
    reinstate: "active",
    terminate: "terminated",
  },
  // terminated: no transitions out (terminal)
};

/**
 * Attempt a store status transition.
 * Pure function — returns the new status or an error if the transition is invalid.
 */
export function transitionStoreStatus(
  current: StoreStatus,
  event: StoreEvent,
): StoreStatusResult {
  const target = TRANSITIONS[current]?.[event];
  if (!target) {
    return { ok: false, reason: "invalid_transition" };
  }
  return { ok: true, status: target };
}
