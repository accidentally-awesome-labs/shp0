# 0001 — Postgres Row-Level Security for Multi-Tenant Isolation

Date: 2026-07-01
Status: Accepted

## Context

The platform hosts many Stores (tenants) in a single Postgres database (Neon serverless). The non-negotiable requirement is that one Store's data can never be read or modified by another Store — not by convention, but as an invariant the database itself enforces. A single missed `WHERE store_id = ?` filter in the application layer must not be able to leak data.

This builds on the term resolution that a **Store** is the unit of tenancy, and that **Customers** are scoped to a single Store while **Merchants** are a cross-Store identity.

## Decision

Enforce tenant isolation with **Postgres Row-Level Security (RLS)**, keyed on a session-scoped custom GUC `app.store_id`, with a fail-closed client.

1. Every tenant table carries a non-null `store_id` column.
2. A dedicated role runs as the tenant role and is the *only* role permitted to touch tenant tables directly. A scoped client sets the tenant before any query:
   - `tenantClient(storeId)` opens a transaction (`BEGIN`), sets `SET LOCAL app.store_id = <id>`, yields a client whose reads/writes run inside that transaction, then commits/rolls back. Setting the GUC is therefore structurally inseparable from executing the query.
   - It is the **only** path for tenant-scoped queries. There is no unscoped tenant client.
3. RLS policies on every tenant table enforce, for the tenant role:
   - `SELECT/UPDATE/DELETE`: `current_setting('app.store_id', true) = store_id::text`
   - `INSERT`: the row's `store_id` must equal `current_setting('app.store_id', true)`
4. The policy is **fail-closed**: when `app.store_id` is unset, `current_setting(..., true)` returns NULL/empty, which matches **zero** rows. A code path that somehow bypasses `tenantClient` returns nothing rather than everything.
5. A separate elevated role (`cloud_admin`, inheriting NextFaster's naming) bypasses RLS and is used exclusively for cross-Store platform operations via `platformClient()`. It is never used to serve a single Store.

## Alternatives Considered

- **Per-request GUC set in middleware on a pinned connection.** Rejected: connection pinning fights Neon's transaction pooling, and any unpooled/pooled query loses the GUC and silently leaks.
- **Application-layer `WHERE store_id = X` filtering, no RLS.** Rejected: isolation becomes a convention. A single missed filter leaks a Store's data. This defeats the core invariant that the database itself enforces isolation.
- **Database-per-tenant.** Rejected at this stage: maximal isolation but high operational overhead (migration fan-out, cross-Store platform queries become hard). Single-DB-with-RLS keeps operational simplicity now; per-tenant databases or sharding remain possible later without changing the application's tenant-scoped interface.

## Consequences

- Isolation is a database invariant, not an application convention. The database refuses to return or write cross-Store rows under any code path that honors the tenant-client contract.
- Every tenant query incurs one `BEGIN`/`SET LOCAL`/`COMMIT` — a negligible cost on Neon, and the price of the invariant.
- The application's data layer exposes exactly two clients (`tenantClient`, `platformClient`); the scoped client is the only tenant path, making misuse structurally difficult.
- Platform-wide queries (analytics, operator admin) must go through the elevated role and `platformClient`, never through tenant clients.
- The invariant must be proven: integration tests must assert that `tenantClient(A)` cannot read or write Store B's rows in every tenant table, and that inserts stamp the correct `store_id`.
- This interacts with the identity model: **Customers** are Store-scoped rows protected by these policies, while **Merchants** are a cross-Store identity managed outside the per-Store policies. The identity split is recorded separately.
