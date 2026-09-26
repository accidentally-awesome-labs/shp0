#!/usr/bin/env node
// Closure guard: an issue closed as "completed" must have been closed by a
// merged pull request. Anything else is reopened with a comment explaining why.
//
// Rules (v1):
//   - completed (or no reason): the closer must be a merged PR, or a commit that
//     belongs to a merged PR. Otherwise reopen.
//   - not planned: needs a `wontfix` or `superseded` label. Otherwise reopen.
//   - duplicate: allowed.
//   - Issues labelled kind:decision, kind:research or closure-guard:exempt are
//     exempt: they are closed by a decision or a write-up, not by code.
//
// Modes: GITHUB_EVENT_NAME=issues checks the closed issue from the event;
// schedule / workflow_dispatch sweeps issues closed in the last LOOKBACK_HOURS.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXEMPT_LABELS = ["kind:decision", "kind:research", "closure-guard:exempt"];
export const NOT_PLANNED_LABELS = ["wontfix", "superseded"];
export const REOPENED_LABEL = "closure-guard:reopened";

const ISSUE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      state
      stateReason
      labels(first: 100) { nodes { name } }
      timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) {
        nodes {
          ... on ClosedEvent {
            closer {
              __typename
              ... on PullRequest { number merged }
              ... on Commit { oid associatedPullRequests(first: 5) { nodes { number merged } } }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Pure decision. `issue` is the GraphQL issue node from ISSUE_QUERY.
 * Returns { action: "allow" | "reopen" | "skip", reason }.
 */
export function decide(issue) {
  if (!issue || issue.state !== "CLOSED") return { action: "skip", reason: "not closed" };

  const labels = (issue.labels?.nodes ?? []).map((l) => l.name);
  const exempt = labels.find((l) => EXEMPT_LABELS.includes(l));
  if (exempt) return { action: "allow", reason: `exempt label ${exempt}` };

  const stateReason = issue.stateReason ?? "COMPLETED";
  if (stateReason === "DUPLICATE") return { action: "allow", reason: "closed as duplicate" };

  if (stateReason === "NOT_PLANNED") {
    const ok = labels.find((l) => NOT_PLANNED_LABELS.includes(l));
    return ok
      ? { action: "allow", reason: `not planned with label ${ok}` }
      : {
          action: "reopen",
          reason:
            "Closed as not planned without a `wontfix` or `superseded` label. " +
            "Add one of those labels first, then close it as not planned.",
        };
  }

  const closer = issue.timelineItems?.nodes?.[0]?.closer ?? null;
  if (closer?.__typename === "PullRequest" && closer.merged) {
    return { action: "allow", reason: `closed by merged PR #${closer.number}` };
  }
  if (closer?.__typename === "Commit") {
    const pr = (closer.associatedPullRequests?.nodes ?? []).find((p) => p.merged);
    if (pr) return { action: "allow", reason: `closed by a commit from merged PR #${pr.number}` };
  }

  const how =
    closer?.__typename === "PullRequest"
      ? `PR #${closer.number}, which is not merged`
      : closer?.__typename === "Commit"
        ? `commit ${String(closer.oid).slice(0, 7)}, which is not part of a merged PR`
        : "hand, with no linked pull request";
  return {
    action: "reopen",
    reason:
      `Closed as completed by ${how}. Issues close as completed only when a merged PR ` +
      "closes them (`Fixes #<n>` in the PR). If this issue needs no code, label it " +
      "`kind:decision`, `kind:research` or `closure-guard:exempt` before closing, or close it " +
      "as not planned with a `wontfix` or `superseded` label.",
  };
}

export function createClient({ token, fetchImpl = fetch, apiUrl = "https://api.github.com" }) {
  async function request(method, path, body) {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
    return data;
  }
  return {
    request,
    async graphql(query, variables) {
      const data = await request("POST", "/graphql", { query, variables });
      if (data?.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(data.errors)}`);
      return data.data;
    },
  };
}

export async function checkIssue(client, { owner, name, number }, log = console.log) {
  const data = await client.graphql(ISSUE_QUERY, { owner, name, number });
  const issue = data?.repository?.issue;
  const verdict = decide(issue);
  log(`#${number}: ${verdict.action} (${verdict.reason})`);
  if (verdict.action !== "reopen") return verdict;

  const base = `/repos/${owner}/${name}/issues/${number}`;
  await client.request("PATCH", base, { state: "open" });
  await client.request("POST", `${base}/comments`, {
    body: `Reopened by the closure guard.\n\n${verdict.reason}`,
  });
  try {
    await client.request("POST", `${base}/labels`, { labels: [REOPENED_LABEL] });
  } catch (error) {
    // The reopen and comment are what matter; a label failure is only logged.
    log(`#${number}: could not add ${REOPENED_LABEL}: ${error.message}`);
  }
  return verdict;
}

export async function sweep(client, { owner, name, sinceIso }, log = console.log) {
  const results = [];
  for (let page = 1; page <= 10; page++) {
    const items = await client.request(
      "GET",
      `/repos/${owner}/${name}/issues?state=closed&since=${encodeURIComponent(sinceIso)}` +
        `&sort=updated&direction=desc&per_page=100&page=${page}`,
    );
    for (const item of items) {
      if (item.pull_request) continue; // the issues API also lists PRs
      // `since` filters on updated_at; keep only issues actually closed in the window.
      if (!item.closed_at || Date.parse(item.closed_at) < Date.parse(sinceIso)) continue;
      results.push(await checkIssue(client, { owner, name, number: item.number }, log));
    }
    if (items.length < 100) break;
  }
  return results;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const [owner, name] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  if (!token || !owner || !name) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  const client = createClient({ token, apiUrl: process.env.GITHUB_API_URL ?? undefined });

  if (process.env.GITHUB_EVENT_NAME === "issues") {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    await checkIssue(client, { owner, name, number: event.issue.number });
    return;
  }
  const hours = Number(process.env.LOOKBACK_HOURS || 7);
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const results = await sweep(client, { owner, name, sinceIso });
  console.log(`swept ${results.length} issue(s) closed since ${sinceIso}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
