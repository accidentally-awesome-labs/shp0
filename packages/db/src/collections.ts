/**
 * Collections (Issue #11).
 *
 * Two types: Manual (explicit members via a join table) and Automated
 * (rule-based members evaluated at query time).
 *
 * This module's deep module is the rule evaluator — a pure function that
 * decides whether a product matches a collection's rule. The DB layer
 * translates rules into SQL filters, but this function is the single source
 * of truth for what "matches" means.
 */

/** A collection rule. Tag matches if the product has the tag; price_range
 * matches if the product's min variant price falls within [min, max]. */
export type CollectionRule =
  | { type: "tag"; tag: string }
  | { type: "price_range"; minCents?: number; maxCents?: number };

/** The product shape needed for rule evaluation. */
export type ProductForRule = {
  tags: string[];
  minPriceCents: number;
};

/**
 * Does this product match this collection rule?
 *
 * Pure function — no I/O. Tag rules check membership in the tags array.
 * Price range rules check inclusive bounds (min and/or max may be omitted
 * for one-sided ranges).
 */
export function matchesRule(rule: CollectionRule, product: ProductForRule): boolean {
  if (rule.type === "tag") {
    return product.tags.includes(rule.tag);
  }
  // price_range
  const { minCents, maxCents } = rule;
  if (minCents !== undefined && product.minPriceCents < minCents) return false;
  if (maxCents !== undefined && product.minPriceCents > maxCents) return false;
  return true;
}
