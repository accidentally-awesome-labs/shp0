import { headers } from "next/headers";

import { authorizeStoreMembership, resolveStoreByHost } from "@shp0/db";
import { auth } from "@/lib/auth";

/**
 * Resolve the Current Store for a dashboard request.
 *
 * The Store is the Merchant's selection (from the URL). It's only honored if
 * the session Merchant holds an active Membership for it — otherwise null
 * (rejected). This is the authorization layer above RLS.
 *
 * Returns { storeId, user } on success, or null if the Merchant isn't authorized
 * for this Store (or isn't signed in).
 */
export async function resolveDashboardStore(storeId: string): Promise<{
  storeId: string;
  userId: string;
} | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  const authorized = await authorizeStoreMembership(
    session.user.id,
    storeId,
  );
  if (!authorized) return null;

  return { storeId, userId: session.user.id };
}

/**
 * Resolve the Current Store for a storefront request, from the request host.
 *
 * The host is normalized (lowercase, port and trailing dot stripped), then
 * (ADR-0005, Issue #58):
 * - The platform domain and its subdomains are resolved by Subdomain ONLY
 *   (e.g. "acme.shp0.dev" → "acme"). They are never looked up in the Custom
 *   Domain table, so a bad row there cannot take over another Store's
 *   Subdomain or a platform host.
 * - Any other host resolves only through a VERIFIED Custom Domain
 *   (security — pending/failed do not serve).
 *
 * Returns null if the host doesn't map to a Store.
 */
export async function resolveStorefrontStore(): Promise<string | null> {
  const h = await headers();
  return resolveStoreByHost(h.get("host") ?? "localhost:3000");
}
