# 0005 — Custom Domain Verification and Lifecycle

Date: 2026-07-01
Status: Accepted

## Context

A Store is served by default on its Subdomain (`<name>.shp0.dev`), which requires no setup. Merchants also want to point a domain they own (a Custom Domain) at their Store. This is a security-sensitive capability: if any Merchant could claim any domain, an attacker could map a domain they do not own to their Store and intercept traffic intended for the real owner, or impersonate a legitimate store.

The platform resolves the Current Store from the request host (per the request-resolution decision). That resolution is only as trustworthy as the mapping it reads from — so the integrity of the host-to-store mapping is a security boundary, not a convenience feature. This ADR defines how a Custom Domain's ownership is proven and how its serving lifecycle is maintained.

## Decision

1. **DNS-based proof of control.** Before a Custom Domain is served, the Merchant must prove they control its DNS:
   - Subdomains (e.g. `shop.acme.com`): a `CNAME` record pointing at the platform.
   - Apex domains (e.g. `acme.com`): a `TXT` record the platform provides, since apex records often cannot use CNAME. The platform supports both apex and subdomain Custom Domains and auto-detects which the Merchant configured, guiding them accordingly.
2. **Verify at setup, then re-verify periodically.** A Custom Domain's verification is not a one-time gate. The platform re-checks DNS on a schedule. Each Custom Domain has a verification state: `pending`, `verified`, or `failed`.
3. **Stop serving on failure.** A Custom Domain whose re-verification fails (DNS no longer points at the platform) transitions out of `verified` and is no longer served as that Store. This closes the domain-expiry-takeover hole: if a domain lapses and is re-registered by someone else, the platform stops mapping it to the old Store once DNS no longer validates.
4. **Cache invalidation is part of the lifecycle.** The host-to-store map is cached (in KV) for fast tenant resolution. Whenever a Custom Domain is added, removed, verified, or fails verification, its cache entry is invalidated so the storefront reflects the change promptly.
5. **Vercel is orchestrated, not reimplemented.** The platform delegates TLS certificate issuance and HTTP serving to Vercel (wildcard TLS covers the Subdomain; per-domain certs are issued when a verified Custom Domain is added to the project). The platform's responsibility is verification, the host-to-store mapping, and cache lifecycle — not building certificate infrastructure.

## Alternatives Considered

- **Meta-tag or file-upload verification.** Proves the applicant can serve HTTP on the host, not that they control DNS. Weaker for the "point a domain at us" model and does not compose with DNS-based serving. Rejected.
- **Verify once at setup, serve forever.** Simpler, but leaves the platform open to serving a Store under a domain whose control was later lost (expiry, transfer). Rejected on security grounds.
- **Build our own TLS/serving layer.** Unnecessary; Vercel already issues per-domain certificates and serves custom domains. Rejected to avoid infrastructure the platform does not need to own.

## Consequences

- An attacker cannot map a domain they do not control to a Store: serving requires current DNS control, re-checked over time.
- Custom Domain setup is a two-step, DNS-dependent process for the Merchant (configure DNS, then verify), which is an accepted, standard trade-off. Subdomains remain zero-setup.
- Apex and subdomain Custom Domains are both supported, at the cost of two verification paths handled by the same lifecycle.
- The platform holds a verification state per Custom Domain and a re-verification job; a failing domain is taken out of service automatically.
- Cache invalidation is a first-class part of the domain lifecycle: the tenant-resolution cache must be updated on every domain lifecycle change, or a removed/failing domain could continue serving the wrong Store.
- This composes with the request-resolution model: only verified hosts resolve to a Store; unverified or unknown hosts do not resolve (no Current Store).
