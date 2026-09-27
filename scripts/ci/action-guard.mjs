#!/usr/bin/env node
// Fails CI when a server action or a Store dashboard page is not behind an
// authorization check. Run from the repo root: node scripts/ci/action-guard.mjs
//
// Every export of a "use server" module can be called over HTTP by its action
// id, whether or not a page renders it, and with any arguments (any storeId).
// So each one checks the caller itself, first, or is deliberately public.
// operator-guard.mjs pins the Operator side in detail; this generalizes the
// first-statement rule to every action module:
//
//  1. A module-level "use server" directive appears only in files under
//     apps/web/app/actions/, and no function anywhere in apps/web has an
//     inline "use server" directive, so every action is in a file checked here.
//  2. Each runtime export of those modules is an async function declaration
//     whose first statement awaits an approved guard (optionally binding the
//     result), imported under its own name from its own module and not
//     redefined anywhere in the file:
//       await authorizeStore(<the function's first parameter>, "<capability>")
//         from "@/lib/current-store": Membership plus a Role at or above the
//         capability's minimum (packages/db/src/roles.ts);
//       await requireOperator()   from "@/lib/operator".
//     The Store parameter is not reassigned or shadowed afterwards.
//  3. The only exceptions are PUBLIC_ACTIONS below: storefront and
//     session-scoped actions, each with its reason. An entry that no longer
//     names an export fails, and an allowlisted action may not take a Store id.
//  4. Every page under apps/web/app/dashboard/[storeId]/ is a server component
//     whose first statements are
//       const { storeId } = await params;
//       const access = await authorizeStorePage(storeId, "<capability>");
//     so it gates before it fetches anything, and exports no other function.
//
// It parses TypeScript with the compiler apps/web already depends on. It
// cannot tell whether a capability fits an action: that is review, and the
// capability literal must type-check as a Capability.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ts = createRequire(new URL("../../apps/web/package.json", import.meta.url))("typescript");

export const ACTIONS_DIR = "apps/web/app/actions/";
const DASHBOARD_STORE_PAGE = /^apps\/web\/app\/dashboard\/\[storeId\]\/(?:.+\/)?page\.[cm]?[jt]sx?$/;
const CODE = /\.[cm]?[jt]sx?$/;

/** Approved first-statement guards for a server action, and their modules. */
const GUARDS = new Map([
  ["authorizeStore", "@/lib/current-store"],
  ["requireOperator", "@/lib/operator"],
]);
const PAGE_GUARD = "authorizeStorePage";
const PAGE_GUARD_MODULE = "@/lib/current-store";

/**
 * Server actions that are public or scoped to the caller's own session on
 * purpose, as "<file>#<export>" -> why no Store authorization applies.
 * Keep this short, and never add a dashboard action: those take a Store id
 * and must call authorizeStore() (rule 3 rejects an entry with a Store id
 * parameter).
 */
export const PUBLIC_ACTIONS = new Map([
  // Storefront Cart and checkout: the Store comes from the request host (never
  // an argument) and the Cart from the shopper's own httpOnly cookie.
  [
    "apps/web/app/actions/cart.ts#addToCart",
    "storefront: the Store is the request host's, the Cart the shopper's own cookie",
  ],
  [
    "apps/web/app/actions/cart.ts#updateCartItem",
    "storefront: the Store is the request host's, the Cart the shopper's own cookie",
  ],
  [
    "apps/web/app/actions/cart.ts#removeCartItem",
    "storefront: the Store is the request host's, the Cart the shopper's own cookie",
  ],
  [
    "apps/web/app/actions/cart.ts#getCart",
    "storefront: the Store is the request host's, the Cart the shopper's own cookie",
  ],
  [
    "apps/web/app/actions/checkout.ts#checkoutAction",
    "storefront: checks out the shopper's own Cart (cookie) in the request host's Store",
  ],
  // Storefront Customer identity (a separate identity domain from Merchants).
  [
    "apps/web/app/actions/customers.ts#customerSignUpAction",
    "storefront: Customer sign-up in the request host's Store",
  ],
  [
    "apps/web/app/actions/customers.ts#customerSignInAction",
    "storefront: Customer sign-in in the request host's Store",
  ],
  [
    "apps/web/app/actions/customers.ts#getStorefrontCustomer",
    "storefront: the Customer's own session cookie, in the request host's Store",
  ],
  [
    "apps/web/app/actions/stripe.ts#createCheckoutSessionAction",
    "storefront: Stripe Checkout for a pending Order of the request host's Store",
  ],
  // Merchant, but not about one existing Store.
  [
    "apps/web/app/actions/stores.ts#createStoreAction",
    "session-scoped: any signed-in Merchant may create a Store and becomes its Owner",
  ],
  [
    "apps/web/app/actions/stores.ts#getMyStores",
    "session-scoped: lists only the signed-in Merchant's own Memberships",
  ],
  [
    "apps/web/app/actions/stores.ts#checkSubdomain",
    "public: whether a Subdomain is taken (Subdomains are public addresses)",
  ],
]);

