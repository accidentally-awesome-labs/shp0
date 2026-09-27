// Self-tests for action-guard.mjs, including negative fixtures taken from
// main before the dashboard authorization fix: the seven dashboard reads with
// no check at all, and the Membership-only resolveDashboardStore() gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ACTIONS_DIR,
  PUBLIC_ACTIONS,
  checkActionsModule,
  checkDashboardPage,
  checkRepo,
} from "./action-guard.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "action-guard.mjs");
const FILE = `${ACTIONS_DIR}things.ts`;
const PAGE = "apps/web/app/dashboard/[storeId]/things/page.tsx";

const rules = (result) => result.violations.map((v) => v.rule);
const ruleLines = (result) => result.violations.map((v) => [v.rule, v.line]);

const GUARDED = `"use server";

import { authorizeStore } from "@/lib/current-store";
import { requireOperator } from "@/lib/operator";
import { listThings, deleteThing } from "@shp0/db";

export type Thing = { id: string };

function helper(storeId: string) {
  return storeId;
}

export async function getThings(storeId: string) {
  await authorizeStore(storeId, "catalog.view");
  return listThings(storeId);
}

export async function deleteThingAction(storeId: string, thingId: string) {
  const { userId } = await authorizeStore(storeId, "catalog.manage");
  await deleteThing(storeId, thingId);
  return userId;
}

/** A doc comment glued to the export. */export async function glued(storeId: string) {
  const access = await authorizeStore(storeId, \`catalog.view\`);
  return access;
}

export async function operatorOnly() {
  await requireOperator();
}
`;

test("accepts guarded async exports, type exports and private helpers", () => {
  const result = checkActionsModule(FILE, GUARDED, new Map());
  assert.deepEqual(result.violations, []);
  assert.deepEqual(
    result.guarded.map((g) => [g.name, g.guard, g.capability]),
    [
      ["getThings", "authorizeStore", "catalog.view"],
      ["deleteThingAction", "authorizeStore", "catalog.manage"],
      ["glued", "authorizeStore", "catalog.view"],
      ["operatorOnly", "requireOperator", null],
    ],
  );
});

test("flags the seven dashboard reads that had no check on main", () => {
  const main = `"use server";
import { listCollections, listCollectionMembers, listProducts, listCustomers, listCustomerOrders, listDiscounts, getStoreTier } from "@shp0/db";

export async function getDashboardBilling(storeId: string) {
  return getStoreTier(storeId);
}
export async function getDashboardCollections(storeId: string) {
  return listCollections(storeId);
}
export async function getDashboardCollectionMembers(storeId: string, collectionId: string) {
  return listCollectionMembers(storeId, collectionId);
}
export async function getDashboardProducts(storeId: string) {
  return listProducts(storeId);
}
export async function getDashboardCustomers(storeId: string) {
  return listCustomers(storeId);
}
export async function getDashboardCustomerOrders(storeId: string, customerId: string) {
  return listCustomerOrders(storeId, customerId);
}
export async function getDashboardDiscounts(storeId: string) {
  return listDiscounts(storeId);
}
`;
  const result = checkActionsModule(FILE, main, new Map());
  assert.deepEqual(
    result.violations.map((v) => [v.rule, v.name]),
    [
      ["guard-first", "getDashboardBilling"],
      ["guard-first", "getDashboardCollections"],
      ["guard-first", "getDashboardCollectionMembers"],
      ["guard-first", "getDashboardProducts"],
      ["guard-first", "getDashboardCustomers"],
      ["guard-first", "getDashboardCustomerOrders"],
      ["guard-first", "getDashboardDiscounts"],
    ],
  );
});

test("flags main's Membership-only gate: it checks no Role", () => {
  const main = `"use server";
import { resolveDashboardStore } from "@/lib/current-store";
import { setStoreTier } from "@shp0/db";

async function authorize(storeId: string): Promise<void> {
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) throw new Error("Not authorized for this store");
}

export async function changeTierAction(storeId: string, formData: FormData) {
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) throw new Error("Not authorized for this store");
  await setStoreTier(storeId, formData.get("tierId") as "pro");
}

export async function retryDomainAction(storeId: string) {
  await authorize(storeId);
}
`;
  assert.deepEqual(ruleLines(checkActionsModule(FILE, main, new Map())), [
    ["guard-first", 10],
    ["guard-first", 16],
  ]);
});

