import { notFound } from "next/navigation";

import { resolveDashboardStore } from "@/lib/current-store";
import { listMemberships } from "@shp0/db";

export default async function StoreDashboardPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;

  // Authorization gate: resolve the Current Store only if the Merchant
  // holds a Membership here. Otherwise 404 (don't leak that the Store exists).
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) notFound();

  // Show which Store we're in + the merchant's role.
  const memberships = await listMemberships(resolved.userId);
  const current = memberships.find((m) => m.storeId === storeId);

  return (
    <main className="min-h-screen p-8">
      <div className="mx-auto max-w-4xl">
        <a
          href="/dashboard"
          className="text-sm text-gray-500 hover:text-black"
        >
          ← All stores
        </a>
        <h1 className="mt-2 text-2xl font-bold">{current?.storeName ?? "Store"}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {current?.subdomain}.shp0.dev ·{" "}
          <span className="capitalize">{current?.role}</span>
        </p>

        <div className="mt-8 space-y-4">
          <a
            href={`/dashboard/${storeId}/products`}
            className="block rounded-lg border p-4 hover:border-black hover:shadow-sm transition"
          >
            <div className="font-semibold">Products</div>
            <div className="mt-1 text-sm text-gray-500">
              Manage your catalog — products, variants, pricing.
            </div>
          </a>

          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-gray-500">
            Orders, collections, settings, and more come in upcoming issues.
          </div>
        </div>
      </div>
    </main>
  );
}
