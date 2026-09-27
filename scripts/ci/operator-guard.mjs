#!/usr/bin/env node
// Fails CI when a platform admin (Operator) entry point is not behind the
// Operator check (Issue #52). Run from the repo root: node scripts/ci/operator-guard.mjs
//
// Every export of a "use server" module can be called over HTTP by its action
// id, whether or not a page renders it, so the /admin page gate protects
// nothing by itself. The policy is unit-tested in packages/auth; this pins the
// wiring those tests cannot see:
//
//  1. apps/web/app/actions/admin.ts imports requireOperator from
//     "@/lib/operator", and nothing in it declares another requireOperator.
//  2. Each of its runtime exports is an async function declaration whose first
//     statement awaits requireOperator() (optionally binding the result).
//  3. No other file in apps/web mentions an operator-only @shp0/db helper, so
//     a new Operator entry point has to live in that file and pass rule 2.
//
// It parses TypeScript with the compiler apps/web already depends on.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ts = createRequire(new URL("../../apps/web/package.json", import.meta.url))("typescript");

export const OPERATOR_ACTIONS_FILE = "apps/web/app/actions/admin.ts";
const GUARD = "requireOperator";
const GUARD_MODULE = "@/lib/operator";

// Cross-Store @shp0/db helpers (platformClient, bypass RLS) for Operators only.
export const OPERATOR_HELPERS = new Set([
  "listAllStoresForOperator",
  "getPlatformAnalytics",
  "applyStoreStatusAction",
]);

const CODE = /\.[cm]?[jt]sx?$/;

function parse(file, source) {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

const hasModifier = (node, kind) => (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

/** `await requireOperator()`, exactly. */
function isAwaitedGuard(expression) {
  return (
    expression !== undefined &&
    ts.isAwaitExpression(expression) &&
    ts.isCallExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === GUARD &&
    expression.expression.arguments.length === 0
  );
}

/** `await requireOperator();` or `const x = await requireOperator();` */
function isGuardStatement(statement) {
  if (statement === undefined) return false;
  if (ts.isExpressionStatement(statement)) return isAwaitedGuard(statement.expression);
  if (ts.isVariableStatement(statement)) {
    const [declaration, ...rest] = statement.declarationList.declarations;
    return rest.length === 0 && isAwaitedGuard(declaration?.initializer);
  }
  return false;
}

/**
 * Rules 1 and 2 on the Operator actions file.
 * @returns {{ violations: object[], guarded: string[] }}
 */
export function checkOperatorActions(source, file = OPERATOR_ACTIONS_FILE) {
  const sourceFile = parse(file, source);
  const violations = [];
  const guarded = [];
  const report = (node, rule, why) =>
    violations.push({ file, line: lineOf(sourceFile, node), rule, why });

  // Rule 1: the one allowed binding of requireOperator is the import.
  let guardImport = null;
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== GUARD_MODULE ||
      statement.importClause?.isTypeOnly
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (!element.isTypeOnly && imported === GUARD && element.name.text === GUARD) {
        guardImport = element;
      }
    }
  }
  if (guardImport === null) {
    report(
      sourceFile.statements[0] ?? sourceFile,
      "guard-imported",
      `import { ${GUARD} } from "${GUARD_MODULE}" (the Operator allowlist check)`,
    );
  }
  const visit = (node) => {
    if (
      node !== guardImport &&
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
      node.name.text === GUARD
    ) {
      report(node, "guard-not-redefined", `only "${GUARD_MODULE}" may define ${GUARD}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  // Rule 2: every runtime export is a guarded async function declaration.
  const shape = `every export must be \`export async function name(...) { await ${GUARD}(); ... }\``;
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
    if (isGuardStatement(statement.body.statements[0])) {
      guarded.push(name);
    } else {
      report(
        statement,
        "guard-first",
        `${name}() is callable over HTTP by its action id: its first statement must be \`await ${GUARD}();\``,
      );
    }
  }

  return { violations, guarded };
}

/**
 * Rule 3: operator-only helpers are referenced nowhere in apps/web but the
 * Operator actions file (identifiers only; comments and strings are ignored).
 * @param {string[]} files repo-relative paths
 * @param {(file: string) => string | null} readFile returns null if unreadable
 */
export function checkOperatorHelperUse(files, readFile) {
  const violations = [];
  for (const file of files) {
    if (file === OPERATOR_ACTIONS_FILE || !file.startsWith("apps/web/") || !CODE.test(file)) {
      continue;
    }
    const source = readFile(file);
    if (source === null) continue;
    const sourceFile = parse(file, source);
    const reported = new Set();
    const visit = (node) => {
      if (ts.isIdentifier(node) && OPERATOR_HELPERS.has(node.text)) {
        const line = lineOf(sourceFile, node);
        if (!reported.has(line)) {
          reported.add(line);
          violations.push({
            file,
            line,
            rule: "operator-helper-outside-guard",
            why: `${node.text} is Operator-only: call it from ${OPERATOR_ACTIONS_FILE}, behind ${GUARD}()`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return violations;
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

  const source = readFile(OPERATOR_ACTIONS_FILE);
  const { violations, guarded } =
    source === null
      ? {
          violations: [
            { file: OPERATOR_ACTIONS_FILE, line: 1, rule: "actions-file", why: "file not found" },
          ],
          guarded: [],
        }
      : checkOperatorActions(source);
  violations.push(...checkOperatorHelperUse(files, readFile));

  for (const v of violations) {
    console.error(`${v.file}:${v.line}: [${v.rule}] ${v.why}`);
  }
  if (violations.length > 0) {
    console.error(`\n${violations.length} Operator guard violation(s) found.`);
    process.exit(1);
  }
  console.log(
    `operator-guard: ${guarded.length} operator actions guarded (${guarded.join(", ")}); ` +
      `operator helpers referenced only in ${OPERATOR_ACTIONS_FILE}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
