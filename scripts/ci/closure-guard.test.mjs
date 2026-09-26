import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, checkIssue, sweep, createClient, REOPENED_LABEL } from "./closure-guard.mjs";

const issue = ({ state = "CLOSED", stateReason = "COMPLETED", labels = [], closer = null } = {}) => ({
  number: 7,
  state,
  stateReason,
  labels: { nodes: labels.map((name) => ({ name })) },
  timelineItems: { nodes: closer === undefined ? [] : [{ closer }] },
});
const pr = (number, merged) => ({ __typename: "PullRequest", number, merged });
const commit = (...prs) => ({
  __typename: "Commit",
  oid: "abcdef1234567",
  associatedPullRequests: { nodes: prs },
});

test("completed: allowed only when a merged PR (or its commit) closed it", () => {
  assert.equal(decide(issue({ closer: pr(12, true) })).action, "allow");
  assert.equal(decide(issue({ closer: commit({ number: 12, merged: true }) })).action, "allow");
  assert.equal(decide(issue({ closer: pr(12, false) })).action, "reopen");
  assert.equal(decide(issue({ closer: commit() })).action, "reopen");
  assert.equal(decide(issue({ closer: commit({ number: 3, merged: false }) })).action, "reopen");
  assert.equal(decide(issue({ closer: null })).action, "reopen");
  assert.equal(decide(issue({ closer: undefined })).action, "reopen");
});

test("a missing state reason is treated as completed", () => {
  assert.equal(decide(issue({ stateReason: null, closer: null })).action, "reopen");
  assert.equal(decide(issue({ stateReason: null, closer: pr(1, true) })).action, "allow");
});

test("not planned needs wontfix or superseded", () => {
  assert.equal(decide(issue({ stateReason: "NOT_PLANNED" })).action, "reopen");
  assert.equal(decide(issue({ stateReason: "NOT_PLANNED", labels: ["wontfix"] })).action, "allow");
  assert.equal(decide(issue({ stateReason: "NOT_PLANNED", labels: ["superseded"] })).action, "allow");
});

test("duplicates, exempt labels and open issues are left alone", () => {
  assert.equal(decide(issue({ stateReason: "DUPLICATE" })).action, "allow");
  for (const label of ["kind:decision", "kind:research", "closure-guard:exempt"]) {
    assert.equal(decide(issue({ labels: [label], closer: null })).action, "allow", label);
  }
  assert.equal(decide(issue({ state: "OPEN" })).action, "skip");
  assert.equal(decide(null).action, "skip");
});

test("reopen reason says how it was closed", () => {
  assert.match(decide(issue({ closer: null })).reason, /by hand, with no linked pull request/);
  assert.match(decide(issue({ closer: pr(12, false) })).reason, /PR #12, which is not merged/);
  assert.match(decide(issue({ closer: commit() })).reason, /commit abcdef1, which is not part of a merged PR/);
});

function mockGitHub(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace("https://api.github.com", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    const handler = routes(init.method, path, body);
    const status = handler?.status ?? 200;
    const payload = handler?.body ?? {};
    return { ok: status < 400, status, text: async () => JSON.stringify(payload) };
  };
  return { calls, client: createClient({ token: "t", fetchImpl }) };
}

const graphqlFor = (node) => ({ body: { data: { repository: { issue: node } } } });

test("checkIssue reopens, comments and labels a hand-closed issue", async () => {
  const { calls, client } = mockGitHub((method, path) =>
    path === "/graphql" ? graphqlFor(issue({ closer: null })) : { body: {} },
  );
  const verdict = await checkIssue(client, { owner: "o", name: "r", number: 7 }, () => {});
  assert.equal(verdict.action, "reopen");
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      "POST /graphql",
      "PATCH /repos/o/r/issues/7",
      "POST /repos/o/r/issues/7/comments",
      "POST /repos/o/r/issues/7/labels",
    ],
  );
  assert.deepEqual(calls[1].body, { state: "open" });
  assert.match(calls[2].body.body, /^Reopened by the closure guard\./);
  assert.deepEqual(calls[3].body, { labels: [REOPENED_LABEL] });
  assert.deepEqual(calls[0].body.variables, { owner: "o", name: "r", number: 7 });
});

test("checkIssue does nothing but read when a merged PR closed the issue", async () => {
  const { calls, client } = mockGitHub(() => graphqlFor(issue({ closer: pr(12, true) })));
  const verdict = await checkIssue(client, { owner: "o", name: "r", number: 7 }, () => {});
  assert.equal(verdict.action, "allow");
  assert.deepEqual(calls.map((c) => c.method), ["POST"]);
});

test("sweep skips PRs and issues not closed inside the window", async () => {
  const since = "2026-09-26T12:00:00.000Z";
  const listing = [
    { number: 1, closed_at: "2026-09-26T13:00:00Z", pull_request: {} },
    { number: 2, closed_at: "2026-07-13T10:00:00Z" },
    { number: 3, closed_at: "2026-09-26T12:30:00Z" },
  ];
  const checked = [];
  const { client } = mockGitHub((method, path, body) => {
    if (path.startsWith("/repos/o/r/issues?")) return { body: listing };
    if (path === "/graphql") {
      checked.push(body.variables.number);
      return graphqlFor(issue({ closer: pr(9, true) }));
    }
    return { body: {} };
  });
  const results = await sweep(client, { owner: "o", name: "r", sinceIso: since }, () => {});
  assert.deepEqual(checked, [3]);
  assert.equal(results.length, 1);
});

test("API and GraphQL errors fail the run", async () => {
  const failing = mockGitHub(() => ({ status: 502, body: { message: "bad gateway" } }));
  await assert.rejects(
    checkIssue(failing.client, { owner: "o", name: "r", number: 7 }, () => {}),
    /POST \/graphql -> 502/,
  );
  const gqlError = mockGitHub(() => ({ body: { errors: [{ message: "nope" }] } }));
  await assert.rejects(
    checkIssue(gqlError.client, { owner: "o", name: "r", number: 7 }, () => {}),
    /GraphQL: .*nope/,
  );
});

test("a failed label call does not undo or fail the reopen", async () => {
  const logs = [];
  const { calls, client } = mockGitHub((method, path) => {
    if (path === "/graphql") return graphqlFor(issue({ closer: null }));
    if (path.endsWith("/labels")) return { status: 422, body: { message: "label error" } };
    return { body: {} };
  });
  const verdict = await checkIssue(client, { owner: "o", name: "r", number: 7 }, (m) => logs.push(m));
  assert.equal(verdict.action, "reopen");
  assert.equal(calls[1].method, "PATCH");
  assert.match(logs.at(-1), /could not add closure-guard:reopened/);
});

test("the CLI entry point reads the event and talks to GITHUB_API_URL", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/graphql") {
        res.end(JSON.stringify({ data: { repository: { issue: issue({ closer: null }) } } }));
      } else {
        res.end("{}");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "closure-guard-"));
  try {
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({ action: "closed", issue: { number: 42 } }));
    const script = join(dirname(fileURLToPath(import.meta.url)), "closure-guard.mjs");
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        GITHUB_TOKEN: "test-token",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_EVENT_NAME: "issues",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0, output);
    assert.match(output, /#42: reopen/);
    assert.deepEqual(seen, [
      "POST /graphql Bearer test-token",
      "PATCH /repos/o/r/issues/42 Bearer test-token",
      "POST /repos/o/r/issues/42/comments Bearer test-token",
      "POST /repos/o/r/issues/42/labels Bearer test-token",
    ]);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
