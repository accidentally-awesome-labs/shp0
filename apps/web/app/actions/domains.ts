"use server";

import { revalidatePath } from "next/cache";

import { authorizeStore } from "@/lib/current-store";
import {
  addCustomDomain,
  listCustomDomains,
  applyDomainVerification,
  InvalidCustomDomainError,
} from "@shp0/db";

// Every action here is a public endpoint: each one authorizes the Merchant for
// the Store (a Membership with at least the Admin Role: Custom Domains are
// Store settings) before touching data, and every DB call is scoped by that
// Store's id.
//
// There is deliberately no "verify" action. A Custom Domain may only become
// verified through proof of DNS control, and automatic verification is not
// built yet (Issue #58), so nothing here can mark a domain verified.

export async function addDomainAction(
  storeId: string,
  _previous: { error: string | null; hostname: string },
  formData: FormData,
): Promise<{ error: string | null; hostname: string }> {
  await authorizeStore(storeId, "domains.manage");

  const raw = formData.get("hostname");
  const hostname = typeof raw === "string" ? raw : "";
  try {
    await addCustomDomain(storeId, hostname);
  } catch (error) {
    if (error instanceof InvalidCustomDomainError) return { error: error.message, hostname };
    throw error;
  }

  revalidatePath(`/dashboard/${storeId}/domains`);
  return { error: null, hostname: "" };
}

export async function retryDomainAction(storeId: string, domainId: string) {
  await authorizeStore(storeId, "domains.manage");
  // Scoped by store and domain: another Store's domain id changes nothing.
  await applyDomainVerification(storeId, domainId, "retry");
  revalidatePath(`/dashboard/${storeId}/domains`);
}

export async function getDashboardDomains(storeId: string) {
  await authorizeStore(storeId, "domains.manage");
  return listCustomDomains(storeId);
}