function parse(file, source) {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

const hasModifier = (node, kind) => (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

const isStringLiteralLike = (node) =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/** The directive prologue of a statement list, as [text, node] pairs. */
function directives(statements) {
  const out = [];
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    out.push([statement.expression.text, statement]);
  }
  return out;
}

const moduleDirective = (sourceFile, text) =>
  directives(sourceFile.statements).find(([t]) => t === text)?.[1];

/** "use server" directives inside function bodies. */
function inlineUseServer(sourceFile) {
  const found = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body && ts.isBlock(node.body)) {
      for (const [text, statement] of directives(node.body.statements)) {
        if (text === "use server") found.push(statement);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/** name -> the import specifier that binds it from its approved module. */
function approvedImports(sourceFile, approved) {
  const bound = new Map();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.isTypeOnly
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      const local = element.name.text;
      if (
        !element.isTypeOnly &&
        imported === local &&
        approved.get(local) === statement.moduleSpecifier.text
      ) {
        bound.set(local, element);
      }
    }
  }
  return bound;
}

/** Declarations of any of `names` other than their approved imports. */
function redefinitions(sourceFile, names, imports) {
  const found = [];
  const visit = (node) => {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportEqualsDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      names.has(node.name.text) &&
      imports.get(node.name.text) !== node
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/** `await g(...)`, `const x = await g(...)` or `const { a } = await g(...)` -> the call. */
function awaitedCall(statement) {
  let expression;
  if (statement === undefined) return null;
  if (ts.isExpressionStatement(statement)) {
    expression = statement.expression;
  } else if (ts.isVariableStatement(statement)) {
    const [declaration, ...rest] = statement.declarationList.declarations;
    if (rest.length > 0) return null;
    expression = declaration?.initializer;
  }
  if (
    expression === undefined ||
    !ts.isAwaitExpression(expression) ||
    !ts.isCallExpression(expression.expression) ||
    !ts.isIdentifier(expression.expression.expression)
  ) {
    return null;
  }
  return expression.expression;
}

/** Identifiers bound by a parameter or binding pattern. */
function boundNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : boundNames(element.name),
  );
}

/** Nodes in `body` that reassign or shadow the identifier `name`. */
function reassignments(body, name) {
  const found = [];
  const targets = (node) => {
    // Identifiers written by an assignment target, including destructuring.
    if (ts.isIdentifier(node)) return node.text === name ? [node] : [];
    if (ts.isParenthesizedExpression(node)) return targets(node.expression);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(targets);
    if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return targets(node.expression);
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.flatMap((p) =>
        ts.isShorthandPropertyAssignment(p)
          ? targets(p.name)
          : ts.isPropertyAssignment(p)
            ? targets(p.initializer)
            : ts.isSpreadAssignment(p)
              ? targets(p.expression)
              : [],
      );
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return targets(node.left); // a default value in a destructuring target
    }
    return [];
  };
  const visit = (node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found.push(node);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      found.push(...targets(node.left));
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      found.push(...targets(node.operand));
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      found.push(...targets(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

const byLine = (a, b) => a.line - b.line;

/**
 * Rules 2 and 3 on one "use server" module.
 * @returns {{ violations: object[], guarded: object[], public: string[], exports: string[] }}
 */
export function checkActionsModule(file, source, allowlist = PUBLIC_ACTIONS) {
  const sourceFile = parse(file, source);
  const violations = [];
  const guarded = [];
  const publicActions = [];
  const exported = [];
  const report = (node, rule, why, name) =>
    violations.push({ file, line: lineOf(sourceFile, node), rule, why, name });

  const imports = approvedImports(sourceFile, GUARDS);
  for (const node of redefinitions(sourceFile, new Set(GUARDS.keys()), imports)) {
    const name = node.name.text;
    report(node, "guard-not-redefined", `only an import from "${GUARDS.get(name)}" may bind ${name}`);
  }

  const shape = 'every export must be `export async function name(storeId, ...) { await authorizeStore(storeId, "<capability>"); ... }`';
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.isTypeOnly) report(statement, "export-shape", shape);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      report(statement, "export-shape", shape);
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    if (
      !ts.isFunctionDeclaration(statement) ||
      !statement.body ||
      !hasModifier(statement, ts.SyntaxKind.AsyncKeyword)
    ) {
      report(statement, "export-shape", shape);
      continue;
    }

    const name = statement.name?.text ?? "default";
    exported.push(name);

    if (allowlist.has(`${file}#${name}`)) {
      publicActions.push(name);
      const storeParam = statement.parameters
        .flatMap((p) => boundNames(p.name))
        .find((n) => /storeid/i.test(n));
      if (storeParam !== undefined) {
        report(
          statement,
          "public-takes-store-id",
          `${name}() is in PUBLIC_ACTIONS but takes "${storeParam}": a Store id from the caller must be checked with authorizeStore()`,
          name,
        );
      }
      continue;
    }

    const first = statement.body.statements[0];
    const call = awaitedCall(first);
    const guard = call?.expression.text;
    if (!call || !GUARDS.has(guard) || !imports.has(guard)) {
      report(
        statement,
        "guard-first",
        `${name}() is callable over HTTP by its action id: its first statement must be ` +
          '`await authorizeStore(<its first parameter>, "<capability>");` (or `await requireOperator();`), ' +
          "or it must be listed in PUBLIC_ACTIONS with a reason",
        name,
      );
      continue;
    }

    const args = call.arguments;
    if (guard === "requireOperator") {
      if (args.length !== 0) {
        report(first, "guard-args", `${name}(): requireOperator() takes no arguments`, name);
        continue;
      }
      guarded.push({ name, guard, capability: null });
      continue;
    }

    const param = statement.parameters[0];
    const storeParam = param && ts.isIdentifier(param.name) ? param.name.text : null;
    if (
      storeParam === null ||
      args.length !== 2 ||
      !ts.isIdentifier(args[0]) ||
      args[0].text !== storeParam ||
      !isStringLiteralLike(args[1])
    ) {
      report(
        first,
        "guard-args",
        `${name}(): call authorizeStore(${storeParam ?? "<its first parameter, a plain identifier>"}, "<capability>") ` +
          "with the action's own first parameter and a string literal capability",
        name,
      );
      continue;
    }

    const changed = reassignments(statement.body, storeParam);
    for (const node of changed) {
      report(
        node,
        "store-param-reassigned",
        `${name}(): "${storeParam}" is the authorized Store id; do not reassign or shadow it`,
        name,
      );
    }
    if (changed.length === 0) guarded.push({ name, guard, capability: args[1].text });
  }

  return { violations: violations.sort(byLine), guarded, public: publicActions, exports: exported };
}

/**
 * Rule 4 on one page under apps/web/app/dashboard/[storeId]/.
 * @returns {{ violations: object[], capability: string | null }}
 */
export function checkDashboardPage(file, source) {
  const sourceFile = parse(file, source);
  const violations = [];
  const report = (node, rule, why) =>
    violations.push({ file, line: lineOf(sourceFile, node), rule, why });
  const gateShape =
    "a Store dashboard page must start with `const { storeId } = await params;` then " +
    '`const access = await authorizeStorePage(storeId, "<capability>");`, before it fetches anything';

  const useClient = moduleDirective(sourceFile, "use client");
  if (useClient) {
    report(
      useClient,
      "page-client",
      "a Store dashboard page must be a server component that calls authorizeStorePage() first; " +
        "render the client UI from it as a component",
    );
    return { violations, capability: null };
  }

  const imports = approvedImports(sourceFile, new Map([[PAGE_GUARD, PAGE_GUARD_MODULE]]));
  let page = null;
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      report(statement, "page-gate-first", gateShape);
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      page = statement;
    } else if (ts.isFunctionDeclaration(statement)) {
      report(statement, "page-export", "a Store dashboard page exports no function but the page itself");
    } else if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (d) =>
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)),
      )
    ) {
      report(statement, "page-export", "a Store dashboard page exports no function but the page itself");
    }
  }
  if (page === null) {
    if (!violations.some((v) => v.rule === "page-gate-first")) {
      report(sourceFile.statements[0] ?? sourceFile, "page-gate-first", gateShape);
    }
    return { violations: violations.sort(byLine), capability: null };
  }

  const [first, second] = page.body?.statements ?? [];
  // const { storeId } = await params;
  const paramsOk =
    first !== undefined &&
    ts.isVariableStatement(first) &&
    first.declarationList.declarations.length === 1 &&
    (() => {
      const [d] = first.declarationList.declarations;
      return (
        ts.isObjectBindingPattern(d.name) &&
        d.name.elements.some(
          (e) =>
            ts.isIdentifier(e.name) &&
            e.name.text === "storeId" &&
            (e.propertyName === undefined ||
              (ts.isIdentifier(e.propertyName) && e.propertyName.text === "storeId")),
        ) &&
        d.initializer !== undefined &&
        ts.isAwaitExpression(d.initializer) &&
        ts.isIdentifier(d.initializer.expression)
      );
    })();
  const call = awaitedCall(second);
  const gateOk =
    paramsOk &&
    call !== null &&
    call.expression.text === PAGE_GUARD &&
    imports.has(PAGE_GUARD) &&
    call.arguments.length === 2 &&
    ts.isIdentifier(call.arguments[0]) &&
    call.arguments[0].text === "storeId" &&
    isStringLiteralLike(call.arguments[1]);
  if (!gateOk) {
    report(page, "page-gate-first", gateShape);
    return { violations: violations.sort(byLine), capability: null };
  }
  return { violations: violations.sort(byLine), capability: call.arguments[1].text };
}

