"use server";

import { requireOperator } from "@/lib/operator";
import {
  listAllStoresForOperator,
  getPlatformAnalytics,
  applyStoreStatusAction,
} from "@shp0/db";

/**
 * Operator (platform admin) server actions — Issue #16, guarded per Issue #52.
 *
 * Each export here is callable directly over HTTP by its action id, not only
 * through the admin page, so each one calls requireOperator() before it
 * touches data. Only Operators (SHP0_OPERATOR_USER_IDS) get past it.
 */

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
