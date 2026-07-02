# 0004 — Money as Integer Minor Units, Never Floating-Point

Date: 2026-07-01
Status: Accepted

## Context

The platform deals with money constantly — Variant prices, Order totals, fees, refunds. The representation of money is a pervasive, foundational choice that is extremely hard to reverse once data exists: every price, total, and historical Order record is affected, and a wrong choice produces the most damaging class of bug in ecommerce — incorrect charges and totals that erode merchant and shopper trust.

Floating-point numbers cannot represent most decimal currency values exactly. A price of $19.99 stored as the IEEE-754 double `19.99` is actually `19.989999999999998…`. Across the sums, taxes, discounts, and multi-line totals an Order requires, these representation errors accumulate, and the amount a Customer is charged drifts from the amount recorded against the Order. At scale this becomes a real accounting and trust problem.

## Decision

Represent all monetary amounts as **signed integers in minor units** of the relevant Currency, end to end.

1. Storage: every monetary column holds an integer count of the Currency's smallest unit (e.g. cents). `$19.99` is stored as `1999`.
2. Computation: all money arithmetic (quantity multiplication, tax, discount, line sums, order totals, refunds) is integer math. No floating-point is used in any calculation.
3. Currency awareness: the number of decimal places a Currency uses is defined by ISO 4217 (e.g. USD = 2, JPY = 0, KWD = 3). Converting between a display decimal value and minor units uses that exponent. The platform supports this generally but ships fully featured for 2-decimal currencies first; 0- and 3-decimal currencies work via the same ISO table.
4. Edges only: a pure `money` helper converts at the boundaries — parsing a form input string into minor units, and formatting minor units into a display string. Floating-point may appear transiently inside those two conversions; it never enters the data model or business arithmetic.
5. Each Store has exactly one Currency (ISO 4217 code), chosen at Store creation. All Money in that Store is expressed in that Currency's minor units. Multi-currency is out of scope for the initial build.

## Alternatives Considered

- **Postgres `numeric` / `DECIMAL` (fixed-point decimal).** This is also exact and is a legitimate alternative. Rejected here for a single, consistent representation rule across the database, the TypeScript domain layer, and the network boundary (Server Action payloads): integers require no scale/precision negotiation between layers, serialize trivially as JSON numbers, and make the "no floats in arithmetic" invariant mechanically checkable. (A `numeric`-based design would still require the TS layer to avoid floats, so the integer rule is adopted uniformly.)
- **Floating-point.** Rejected: it cannot represent decimal currency values exactly, and accumulation across totals causes incorrect charges.

## Consequences

- Totals are exact by construction; a Customer is charged exactly the sum of what they were shown.
- The representation is uniform across DB, domain, and wire: every layer speaks integer minor units, so there is no scale/precision conversion to get wrong at a boundary.
- Money must never be read or written as a float except inside the two edge conversions (parse input, format display). This invariant is enforceable and should be tested.
- Currency-specific formatting (0/2/3 decimal places, symbols) is centralized in the money helper; call sites pass `(minorUnits, currency)` and receive a correct display string.
- Multi-currency is deferred; a Store's Currency is fixed per Store for the initial build. Changing a Store's Currency after Orders exist would require a migration and is intentionally not supported initially.
