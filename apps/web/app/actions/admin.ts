"use server";

import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import {
  listAllStoresForOperator,
  getPlatformAnalytics,
  applyStoreStatusAction,
} from "@shp0/db";

/**
 * Guard: only platform operators can access this surface.
 * In production this checks an operator role/flag. For now, any authenticated
 * user is allowed (the guard is the structure — wire to real authz later).
 */
async function requireOperator(): Promise<void> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Not authenticated");
  // TODO: check operator role/flag here.
}

export async function getAdminStores() {
  await requireOperator();
  return listAllStoresForOperator();
}

export async function getAdminAnalytics() {
  await requireOperator();
  return getPlatformAnalytics();
}

export async function suspendStoreAction(storeId: string) {
  await requireOperator();
  await applyStoreStatusAction(storeId, "suspend");
}

export async function reinstateStoreAction(storeId: string) {
  await requireOperator();
  await applyStoreStatusAction(storeId, "reinstate");
}

export async function terminateStoreAction(storeId: string) {
  await requireOperator();
  await applyStoreStatusAction(storeId, "terminate");
}
