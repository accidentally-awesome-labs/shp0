import Link from "next/link";

import { resolveStorefrontStore } from "@/lib/current-store";
import { listPublishedProducts, formatMoney } from "@shp0/db";

/**
 * Storefront listing — the dynamic hole. Resolves the Store from the host,
 * then renders the published product grid.
 */
export default async function StorefrontListing() {
  const storeId = await resolveStorefrontStore();

  if (!storeId) {
    return (
      <div className="flex items-center justify-center py-24 text-center">
        <div>
          <h1 className="text-2xl font-bold">shp0</h1>
          <p className="mt-2 text-gray-600">
            Storefront pages render at{" "}
            <code className="rounded bg-gray-100 px-1">
              yourstore.shp0.dev
            </code>
            .
          </p>
          <p className="mt-1 text-sm text-gray-400">
            In local dev, visit{" "}
            <code className="rounded bg-gray-100 px-1">
              /product/&lt;slug&gt;
            </code>{" "}
            to test rendering.
          </p>
        </div>
      </div>
    );
  }

  const products = await listPublishedProducts(storeId);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold">All Products</h1>

      {products.length === 0 ? (
        <p className="mt-8 text-gray-500">No products available yet.</p>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => (
            <Link
              key={p.id}
              href={`/product/${p.slug}`}
              className="block rounded-lg border p-4 transition hover:border-black hover:shadow-sm"
            >
              <div className="aspect-square rounded bg-gray-100" />
              <h2 className="mt-3 font-semibold">{p.title}</h2>
              <p className="mt-1 text-sm text-gray-600">
                {formatMoney(p.minPriceCents, "USD") as string}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