test("flags a guard call that is removed, moved down, not awaited or conditional", () => {
  const source = `import { authorizeStore } from "@/lib/current-store";
export async function removed(storeId: string) {
  return list(storeId);
}
export async function movedDown(storeId: string) {
  const rows = await list(storeId);
  await authorizeStore(storeId, "catalog.view");
  return rows;
}
export async function notAwaited(storeId: string) {
  authorizeStore(storeId, "catalog.view");
  return list(storeId);
}
export async function conditional(storeId: string) {
  if (storeId) await authorizeStore(storeId, "catalog.view");
  return list(storeId);
}
export async function empty(storeId: string) {}
`;
  assert.deepEqual(ruleLines(checkActionsModule(FILE, source, new Map())), [
    ["guard-first", 2],
    ["guard-first", 5],
    ["guard-first", 10],
    ["guard-first", 14],
    ["guard-first", 18],
  ]);
});

test("authorizeStore must get the action's own first parameter and a literal capability", () => {
  const source = `import { authorizeStore } from "@/lib/current-store";
export async function literalStore(storeId: string) {
  await authorizeStore("aaaaaaaa-0000-4000-8000-000000000001", "catalog.view");
}
export async function otherParam(storeId: string, otherStoreId: string) {
  await authorizeStore(otherStoreId, "catalog.view");
}
export async function expression(storeId: string) {
  await authorizeStore(storeId.trim(), "catalog.view");
}
export async function variableCapability(storeId: string, capability: string) {
  await authorizeStore(storeId, capability as never);
}
export async function templateCapability(storeId: string, kind: string) {
  await authorizeStore(storeId, \`catalog.\${kind}\`);
}
export async function missingCapability(storeId: string) {
  await authorizeStore(storeId);
}
export async function extraArgument(storeId: string) {
  await authorizeStore(storeId, "catalog.view", true);
}
export async function destructuredParam({ storeId }: { storeId: string }) {
  await authorizeStore(storeId, "catalog.view");
}
export async function noParams() {
  await authorizeStore(undefined as never, "catalog.view");
}
`;
  assert.deepEqual(ruleLines(checkActionsModule(FILE, source, new Map())), [
    ["guard-args", 3],
    ["guard-args", 6],
    ["guard-args", 9],
    ["guard-args", 12],
    ["guard-args", 15],
    ["guard-args", 18],
    ["guard-args", 21],
    ["guard-args", 24],
    ["guard-args", 27],
  ]);
});

test("requireOperator takes no arguments", () => {
  const source = `import { requireOperator } from "@/lib/operator";
export async function a(storeId: string) {
  await requireOperator(storeId);
}
`;
  assert.deepEqual(rules(checkActionsModule(FILE, source, new Map())), ["guard-args"]);
});

test("flags a store parameter that is reassigned or shadowed after the guard", () => {
  const source = `import { authorizeStore } from "@/lib/current-store";
export async function reassigned(storeId: string, other: string) {
  await authorizeStore(storeId, "catalog.view");
  storeId = other;
  return list(storeId);
}
export async function shadowed(storeId: string, other: string) {
  await authorizeStore(storeId, "catalog.view");
  {
    const storeId = other;
    return list(storeId);
  }
}
export async function innerParam(storeId: string, ids: string[]) {
  await authorizeStore(storeId, "catalog.view");
  return ids.map((storeId) => list(storeId));
}
export async function destructuringAssignment(storeId: string, pair: string[]) {
  await authorizeStore(storeId, "catalog.view");
  [storeId] = pair;
}
export async function incremented(storeId: string) {
  await authorizeStore(storeId, "catalog.view");
  storeId += "x";
}
`;
  assert.deepEqual(ruleLines(checkActionsModule(FILE, source, new Map())), [
    ["store-param-reassigned", 4],
    ["store-param-reassigned", 10],
    ["store-param-reassigned", 16],
    ["store-param-reassigned", 20],
    ["store-param-reassigned", 24],
  ]);
});

