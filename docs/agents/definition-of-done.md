# Definition of done

A change is done when it is **merged to `main` through a pull request with green CI**,
and the evidence for it is a test, not a description. An issue closes when that
PR merges with `Fixes #<n>`, never by hand.

This page separates what is enforced by tooling today from the rules agents and
people are expected to follow. Do not describe a rule as enforced unless a check
or setting enforces it.

## Enforced today

| Check | Where | What it stops |
| --- | --- | --- |
| CI: frozen install leaves the tree clean, banned patterns, CI script self-tests, typecheck, unit tests, production build | `.github/workflows/ci.yml` | Broken installs, `db:push`, focused tests, `applySchema()` outside tests, type errors, broken builds |
| Closure guard | `.github/workflows/closure-guard.yml` | Issues closed as completed without a merged PR (reopened); not-planned closes without `wontfix` or `superseded` |
| Code owners | `.github/CODEOWNERS` | Security-sensitive paths get a review request from their owner |

The Postgres integration suites (`packages/db/tests/*-integration.test.ts`,
`isolation`, `provisioning`, `products`, `storefront`, `resolution`,
`packages/auth/tests`) are **not in CI yet**. On an empty database they fail at
setup, because `applySchema()` creates `memberships` before the `"user"` table it
references. In Claude Code on the web the SessionStart hook provisions Postgres
for them; the bootstrap bug still has to be fixed before they can pass there or
join CI.

## Expected of every change (not yet machine-checked)

1. **Defect fixes start with a failing test.** The test fails on `main` for the
   reported symptom and passes on the branch. Say which test in the PR.
2. **Evidence is reproducible.** Name the command and paste or link its output.
   Never cite a commit, branch, file or ADR that is not on `origin`.
3. **No type assertions on external SDK parameters** (for example
   `as Stripe.Checkout.SessionCreateParams`). Use `satisfies` so the compiler
   checks the shape.
4. **Every tenant read or write goes through `tenantClient` with a Store id the
   caller is authorized for.** Row-level security scopes to whatever Store id it
   is given; it does not check who is asking.
5. **Agents do not close issues, apply triage labels or merge.** They open PRs.
6. **Security-sensitive paths** (see `.github/CODEOWNERS`) need the code owner's
   review before merge.

## Planned

Tracked as issues, not yet in place: branch protection on `main` (required
checks, code-owner review, no direct pushes), a separate GitHub identity for
agent PRs, integration tests from an empty database in CI, and one failing test
per known defect.
