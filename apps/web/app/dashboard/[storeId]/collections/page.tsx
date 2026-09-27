export const instant = false;
import Link from "next/link";

import { can } from "@shp0/db/roles";
import { getDashboardCollections } from "@/app/actions/collections";
import { authorizeStorePage } from "@/lib/current-store";
import { RequiresRole } from "@/app/dashboard/requires-role";

export default async function CollectionsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const access = await authorizeStorePage(storeId, "catalog.view");
  if (access.status !== "ok") return <RequiresRole role={access.required} storeId={storeId} />;

  const collections = await getDashboardCollections(storeId);

  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Collections</h1>
        {can(access.role, "catalog.manage") && (
          <Link
            href={`/dashboard/${storeId}/collections/new`}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            New Collection
          </Link>
        )}
      </div>

      {collections.length === 0 ? (
        <p className="text-gray-500">No collections yet. Create one to group your products.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {collections.map((col) => (
            <li key={col.id} className="flex items-center justify-between p-4">
              <div>
                <p className="font-medium">{col.name}</p>
                <p className="text-sm text-gray-500">
                  /{col.slug} · {col.type}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