test("flags a guard imported from elsewhere, renamed, shadowed or defined locally", () => {
  const fromElsewhere = `import { authorizeStore } from "@/lib/other";
export async function a(storeId: string) {
  await authorizeStore(storeId, "catalog.view");
}
`;
  assert.deepEqual(rules(checkActionsModule(FILE, fromElsewhere, new Map())), [
    "guard-not-redefined",
    "guard-first",
  ]);

  const renamed = `import { getStoreAccess as authorizeStore } from "@/lib/current-store";
export async function a(storeId: string) {
  await authorizeStore(storeId, "catalog.view");
}
`;
  assert.deepEqual(rules(checkActionsModule(FILE, renamed, new Map())), [
    "guard-not-redefined",
    "guard-first",
  ]);

  const local = `"use server";
import { resolveDashboardStore } from "@/lib/current-store";
async function authorizeStore(storeId: string, _capability: string) {
  if (!(await resolveDashboardStore(storeId))) throw new Error("Not authorized for this store");
}
export async function a(storeId: string) {
  await authorizeStore(storeId, "catalog.view");
}
`;
  assert.deepEqual(ruleLines(checkActionsModule(FILE, local, new Map())), [
    ["guard-not-redefined", 3],
    ["guard-first", 6],
  ]);

  const shadowedParam = `import { authorizeStore } from "@/lib/current-store";
export async function a(storeId: string, authorizeStore: (s: string, c: string) => Promise<void>) {
  await authorizeStore(storeId, "catalog.view");
}
`;
  assert.deepEqual(rules(checkActionsModule(FILE, shadowedParam, new Map())), [
    "guard-not-redefined",
  ]);

  const typeOnly = `import type { authorizeStore } from "@/lib/current-store";
export async function a(storeId: string) {
  await authorizeStore(storeId, "catalog.view");
}
`;
  assert.deepEqual(rules(checkActionsModule(FILE, typeOnly, new Map())), [
    "guard-not-redefined",
    "guard-first",
  ]);
});

test("flags runtime exports it cannot check: consts, defaults, re-exports, sync functions", () => {
  const source = `import { authorizeStore } from "@/lib/current-store";
export const a = async (storeId: string) => {
  await authorizeStore(storeId, "catalog.view");
};
export default async () => {};
export { b } from "./b";
export * from "./c";
export type { D } from "./d";
export function sync() {
  return 1;
}
`;
  assert.deepEqual(ruleLines(checkActionsModule(FILE, source, new Map())), [
    ["export-shape", 2],
    ["export-shape", 5],
    ["export-shape", 6],
    ["export-shape", 7],
    ["export-shape", 9],
  ]);
});

test("a guarded action takes no second Store id and never reads `arguments`", () => {
  const source = `import { authorizeStore } from "@/lib/current-store";
export async function secondStoreId(storeId: string, targetStoreId: string) {
  await authorizeStore(storeId, "customers.view");
  return listCustomers(targetStoreId);
}
export async function destructuredStoreId(storeId: string, { otherStoreId }: { otherStoreId: string }) {
  await authorizeStore(storeId, "customers.view");
  return listCustomers(otherStoreId);
}
export async function viaArguments(storeId: string) {
  await authorizeStore(storeId, "customers.view");
  return listCustomers(arguments[1]);
}
export async function propertyNamedArguments(storeId: string, call: { arguments: string[] }) {
  await authorizeStore(storeId, "customers.view");
  return call.arguments.length;
}
`;
  assert.deepEqual(ruleLines(checkActionsModule(FILE, source, new Map())), [
    ["extra-store-param", 2],
    ["extra-store-param", 6],
    ["arguments-used", 12],
  ]);
});

test("parameter defaults are literals: they run before the guard", () => {
  const source = `import { authorizeStore } from "@/lib/current-store";
export async function deletesFirst(storeId: string, productId: string, _x = deleteProduct(storeId, productId)) {
  await authorizeStore(storeId, "catalog.manage");
}
export async function readsFirst(storeId: string, leak = listCustomers(storeId)) {
  await authorizeStore(storeId, "customers.view");
  return leak;
}
export async function inPattern(storeId: string, { rows = listCustomers(storeId) }: { rows?: unknown }) {
  await authorizeStore(storeId, "customers.view");
  return rows;
}
export async function computedKey(storeId: string, { [pick(storeId)]: rows }: Record<string, unknown>) {
  await authorizeStore(storeId, "customers.view");
  return rows;
}
export async function awaited(storeId: string, rows = await Promise.resolve(1)) {
  await authorizeStore(storeId, "customers.view");
  return rows;
}
export async function literals(
  storeId: string,
  quantity: number = 1,
  offset = -1,
  label = "x",
  flag = false,
  none = null,
  missing = undefined,
  list: string[] = [],
  options = {},
  typed = {} as Record<string, string>,
) {
  await authorizeStore(storeId, "catalog.view");
}
`;
  assert.deepEqual(ruleLines(checkActionsModule(FILE, source, new Map())), [
    ["param-default", 2],
    ["param-default", 5],
    ["param-default", 9],
    ["param-default", 13],
    ["param-default", 17],
  ]);

  const publicAction = `"use server";
export async function addToCart(variantId: string, quantity: number = 1, _x = sideEffect()) {
  return variantId;
}
`;
  const allowlist = new Map([[`${FILE}#addToCart`, "storefront: Store from the host"]]);
  assert.deepEqual(ruleLines(checkActionsModule(FILE, publicAction, allowlist)), [["param-default", 2]]);
});

