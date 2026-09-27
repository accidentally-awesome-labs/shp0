import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { signInPath } from "@shp0/auth/redirect";
import {
  decideStoreAccess,
  getMembershipRole,
  isCapability,
  resolveStoreByHost,
  type Capability,
  type Role,
} from "@shp0/db";
import { auth } from "@/lib/auth";

export type { Capability, Role };

/**
 * The one error every dashboard server action throws when the caller may not
 * act on the Store: not signed in, no Membership (or no such Store) and a
 * Role below the capability's minimum all read the same, so the answer never
 * reveals whether a Store exists.
 */
export const NOT_AUTHORIZED_FOR_STORE = "Not authorized for this store";

/** The Merchant's standing in a Store for one capability. */
export type StoreAccess =
  | { status: "unauthenticated" }
  /** No Membership with a valid Role, or no such Store: indistinguishable. */
  | { status: "not_member" }
  | { status: "insufficient_role"; storeId: string; userId: string; role: Role; required: Role }
  | { status: "ok"; storeId: string; userId: string; role: Role };

export type AuthorizedStore = { storeId: string; userId: string; role: Role };

/**
 * React cache() dedupes these lookups within one server render (a page's
 * gate plus the data functions it then calls). It never spans requests, and
 * a server action invoked over HTTP runs its own checks.
 */
const getSessionUserId = cache(async (): Promise<string | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user.id ?? null;
});

const getRole = cache((userId: string, storeId: string) => getMembershipRole(userId, storeId));

/**
 * The Current Store for a dashboard request: the Merchant's selection (a URL
 * segment or an action argument) is honored only with a Membership whose Role
 * ranks at or above `capability`'s minimum (packages/db/src/roles.ts). This
 * is the authorization layer above RLS; RLS then scopes every query to the
 * Store id it is given.
 *
 * `storeId` is untrusted (any value can arrive through a server action), so
 * anything that is not a Store id the Merchant belongs to is "not_member".
 * The decision itself is decideStoreAccess (packages/db/src/roles.ts, unit
 * tested); this function only looks up its inputs.
 */
export async function getStoreAccess(storeId: unknown, capability: Capability): Promise<StoreAccess> {
  if (!isCapability(capability)) throw new Error(NOT_AUTHORIZED_FOR_STORE);
  const userId = await getSessionUserId();
  const role = userId !== null && typeof storeId === "string" ? await getRole(userId, storeId) : null;
  const decision = decideStoreAccess(userId !== null, role, capability);
  if (decision.status === "unauthenticated" || decision.status === "not_member") return decision;
  // A Role was found, so there is a session and a string Store id.
  if (userId === null || typeof storeId !== "string") return { status: "not_member" };
  return { ...decision, storeId, userId };
}

/**
 * Authorize a dashboard server action or data function, or throw the generic
 * NOT_AUTHORIZED_FOR_STORE error.
 *
 * Call it as the FIRST statement of every exported dashboard action, with the
 * action's own storeId parameter and a capability literal:
 *
 *   await authorizeStore(storeId, "catalog.manage");
 *
 * Every export of a "use server" module is callable over HTTP by its action
 * id with any arguments, whether or not a page renders it; CI checks the
 * wiring (scripts/ci/action-guard.mjs). Use only the Store id it was given for
 * data access afterwards.
 */
export async function authorizeStore(storeId: string, capability: Capability): Promise<AuthorizedStore> {
  const access = await getStoreAccess(storeId, capability);
  if (access.status !== "ok") throw new Error(NOT_AUTHORIZED_FOR_STORE);
  return { storeId: access.storeId, userId: access.userId, role: access.role };
}

/**
 * Gate a page under /dashboard/[storeId] before it fetches anything:
 *
 *   const { storeId } = await params;
 *   const access = await authorizeStorePage(storeId, "catalog.view");
 *   if (access.status !== "ok") return <RequiresRole role={access.required} />;
 *
 * - Not signed in (the proxy only checks that a cookie is present, so this
 *   is a stale, revoked or forged one): redirect to sign-in, returning to
 *   the Store's dashboard afterwards.
 * - No Membership, or no such Store: notFound(), exactly alike.
 * - A member whose Role is too low: returned, so the page can say which Role
 *   it requires (they already know the Store exists) without fetching the
 *   protected data.
 *
 * The check reads the session from the request, so a gated page renders per
 * request. Do not add "use cache" to anything below the gate. As with
 * /admin, these routes resume from a postponed shell that has already
 * committed to 200, so notFound() renders the not-found page rather than an
 * HTTP 404 and redirect() becomes a client-side redirect.
 */
export async function authorizeStorePage(
  storeId: string,
  capability: Capability,
): Promise<
  | ({ status: "ok" } & AuthorizedStore)
  | { status: "insufficient_role"; role: Role; required: Role }
> {
  const access = await getStoreAccess(storeId, capability);
  switch (access.status) {
    case "unauthenticated":
      // The gate does not know which page asked, so return to the Store's
      // dashboard. storeId is untrusted: it is one encoded path segment, and
      // signInPath and the sign-in page accept only a same-origin path.
      redirect(signInPath(`/dashboard/${encodeURIComponent(storeId)}`));
    case "not_member":
      notFound();
    case "insufficient_role":
      return { status: "insufficient_role", role: access.role, required: access.required };
    case "ok":
      return access;
  }
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
