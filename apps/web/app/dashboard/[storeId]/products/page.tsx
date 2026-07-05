export const instant = false;
import Link from "next/link";
import { notFound } from "next/navigation";

import { resolveDashboardStore } from "@/lib/current-store";
import { getProducts } from "@/app/actions/products";

export default async function ProductsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) notFound();

  const products = await getProducts(storeId);

  return (
    <main className="min-h-screen p-8">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <div>
            <Link
              href={`/dashboard/${storeId}`}
              className="text-sm text-gray-500 hover:text-black"
            >
              ← Store
            </Link>
            <h1 className="mt-2 text-2xl font-bold">Products</h1>
          </div>
          <Link
            href={`/dashboard/${storeId}/products/new`}
            className="rounded bg-black px-4 py-2 text-sm text-white hover:bg-gray-800"
          >
            + Add product
          </Link>
        </div>

        {products.length === 0 ? (
          <div className="mt-8 rounded-lg border border-dashed p-12 text-center text-gray-500">
            No products yet. Click &quot;Add product&quot; to create your first.
          </div>
        ) : (
          <div className="mt-8 overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-gray-600">
                <tr>
                  <th className="px-4 py-3 font-medium">Title</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Variants</th>
                  <th className="px-4 py-3 font-medium">Price</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {products.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{p.title}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded px-2 py-0.5 text-xs capitalize ${p.status === "published" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {p.variants.length}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      ${(p.variants[0]?.priceCents ?? 0) / 100}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

