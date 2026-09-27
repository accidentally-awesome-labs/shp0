// Self-tests for operator-guard.mjs, including the negative fixtures: the
// guard as it was before Issue #52 (a local requireOperator that only checks
// for a session) and an action with its guard call removed must both fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkOperatorActions,
  checkOperatorHelperUse,
  OPERATOR_ACTIONS_FILE,
} from "./operator-guard.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "operator-guard.mjs");

const GUARDED = `"use server";

import { requireOperator } from "@/lib/operator";
import { listAllStoresForOperator, applyStoreStatusAction } from "@shp0/db";

export type StoreRow = { id: string };

function helper() {
  return 1;
}

export async function getAdminStores() {
  await requireOperator();
  return listAllStoresForOperator();
}

export async function suspendStoreAction(storeId: string) {
  const { userId } = await requireOperator();
  await applyStoreStatusAction(storeId, "suspend");
  return userId;
}
`;

const rules = (result) => result.violations.map((v) => v.rule);

test("accepts guarded async exports, type exports and private helpers", () => {
  const result = checkOperatorActions(GUARDED);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.guarded, ["getAdminStores", "suspendStoreAction"]);
});

test("flags the guard as it was before Issue #52: a local requireOperator", () => {
  const before = `"use server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { applyStoreStatusAction } from "@shp0/db";

async function requireOperator(): Promise<void> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Not authenticated");
  // TODO: check operator role/flag here.
}

export async function suspendStoreAction(storeId: string) {
  await requireOperator();
  await applyStoreStatusAction(storeId, "suspend");
}
`;
  const result = checkOperatorActions(before);
  assert.deepEqual(rules(result), ["guard-imported", "guard-not-redefined"]);
  assert.equal(result.violations[1].line, 6);
});

test("flags an export whose guard call was removed, moved down or not awaited", () => {
  const source = `import { requireOperator } from "@/lib/operator";
export async function removed(storeId: string) {
  await applyStoreStatusAction(storeId, "suspend");
}
export async function movedDown(storeId: string) {
  await applyStoreStatusAction(storeId, "suspend");
  await requireOperator();
}
export async function notAwaited(storeId: string) {
  requireOperator();
  await applyStoreStatusAction(storeId, "suspend");
}
export async function empty() {}
`;
  const result = checkOperatorActions(source);
  assert.deepEqual(
    result.violations.map((v) => [v.rule, v.line]),
    [
      ["guard-first", 2],
      ["guard-first", 5],
      ["guard-first", 9],
      ["guard-first", 13],
    ],
  );
  assert.deepEqual(result.guarded, []);
});

test("flags a requireOperator from another module, renamed, or shadowed", () => {
  const fromElsewhere = `import { requireOperator } from "@/lib/other";
export async function a() {
  await requireOperator();
}
`;
  assert.deepEqual(rules(checkOperatorActions(fromElsewhere)), [
    "guard-imported",
    "guard-not-redefined",
  ]);

  const renamed = `import { getOperatorAccess as requireOperator } from "@/lib/operator";
export async function a() {
  await requireOperator();
}
`;
  assert.deepEqual(rules(checkOperatorActions(renamed)), [
    "guard-imported",
    "guard-not-redefined",
  ]);

  const shadowed = `import { requireOperator } from "@/lib/operator";
export async function a(requireOperator: () => Promise<void>) {
  await requireOperator();
}
`;
  assert.deepEqual(rules(checkOperatorActions(shadowed)), ["guard-not-redefined"]);
});

test("flags runtime exports it cannot check: consts, defaults, re-exports, sync functions", () => {
  const source = `import { requireOperator } from "@/lib/operator";
export const a = async () => {
  await requireOperator();
};
export default async () => {};
export { b } from "./b";
export * from "./c";
export type { D } from "./d";
export function sync() {
  return 1;
}
`;
  assert.deepEqual(
    checkOperatorActions(source).violations.map((v) => [v.rule, v.line]),
    [
      ["export-shape", 2],
      ["export-shape", 5],
      ["export-shape", 6],
      ["export-shape", 7],
      ["export-shape", 9],
    ],
  );
});

test("flags operator-only @shp0/db helpers used anywhere else in apps/web", () => {
  const files = {
    [OPERATOR_ACTIONS_FILE]: GUARDED,
    "apps/web/app/actions/stores.ts":
      'import { applyStoreStatusAction } from "@shp0/db";\nexport async function x() {}\n',
    "apps/web/app/api/admin/route.ts":
      'import * as db from "@shp0/db";\nexport async function GET() {\n  return Response.json(await db.getPlatformAnalytics());\n}\n',
    "apps/web/app/admin/page.tsx":
      "// getAdminStores() wraps listAllStoresForOperator behind requireOperator().\nexport default function Page() {}\n",
    "apps/web/README.md": "listAllStoresForOperator",
  };
  const violations = checkOperatorHelperUse(Object.keys(files), (file) => files[file]);
  assert.deepEqual(
    violations.map((v) => [v.file, v.line, v.rule]),
    [
      ["apps/web/app/actions/stores.ts", 1, "operator-helper-outside-guard"],
      ["apps/web/app/api/admin/route.ts", 3, "operator-helper-outside-guard"],
    ],
  );
});

test("exits 1 on a repo with an unguarded operator action and 0 once it is guarded", () => {
  const dir = mkdtempSync(join(tmpdir(), "operator-guard-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    mkdirSync(join(dir, dirname(OPERATOR_ACTIONS_FILE)), { recursive: true });
    const file = join(dir, OPERATOR_ACTIONS_FILE);
    writeFileSync(file, GUARDED.replace("  await requireOperator();\n", ""));
    git("add", "-A");

    const red = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stderr, /apps\/web\/app\/actions\/admin\.ts:12: \[guard-first\]/);

    writeFileSync(file, GUARDED);
    git("add", "-A");
    const green = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /operator-guard: 2 operator actions guarded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
