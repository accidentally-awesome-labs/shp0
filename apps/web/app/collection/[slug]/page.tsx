import Link from "next/link";
import { notFound } from "next/navigation";

import { resolveStorefrontStore } from "@/lib/current-store";
import { getStorefrontCollectionBySlug } from "@shp0/db";

export const instant = false;

export default async function CollectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const storeId = await resolveStorefrontStore();
  if (!storeId) return notFound();

  const products = await getStorefrontCollectionBySlug(storeId, slug);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <h1 className="mb-8 text-3xl font-bold capitalize">{slug.replace(/-/g, " ")}</h1>

      {products.length === 0 ? (
        <p className="text-gray-500">No products in this collection yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => (
            <Link
              key={product.id}
              href={`/product/${product.slug}`}
              className="block rounded-lg border p-4 hover:shadow-md"
            >
              <h2 className="font-medium">{product.title}</h2>
              {product.priceCents && (
                <p className="text-sm text-gray-600">
                  ${(product.priceCents / 100).toFixed(2)}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
