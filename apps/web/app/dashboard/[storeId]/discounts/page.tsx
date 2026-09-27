export const instant = false;

import Link from "next/link";

import { can } from "@shp0/db/roles";
import { getDashboardDiscounts } from "@/app/actions/discounts";
import { authorizeStorePage } from "@/lib/current-store";
import { RequiresRole } from "@/app/dashboard/requires-role";

export default async function DiscountsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await authorizeStorePage(storeId, "discounts.view");
  if (access.status !== "ok") return <RequiresRole role={access.required} storeId={storeId} />;

  const discounts = await getDashboardDiscounts(storeId);

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Discounts</h1>
        {can(access.role, "discounts.manage") && (
          <Link
            href={`/dashboard/${storeId}/discounts/new`}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            New Discount
          </Link>
        )}
      </div>

      {discounts.length === 0 ? (
        <p className="text-gray-500">
          {can(access.role, "discounts.manage")
            ? "No discounts yet. Create one to run promotions."
            : "No discounts yet."}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {discounts.map((d) => (
            <li key={d.id} className="flex items-center justify-between p-4">
              <div>
                <p className="font-medium">{d.name}</p>
                <p className="text-sm text-gray-500">
                  Used {d.usageCount} times · {d.active ? "Active" : "Inactive"}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