test("the allowlist exempts named public actions, and only those", () => {
  const source = `"use server";
import { resolveStorefrontStore } from "@/lib/current-store";
export async function addToCart(variantId: string) {
  const storeId = await resolveStorefrontStore();
  return storeId;
}
export async function getSecret(storeId: string) {
  return storeId;
}
`;
  const allowlist = new Map([[`${FILE}#addToCart`, "storefront: Store from the host"]]);
  const result = checkActionsModule(FILE, source, allowlist);
  assert.deepEqual(result.violations.map((v) => [v.rule, v.name]), [["guard-first", "getSecret"]]);
  assert.deepEqual(result.public, ["addToCart"]);
});

test("an allowlisted action may not take a Store id from the caller", () => {
  const source = `"use server";
export async function getDashboardCustomers(storeId: string) {
  return storeId;
}
export async function lookup(input: { storeId: string }) {
  return input;
}
`;
  const allowlist = new Map([
    [`${FILE}#getDashboardCustomers`, "sneaked in"],
    [`${FILE}#lookup`, "sneaked in"],
  ]);
  assert.deepEqual(ruleLines(checkActionsModule(FILE, source, allowlist)), [
    ["public-takes-store-id", 2],
  ]);
});

test("every allowlist entry has a reason and names an actions module", () => {
  assert.ok(PUBLIC_ACTIONS.size > 0);
  for (const [key, reason] of PUBLIC_ACTIONS) {
    assert.match(key, /^apps\/web\/app\/actions\/[a-z-]+\.ts#[A-Za-z]\w*$/, key);
    assert.ok(typeof reason === "string" && reason.length > 20, `${key} needs a reason`);
  }
});

const PAGE_OK = `export const instant = false;
import { authorizeStorePage } from "@/lib/current-store";
import { RequiresRole } from "../requires-role";

export default async function ThingsPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const access = await authorizeStorePage(storeId, "catalog.view");
  if (access.status !== "ok") return <RequiresRole role={access.required} />;
  return <p>{storeId}</p>;
}
`;

test("accepts a dashboard page that gates before anything else", () => {
  const result = checkDashboardPage(PAGE, PAGE_OK);
  assert.deepEqual(result.violations, []);
  assert.equal(result.capability, "catalog.view");
});

test("flags dashboard pages that fetch before gating, or never gate (main)", () => {
  const ungated = `import { getDashboardCustomers } from "@/app/actions/customers";
export default async function CustomersPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const customers = await getDashboardCustomers(storeId);
  return <p>{customers.length}</p>;
}
`;
  assert.deepEqual(ruleLines(checkDashboardPage(PAGE, ungated)), [["page-gate-first", 2]]);

  const membershipOnly = `import { notFound } from "next/navigation";
import { resolveDashboardStore } from "@/lib/current-store";
export default async function DomainsPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) notFound();
  return <p />;
}
`;
  assert.deepEqual(ruleLines(checkDashboardPage(PAGE, membershipOnly)), [["page-gate-first", 3]]);

  const wrongStore = PAGE_OK.replace('authorizeStorePage(storeId, "catalog.view")', 'authorizeStorePage("x", "catalog.view")');
  assert.deepEqual(rules(checkDashboardPage(PAGE, wrongStore)), ["page-gate-first"]);

  const client = `"use client";
export default function NewThingPage() {
  return <form />;
}
`;
  assert.deepEqual(rules(checkDashboardPage(PAGE, client)), ["page-client"]);

  const extraExport = PAGE_OK + `
export async function generateMetadata({ params }: { params: Promise<{ storeId: string }> }) {
  return { title: (await params).storeId };
}
`;
  assert.deepEqual(rules(checkDashboardPage(PAGE, extraExport)), ["page-export"]);

  const renamedGate = PAGE_OK.replace(
    'import { authorizeStorePage } from "@/lib/current-store";',
    'import { getStoreAccess as authorizeStorePage } from "@/lib/current-store";',
  );
  assert.deepEqual(rules(checkDashboardPage(PAGE, renamedGate)), ["page-gate-first"]);
});

test("a dashboard page exports nothing that runs besides the page and literal segment config", () => {
  const cases = [
    [
      "a local function in an export list",
      `async function generateMetadata({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  return { title: (await listCustomers(storeId))[0]?.email };
}
export { generateMetadata };
`,
    ],
    ["a re-export", `export { generateMetadata } from "./meta";\n`],
    ["a star re-export", `export * from "./meta";\n`],
    ["an exported const bound to a function value", `import { meta } from "./meta";\nexport const generateMetadata = meta;\n`],
    ["segment config computed at load", `export const revalidate = compute();\n`],
    ["an exported non-config const", `export const title = "Things";\n`],
    ["an exported let", `export let instant = false;\n`],
    ["an exported class", `export class Thing {}\n`],
  ];
  for (const [label, extra] of cases) {
    assert.deepEqual(rules(checkDashboardPage(PAGE, PAGE_OK + extra)), ["page-export"], label);
  }

  const allowed = `${PAGE_OK}
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;
export type ThingsProps = { storeId: string };
export interface ThingsView { id: string }
export { type ThingsProps as Props };
`;
  assert.deepEqual(checkDashboardPage(PAGE, allowed).violations, []);
});

test("the repo check covers 'use server' anywhere in the repo, not only apps/web", () => {
  const files = {
    "packages/db/src/evil-actions.ts": `"use server";
import { listCustomers } from "./index";
export async function unguarded(storeId: string) {
  return listCustomers(storeId);
}
`,
    "packages/auth/src/inline.ts": `export function make() {
  return async function act() {
    "use server";
  };
}
`,
    "scripts/ci/fixture.test.mjs": 'const text = `"use server";`;\n',
  };
  const result = checkRepo(Object.keys(files), (f) => files[f], new Map());
  assert.deepEqual(
    result.violations.map((v) => [v.file, v.line, v.rule]),
    [
      ["packages/db/src/evil-actions.ts", 1, "use-server-outside-actions"],
      ["packages/auth/src/inline.ts", 3, "use-server-outside-actions"],
    ],
  );
});

test("every route file under a Store dashboard segment is gated, wherever the segment sits", () => {
  const ungatedLayout = `import { listCustomers } from "@shp0/db";
export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const customers = await listCustomers(storeId);
  return <div>{customers[0]?.email}{children}</div>;
}
`;
  const gatedLayout = `import { authorizeStorePage } from "@/lib/current-store";
export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const access = await authorizeStorePage(storeId, "store.view");
  return <div>{children}</div>;
}
`;
  const ungatedPage = `import { listCustomers } from "@shp0/db";
export default async function Page({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  return <p>{(await listCustomers(storeId))[0]?.email}</p>;
}
`;
  const routeHandler = `import { listCustomers } from "@shp0/db";
export async function GET(_request: Request, { params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  return Response.json(await listCustomers(storeId));
}
`;
  const files = {
    "apps/web/app/dashboard/[storeId]/layout.tsx": ungatedLayout,
    "apps/web/app/dashboard/[storeId]/things/template.tsx": ungatedLayout,
    "apps/web/app/dashboard/[storeId]/@panel/default.tsx": ungatedPage,
    "apps/web/app/dashboard/[storeId]/customers/export/route.ts": routeHandler,
    "apps/web/app/dashboard/[storeId]/opengraph-image.tsx": routeHandler,
    "apps/web/app/(shell)/dashboard/[storeId]/grouped/page.tsx": ungatedPage,
    "apps/web/app/dashboard/(settings)/[storeId]/settings/page.tsx": ungatedPage,
    "apps/web/app/dashboard/[store]/page.tsx": ungatedPage.replaceAll("storeId", "store"),
    "apps/web/app/(.)dashboard/[storeId]/modal/page.tsx": ungatedPage,
    // Gated: fine.
    "apps/web/app/dashboard/[storeId]/other/layout.tsx": gatedLayout,
    // Not under a Store segment: session-scoped pages, and components.
    "apps/web/app/dashboard/page.tsx": ungatedPage,
    "apps/web/app/dashboard/onboarding/page.tsx": ungatedPage,
    "apps/web/app/dashboard/[storeId]/things/list.tsx": ungatedPage,
    "apps/web/app/dashboard/[storeId]/loading.tsx": `export default function Loading() {\n  return null;\n}\n`,
  };
  const result = checkRepo(Object.keys(files), (f) => files[f], new Map());
  assert.deepEqual(
    result.violations.map((v) => [v.file, v.rule]).sort(),
    [
      ["apps/web/app/(.)dashboard/[storeId]/modal/page.tsx", "page-gate-first"],
      ["apps/web/app/(shell)/dashboard/[storeId]/grouped/page.tsx", "page-gate-first"],
      ["apps/web/app/dashboard/(settings)/[storeId]/settings/page.tsx", "page-gate-first"],
      ["apps/web/app/dashboard/[storeId]/@panel/default.tsx", "page-gate-first"],
      ["apps/web/app/dashboard/[storeId]/customers/export/route.ts", "dashboard-route-handler"],
      ["apps/web/app/dashboard/[storeId]/layout.tsx", "page-gate-first"],
      ["apps/web/app/dashboard/[storeId]/opengraph-image.tsx", "dashboard-route-handler"],
      ["apps/web/app/dashboard/[storeId]/things/template.tsx", "page-gate-first"],
      ["apps/web/app/dashboard/[store]/page.tsx", "page-gate-first"],
    ],
  );
  assert.deepEqual(result.pages, [["apps/web/app/dashboard/[storeId]/other/layout.tsx", "store.view"]]);
});

test("the repo check: 'use server' only in the actions directory, and stale allowlist entries", () => {
  const files = {
    [`${ACTIONS_DIR}ok.ts`]: GUARDED,
    [`${ACTIONS_DIR}plain.ts`]: "export function notAnAction() {}\n",
    "apps/web/app/elsewhere/actions.ts": `"use server";\nexport async function x() {}\n`,
    "apps/web/app/page.tsx": `export default function Page() {\n  async function act() {\n    "use server";\n  }\n  return null;\n}\n`,
    [PAGE]: PAGE_OK,
    "apps/web/app/dashboard/[storeId]/things/form.tsx": `"use client";\nexport function Form() {}\n`,
    "apps/web/README.md": '"use server"',
  };
  const allowlist = new Map([[`${ACTIONS_DIR}ok.ts#gone`, "was public once, now deleted"]]);
  const result = checkRepo(Object.keys(files), (f) => files[f], allowlist);
  assert.deepEqual(
    result.violations.map((v) => [v.file, v.line, v.rule]),
    [
      ["apps/web/app/elsewhere/actions.ts", 1, "use-server-outside-actions"],
      ["apps/web/app/page.tsx", 3, "use-server-outside-actions"],
      [`${ACTIONS_DIR}ok.ts`, 1, "stale-allowlist"],
    ],
  );
  assert.equal(result.guarded.length, 4);
  assert.deepEqual(result.pages, [[PAGE, "catalog.view"]]);
});

test("exits 1 on a repo with an unguarded dashboard read and 0 once it is guarded", () => {
  const dir = mkdtempSync(join(tmpdir(), "action-guard-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    mkdirSync(join(dir, ACTIONS_DIR), { recursive: true });
    const file = join(dir, FILE);
    // A repo without the real public actions: an empty allowlist would be
    // stale-free, but the script uses PUBLIC_ACTIONS, so give each its stub.
    const stubs = new Map();
    for (const key of PUBLIC_ACTIONS.keys()) {
      const [path, name] = key.split("#");
      stubs.set(path, [...(stubs.get(path) ?? []), name]);
    }
    for (const [path, names] of stubs) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(
        join(dir, path),
        `"use server";\n${names.map((n) => `export async function ${n}() {}\n`).join("")}`,
      );
    }
    writeFileSync(file, GUARDED.replace('  await authorizeStore(storeId, "catalog.view");\n', ""));
    git("add", "-A");

    const red = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stderr, /apps\/web\/app\/actions\/things\.ts:13: \[guard-first\] getThings\(\)/);

    writeFileSync(file, GUARDED);
    git("add", "-A");
    const green = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /action-guard: 4 actions guarded/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
