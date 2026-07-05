import { headers } from "next/headers";

import {
  parseSubdomain,
  authorizeStoreMembership,
  resolveStoreBySubdomain,
  resolveStoreByCustomDomain,
} from "@shp0/db";
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
 * Resolution order (ADR-0005):
 * 1. Custom Domain — if the host matches a VERIFIED custom domain, use it.
 * 2. Subdomain — extract subdomain from host (e.g. "acme.shp0.dev" → "acme").
 *
 * Returns null if the host doesn't map to a Store.
 * Only VERIFIED custom domains resolve (security — pending/failed do not serve).
 */
export async function resolveStorefrontStore(): Promise<string | null> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const hostname = host.split(":")[0]!; // strip port

  // 1. Check custom domains first (verified only).
  const customStoreId = await resolveStoreByCustomDomain(hostname);
  if (customStoreId) return customStoreId;

  // 2. Fall back to subdomain resolution.
  const subdomain = parseSubdomain(host);
  if (!subdomain) return null;

  return resolveStoreBySubdomain(subdomain);
}
