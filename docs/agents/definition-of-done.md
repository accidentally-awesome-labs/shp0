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
| CI `integration` job: the full `packages/db` suite, then the `packages/auth` suite, against a Postgres 16 service starting from an empty `shp0_test` (non-superuser `cloud_admin` and `default` roles) | `.github/workflows/ci.yml` | An `applySchema()` that cannot bootstrap an empty database or is not idempotent; regressions in RLS isolation, Store provisioning, payments, auth and the other Postgres-backed paths |
| Closure guard | `.github/workflows/closure-guard.yml` | Issues closed as completed without a merged PR (reopened); not-planned closes without `wontfix` or `superseded` |
| Code owners | `.github/CODEOWNERS` | Security-sensitive paths get a review request from their owner |

To run the integration suites outside CI, provision what the `Provision test
database` step in `ci.yml` does (the two roles and `shp0_test`); in Claude Code
on the web, `.claude/hooks/session-start.sh` does this at session start.

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
agent PRs, and one failing test per known defect.
