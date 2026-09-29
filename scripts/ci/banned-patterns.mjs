#!/usr/bin/env node
// Fails CI when a tracked file contains a banned pattern. Each rule says why.
// Run from the repo root: node scripts/ci/banned-patterns.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES = [
  {
    id: "no-db-push",
    why: "drizzle-kit push drops the RLS policies, grants and constraints that schema.ts does not declare",
    files: /\.(?:json|ya?ml|sh|[cm]?[jt]sx?)$/,
    pattern: /\bdb:push\b|\bdrizzle-kit\s+push\b/,
  },
  {
    id: "no-focused-tests",
    why: "it.only / describe.only / test.only silently skip the rest of the suite",
    files: /\.(?:test|spec)\.[cm]?[jt]sx?$/,
    pattern: /\b(?:it|describe|test)\.only\s*\(/,
  },
  {
    id: "apply-schema-in-tests-only",
    why: "applySchema() is the test bootstrap, not a migration path",
    files: /\.[cm]?[jt]sx?$/,
    allowPath: /(?:^|\/)tests?\//,
    pattern: /\bapplySchema\s*\(/,
    ignoreLine: /^\s*(?:\/\/|\*|\/\*)|\bfunction\s+applySchema\s*\(/,
  },
  // The storefront's Order and Cart fixes live in @shp0/db; these keep app
  // code from calling around them. Store dashboard pages are gated by
  // authorizeStorePage (scripts/ci/action-guard.mjs), so they may read any
  // Order of their Store; a Merchant action that needs getOrder must be
  // reviewed and added to allowPath.
  {
    id: "no-store-wide-order-read-in-app",
    why: "getOrder returns ANY Order of the Store to whoever asks; storefront code uses getStorefrontOrder / getOrderForCheckout, which require the cart token that placed the Order",
    files: /^apps\/.*\.[cm]?[jt]sx?$/,
    allowPath: /^apps\/web\/app\/dashboard\//,
    pattern: /\bgetOrder\s*\(/,
    ignoreLine: /^\s*(?:\/\/|\*|\/\*)/,
  },
  {
    id: "no-unvalidated-cart-write-in-app",
    why: "saveDbCartLines and getOrCreateDbCart store any Variant id and quantity unchecked; storefront Cart changes go through changeDbCart (a published Variant of the Store, quantity 1 to MAX_LINE_QUANTITY)",
    files: /^apps\/.*\.[cm]?[jt]sx?$/,
    pattern: /\b(?:saveDbCartLines|getOrCreateDbCart)\s*\(/,
    ignoreLine: /^\s*(?:\/\/|\*|\/\*)/,
  },
  {
    id: "no-checkout-bookkeeping-in-app",
    why: "reserveCheckoutAttempt, recordCheckoutSession and endCheckoutAttempt change any Order of the Store without its cart token; Pay goes through startCheckout (@shp0/payments), which matches the Order to the cart token first",
    files: /^apps\/.*\.[cm]?[jt]sx?$/,
    pattern: /\b(?:reserveCheckoutAttempt|recordCheckoutSession|endCheckoutAttempt)\s*\(/,
    ignoreLine: /^\s*(?:\/\/|\*|\/\*)/,
  },
];

// These two files necessarily contain the patterns they ban.
const SELF = new Set([
  "scripts/ci/banned-patterns.mjs",
  "scripts/ci/banned-patterns.test.mjs",
]);

/**
 * @param {string[]} files repo-relative paths
 * @param {(file: string) => string | null} readFile returns null if unreadable
 */
export function scan(files, readFile) {
  const violations = [];
  for (const file of files) {
    if (SELF.has(file)) continue;
    const rules = RULES.filter(
      (rule) => rule.files.test(file) && !(rule.allowPath && rule.allowPath.test(file)),
    );
    if (rules.length === 0) continue;
    const content = readFile(file);
    if (content === null) continue;
    content.split("\n").forEach((line, index) => {
      for (const rule of rules) {
        if (rule.ignoreLine && rule.ignoreLine.test(line)) continue;
        if (rule.pattern.test(line)) {
          violations.push({ file, line: index + 1, rule: rule.id, why: rule.why, text: line.trim() });
        }
      }
    });
  }
  return violations;
}

function main() {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const violations = scan(files, (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null; // tracked but deleted in the working tree
    }
  });
  for (const v of violations) {
    console.error(`${v.file}:${v.line}: [${v.rule}] ${v.why}\n    ${v.text}`);
  }
  if (violations.length > 0) {
    console.error(`\n${violations.length} banned pattern(s) found.`);
    process.exit(1);
  }
  console.log(`banned-patterns: ${files.length} tracked files clean`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
