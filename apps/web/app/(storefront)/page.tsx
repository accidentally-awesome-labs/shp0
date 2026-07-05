import { Suspense } from "react";

import StorefrontListing from "./listing";

/**
 * Storefront root — resolves the Current Store from the host (subdomain).
 *
 * PPR: the outer page is the static shell. The dynamic listing (per-Store data)
 * is wrapped in Suspense so it streams in while the shell is served instantly.
 */
export default async function StorefrontPage() {
  return (
    <main className="min-h-screen">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-24 text-gray-400">
            Loading store…
          </div>
        }
      >
        <StorefrontListing />
      </Suspense>
    </main>
  );
}