/**
 * All four rules over the given repo-relative files.
 * @param {string[]} files
 * @param {(file: string) => string | null} readFile returns null if unreadable
 */
export function checkRepo(files, readFile, allowlist = PUBLIC_ACTIONS) {
  const violations = [];
  const guarded = [];
  const publicActions = [];
  const pages = [];
  const exported = new Set();

  for (const file of files) {
    if (!file.startsWith("apps/web/") || !CODE.test(file)) continue;
    const source = readFile(file);
    if (source === null) continue;
    const sourceFile = parse(file, source);
    const inActions = file.startsWith(ACTIONS_DIR);

    const useServer = moduleDirective(sourceFile, "use server");
    if (useServer && !inActions) {
      violations.push({
        file,
        line: lineOf(sourceFile, useServer),
        rule: "use-server-outside-actions",
        why: `a "use server" module must live under ${ACTIONS_DIR}, where this guard checks it`,
      });
    }
    for (const directive of inlineUseServer(sourceFile)) {
      violations.push({
        file,
        line: lineOf(sourceFile, directive),
        rule: "use-server-outside-actions",
        why: `inline "use server" functions are not checked: export the action from a module under ${ACTIONS_DIR}`,
      });
    }

    if (useServer && inActions) {
      const result = checkActionsModule(file, source, allowlist);
      violations.push(...result.violations);
      guarded.push(...result.guarded.map((g) => ({ file, ...g })));
      publicActions.push(...result.public.map((name) => `${file}#${name}`));
      for (const name of result.exports) exported.add(`${file}#${name}`);
    }

    if (DASHBOARD_STORE_PAGE.test(file)) {
      const result = checkDashboardPage(file, source);
      violations.push(...result.violations);
      if (result.capability !== null) pages.push([file, result.capability]);
    }
  }

  for (const key of allowlist.keys()) {
    if (exported.has(key)) continue;
    const [file, name] = key.split("#");
    violations.push({
      file,
      line: 1,
      rule: "stale-allowlist",
      why: `PUBLIC_ACTIONS lists ${name}, which is not an export of a "use server" module in ${file}: remove the entry`,
    });
  }

  return { violations, guarded, public: publicActions, pages };
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z", "--", "apps/web"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const readFile = (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null; // tracked but deleted in the working tree
    }
  };

  const { violations, guarded, public: publicActions, pages } = checkRepo(files, readFile);
  for (const v of violations) {
    console.error(`${v.file}:${v.line}: [${v.rule}] ${v.why}`);
  }
  if (violations.length > 0) {
    console.error(`\n${violations.length} action guard violation(s) found.`);
    process.exit(1);
  }
  const byStore = guarded.filter((g) => g.guard === "authorizeStore");
  console.log(
    `action-guard: ${guarded.length} actions guarded (${byStore.length} by authorizeStore, ` +
      `${guarded.length - byStore.length} by requireOperator), ${publicActions.length} public by allowlist, ` +
      `${pages.length} Store dashboard pages gated`,
  );
  for (const g of guarded) {
    console.log(`  ${g.file.slice(ACTIONS_DIR.length)}#${g.name}: ${g.capability ?? "Operator"}`);
  }
  for (const [file, capability] of pages) {
    console.log(`  ${file.slice("apps/web/app/".length)}: ${capability}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
