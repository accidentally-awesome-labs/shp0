export const instant = false;
import { notFound } from "next/navigation";
import Link from "next/link";

import { resolveStorefrontStore } from "@/lib/current-store";
import { getProductBySlug, formatMoney } from "@shp0/db";
import AddToCartButton from "./add-to-cart";
import VariantCartButton from "./variant-cart-button";

/**
 * Product detail page — resolves the Current Store from the host, then loads
 * the product by slug. Shows variants with a picker, out-of-stock marking,
 * and an add-to-Cart control.
 *
 * PPR: this is the dynamic hole — it resolves the Store + fetches the product.
 */
export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const storeId = await resolveStorefrontStore();

  if (!storeId) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500">
        Store not found.
      </div>
    );
  }

  const product = await getProductBySlug(storeId, slug);

  if (!product) notFound();

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/" className="text-sm text-gray-500 hover:text-black">
        ← All products
      </Link>

      <div className="mt-6 grid grid-cols-1 gap-8 md:grid-cols-2">
        {/* Image placeholder */}
        <div className="aspect-square rounded-lg bg-gray-100" />

        {/* Product info */}
        <div>
          <h1 className="text-2xl font-bold">{product.title}</h1>

          {product.description && (
            <p className="mt-3 text-gray-600">{product.description}</p>
          )}

          {/* Variants */}
          {product.variants.length === 1 ? (
            <div className="mt-6">
              <p className="text-xl font-semibold">
                {formatMoney(product.variants[0]!.priceCents, "USD") as string}
              </p>
              {product.variants[0]!.compareAtPriceCents && (
                <p className="text-sm text-gray-400 line-through">
                  {formatMoney(product.variants[0]!.compareAtPriceCents, "USD") as string}
                </p>
              )}
              <AddToCartButton
                variantId={product.variants[0]!.id}
                disabled={product.variants[0]!.inventory <= 0}
                outOfStock={product.variants[0]!.inventory <= 0}
              />
            </div>
          ) : (
            <div className="mt-6 space-y-3">
              <label className="block text-sm font-medium">Choose option</label>
              <select
                id="variant-select"
                className="w-full rounded border px-3 py-2"
                defaultValue=""
              >
                <option value="" disabled>
                  Select…
                </option>
                {product.variants.map((v) => (
                  <option key={v.id} value={v.id} disabled={v.inventory <= 0}>
                    {v.title} — {formatMoney(v.priceCents, "USD") as string}
                    {v.inventory <= 0 ? " (out of stock)" : ""}
                  </option>
                ))}
              </select>
              <VariantCartButton variants={product.variants} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
