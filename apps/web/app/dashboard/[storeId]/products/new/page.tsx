export const instant = false;

import { RequiresRole } from "@/app/dashboard/requires-role";
import { authorizeStorePage } from "@/lib/current-store";
import { NewProductForm } from "./new-product-form";

export default async function NewProductPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await authorizeStorePage(storeId, "catalog.manage");
  if (access.status !== "ok") return <RequiresRole role={access.required} storeId={storeId} />;

  return <NewProductForm storeId={storeId} />;
}
