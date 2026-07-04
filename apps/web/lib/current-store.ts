import { headers } from "next/headers";

import {
  parseSubdomain,
  authorizeStoreMembership,
  resolveStoreBySubdomain,
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
 * Extracts the subdomain from the host (e.g. "acme.shp0.dev" → "acme"),
 * then looks up the Store by subdomain. Returns null if the host doesn't
 * map to a Store (platform domain, localhost, unknown subdomain).
 *
 * In local dev, there's no real subdomain — this returns null, and the
 * storefront shows a dev fallback.
 */
export async function resolveStorefrontStore(): Promise<string | null> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";

  const subdomain = parseSubdomain(host);
  if (!subdomain) return null;

  return resolveStoreBySubdomain(subdomain);
}
