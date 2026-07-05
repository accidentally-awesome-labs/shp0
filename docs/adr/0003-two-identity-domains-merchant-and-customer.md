# 0003 — Two Identity Domains: Merchant and Customer

Date: 2026-07-01
Status: Accepted

## Context

The platform has two distinct populations of humans who need accounts: Merchants (who run Stores) and Customers (who buy from Stores). These must be modeled as separate identity domains, not one, because their scoping, trust, and lifecycle requirements are structurally different:

- A **Merchant** is global: they may manage multiple Stores (via Memberships), their identity must be resolvable cross-Store (for the store switcher, for platform admin), and their sessions are platform-scoped.
- A **Customer** is per-Store: their account, cart, orders, and addresses belong to exactly one Store and exist only within it. The same human may be a Customer on Store A and a Customer on Store B, with no relationship between those two identities — and may also be a Merchant, with no relationship to either Customer identity.

Combining them into a single identity table would force either a cross-Store join (breaking tenant isolation) or a `store_id` column on a table that is conceptually global (breaking the Merchant cross-Store use case). Neither is correct.

## Decision

1. **Two separate identity domains, two separate persistence layers.**
   - **Merchant** identity is global and cross-Store. It lives in the `user` / `session` / `account` / `verification` tables (better-auth's schema), managed by better-auth. These are PLATFORM tables — no `store_id`, no RLS. The connection uses the `cloud_admin` role (bypasses RLS).
   - **Customer** identity is per-Store. It lives in `customers` / `customer_sessions` / `addresses` tables. These are TENANT tables — they carry `store_id` and are RLS-protected. A Customer belongs to exactly one Store.

2. **A Customer is identified by `(email, store_id)`, not by email alone.** The pair is unique (`UNIQUE(store_id, email)`). The same email on Store A and Store B are two completely separate Customers with no shared state. This is enforced structurally by the unique constraint and by RLS (a Customer row is only ever visible within its Store's tenant context).

3. **Customer authentication is separate from Merchant authentication.** Customer auth uses scrypt password hashing (Node's built-in `node:crypto`, no external dependency) and session tokens stored in a per-Store `customer_sessions` table. Merchant auth uses better-auth. The two never share a session or a token. A Customer session cookie is distinct from a Merchant session cookie.

4. **Customer identity is scoped to one Store because all of a Customer's data is scoped to one Store.** The cart, orders, addresses, and (future) reviews all carry `store_id` and are RLS-protected. A Customer identity that spanned Stores would require cross-Store joins to load a cart or order history — which the isolation model (ADR-0001) forbids. Per-Store identity keeps every Customer query inside a single tenant transaction.

## Alternatives Considered

- **One unified identity table with a `type` discriminator.** Simpler to query, but forces a single table to be both global (for Merchants) and Store-scoped (for Customers). A Merchant row would need `store_id = null` (global) while a Customer row needs a concrete `store_id` — the same column serving two incompatible meanings. RLS policies would become ambiguous. Rejected.

- **Customer identity as a reference into the global user table, with per-Store profiles.** A single global "person" with per-Store customer profiles. This introduces a cross-Store join (profile → global person) on every customer query, breaking tenant isolation, and creates a single point of account compromise (one password compromise affects the person across all Stores). Rejected on isolation and security grounds.

- **Customer identity delegated to a third-party auth provider (e.g., email magic links via a global service).** Removes the password-management burden, but a third-party-issued identity is inherently global — it cannot be per-Store without a mapping table that re-introduces the cross-Store join. Also creates an external dependency for a per-Store concern. Rejected; may be revisited as an optional per-Store SSO strategy later.

## Consequences

- The same human is unknowable across Stores: the platform cannot tell that the Customer on Store A and the Customer on Store B are the same person, even if they use the same email. This is a deliberate privacy property, not a limitation — it is what makes per-Store isolation honest.
- Customer auth is self-contained: no dependency on better-auth for Customer sign-in, and no shared session machinery. A Merchant auth outage does not affect Customer sign-in, and vice versa.
- A Customer's identity is destroyed (cascade) when their Store is destroyed, because the `customers` table is tenant-scoped and cascades with the Store. A Merchant's identity survives Store deletion because it is global.
- This composes with ADR-0001: Customer queries run inside `tenantClient(storeId)`, so they inherit Store-scoped RLS and atomicity for free — a Customer's cart, orders, and addresses are all loaded in the same isolated transaction as their identity.
