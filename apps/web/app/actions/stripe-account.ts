"use server";

import { headers } from "next/headers";

import { authorizeStore } from "@/lib/current-store";
import { getStripe } from "@/lib/stripe";
import { connectStripeAccount, describeFailure, syncStripeAccount, type StripeAccountView } from "@shp0/payments";

/** What the Payments page's Connect button does next. */
export type ConnectResult =
  | { kind: "stripe"; url: string }
  | { kind: "active" }
  | { kind: "error"; reason: "busy" | "unavailable" | "closed" | "missing" | "failed" };

/**
 * Connect (ADR-0006 point 2): set up, or continue setting up, the Store's own
 * Stripe account. Connecting the Store's Stripe account is a Store setting:
 * Admin and above.
 *
 * Stripe returns the Admin to the Store's Payments page on the origin this
 * request came from (Next checks a server action's Origin against its Host).
 * The onboarding link is a bearer credential: it goes only to this caller,
 * and is never logged.
 */
export async function connectStripeAccountAction(storeId: string): Promise<ConnectResult> {
  await authorizeStore(storeId, "settings.manage");
  const origin = (await headers()).get("origin");
  if (!origin) return { kind: "error", reason: "failed" };
  try {
    const outcome = await connectStripeAccount({ stripe: getStripe }, { storeId, origin });
    if (outcome.kind === "onboarding") return { kind: "stripe", url: outcome.url };
    if (outcome.kind === "active") return { kind: "active" };
    return { kind: "error", reason: outcome.kind };
  } catch (error) {
    console.error(`Connect failed for Store ${storeId}: ${describeFailure(error)}`);
    return { kind: "error", reason: "failed" };
  }
}

/**
 * The Store's Stripe account for the Payments page, read from Stripe each
 * time (ADR-0006): Admin and above.
 */
export async function getStripeAccountStatus(storeId: string): Promise<StripeAccountView> {
  await authorizeStore(storeId, "settings.manage");
  return syncStripeAccount({ stripe: getStripe }, storeId);
}
