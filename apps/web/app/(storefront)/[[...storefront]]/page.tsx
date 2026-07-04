import { resolveStorefrontStore } from "@/lib/current-store";

/**
 * Storefront root — resolves the Current Store from the host (subdomain).
 *
 * In local dev (localhost:3000) there's no subdomain, so we show a dev message.
 * In production, each Store is served at <subdomain>.shp0.dev — middleware will
 * eventually route custom domains here too. This is the seam; the actual product
 * listing/detail pages come in Issue #7.
 */
export default async function StorefrontPage() {
  const storeId = await resolveStorefrontStore();

  if (!storeId) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8 text-center">
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
            Product pages come in Issue #7.
          </p>
        </div>
      </main>
    );
  }

  // Store resolved — storefront rendering (product listing) comes in Issue #7.
  return (
    <main className="flex min-h-screen items-center justify-center p-8 text-center">
      <div>
        <h1 className="text-2xl font-bold">Storefront</h1>
        <p className="mt-2 text-gray-600">
          Store <code className="rounded bg-gray-100 px-1">{storeId}</code>{" "}
          resolved. Product listing comes in Issue #7.
        </p>
      </div>
    </main>
  );
}
