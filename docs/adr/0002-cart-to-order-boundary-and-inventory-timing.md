# 0002 — Cart-to-Order Boundary and Inventory Timing

Date: 2026-07-01
Status: Accepted

## Context

An ecommerce platform must answer two coupled questions before any checkout code can be written: at what point does a Customer's selection stop being a Cart and become an Order, and at what point is Variant inventory actually decremented? These answers determine where oversell risk lives, how abandonment is handled, and what the concurrency fence looks like.

The choice is constrained by the isolation model: per ADR-0001, all tenant-scoped queries run inside a transaction-wrapped client that sets the Store GUC. That gives us a natural place to take row-locks on Variants atomically with a payment transition.

## Decision

1. A **Cart** is ephemeral, lightweight storage of Variant references and quantities. It holds no money and reserves no inventory. A Customer has at most one Cart per Store.
2. Checkout converts a Cart into an **Order**. The Order is created in `payment: pending`, `fulfillment: unfulfilled` (the open state). The Cart is then consumed.
3. Variant inventory is decremented **inside the payment transaction** — the same transaction-wrapped tenant client that transitions `payment: pending → paid`. Within that transaction, the affected Variants are read with a row-lock (e.g. `SELECT ... FOR UPDATE`) and their inventory is checked and decremented before the transition is committed.
4. If a Variant cannot cover the requested quantity at payment time, the payment is rejected/voided and the Order is not transitioned to `paid` (the Order remains `payment: pending` and is effectively cancelled for that attempt). No oversell is possible because the check-and-decrement is atomic under a row-lock within a single transaction.
5. Abandonment requires no special subsystem: an Order that never reaches `paid` simply remains open in `payment: pending`. Because no inventory was reserved, nothing needs to be restored. Stale unpaid Orders may be swept to a terminal state at the platform's discretion, but this is housekeeping, not a correctness requirement.

## Alternatives Considered

- **Reserve inventory at add-to-cart, restore on abandon/timeout.** Gives the cart an "honest" available number but introduces a reservation lifecycle: expiry timers, restoration sweeps, and a window across the expiry boundary where oversell can still occur. Adds significant operational complexity for marginal UX benefit.
- **Decrement inventory permanently at add-to-cart.** Simplest to reason about, but punishes abandoned carts (ghost stock-outs) and is operationally naive. A Customer who adds the last unit and leaves would make it unavailable to real buyers.

## Consequences

- Oversell is prevented by construction: the only place inventory moves is inside the payment transaction, guarded by a row-lock. Two concurrent payments for the last unit serialize; the second sees the decremented quantity and is rejected.
- The Cart has no backend integrity obligation around stock — it stays a simple key-value object, keeping the cart module small and fast.
- The concurrency fence is the payment transaction; there is no separate reservation table or expiry scheduler to build or maintain.
- A Customer may reach checkout and discover a Variant is sold out only at payment time (if stock ran out between viewing the product and paying). This is an accepted, standard trade-off; the loss is a clear, recoverable "sold out" message rather than an oversold order.
- This decision composes cleanly with ADR-0001: inventory decrement runs inside the transaction-wrapped tenant client, so it inherits Store-scoped RLS and atomicity for free.
