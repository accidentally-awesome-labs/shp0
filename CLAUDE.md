## Agent skills

### Issue tracker

Issues live in GitHub Issues — use the `gh` CLI, or the GitHub MCP tools where `gh` is not installed (Claude Code on the web). See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — a `CONTEXT.md` and `docs/adr/` live at the repo root. See `docs/agents/domain.md`.

### Definition of done

Work is done when a PR merges to `main` with green CI and test evidence; a merged PR with `Fixes #<n>` closes the issue. Never close issues by hand, and never cite commits, branches or ADRs that are not on `origin`. See `docs/agents/definition-of-done.md`.
