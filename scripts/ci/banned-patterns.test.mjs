// Self-tests for banned-patterns.mjs, including the negative fixture:
// re-adding a db:push script must make the check fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { scan } from "./banned-patterns.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "banned-patterns.mjs");

function scanFiles(files) {
  return scan(Object.keys(files), (file) => files[file]);
}

test("flags a db:push script and a drizzle-kit push call", () => {
  const violations = scanFiles({
    "packages/db/package.json": '{ "scripts": { "db:push": "drizzle-kit push" } }',
    ".github/workflows/deploy.yml": "      - run: npx drizzle-kit push",
  });
  assert.deepEqual(
    violations.map((v) => [v.file, v.rule]),
    [
      ["packages/db/package.json", "no-db-push"],
      [".github/workflows/deploy.yml", "no-db-push"],
    ],
  );
});

test("ignores db:push mentioned in Markdown", () => {
  assert.equal(scanFiles({ "docs/notes.md": "never run db:push" }).length, 0);
});

test("flags focused tests only in test files", () => {
  const violations = scanFiles({
    "packages/db/tests/cart.test.ts": 'it.only("x", () => {});\ndescribe.only("y", () => {});',
    "apps/web/lib/util.ts": "const x = obj.it.only(1);",
  });
  assert.deepEqual(
    violations.map((v) => [v.file, v.line, v.rule]),
    [
      ["packages/db/tests/cart.test.ts", 1, "no-focused-tests"],
      ["packages/db/tests/cart.test.ts", 2, "no-focused-tests"],
    ],
  );
});

test("allows applySchema() in tests, its definition and comments, but not in app code", () => {
  const violations = scanFiles({
    "packages/db/tests/isolation.test.ts": "await applySchema();",
    "packages/db/src/index.ts": "export async function applySchema(): Promise<void> {",
    "packages/db/src/schema.ts": "// share one schema source + applySchema().",
    "apps/web/app/actions/boot.ts": "await applySchema();",
  });
  assert.deepEqual(
    violations.map((v) => [v.file, v.rule]),
    [["apps/web/app/actions/boot.ts", "apply-schema-in-tests-only"]],
  );
});

test("exits 1 on a repo with a db:push script and 0 once it is removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "banned-patterns-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    mkdirSync(join(dir, "packages/db"), { recursive: true });
    const pkg = join(dir, "packages/db/package.json");
    writeFileSync(pkg, '{ "scripts": { "db:push": "drizzle-kit push" } }\n');
    git("add", "-A");

    const red = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stderr, /packages\/db\/package\.json:1: \[no-db-push\]/);

    writeFileSync(pkg, '{ "scripts": { "db:studio": "drizzle-kit studio" } }\n');
    git("add", "-A");
    const green = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(green.status, 0, green.stdout + green.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
