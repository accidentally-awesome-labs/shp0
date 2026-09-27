export const instant = false;

import { can, type Capability } from "@shp0/db/roles";
import { listMemberships } from "@shp0/db";
import { RequiresRole } from "@/app/dashboard/requires-role";
import { authorizeStorePage } from "@/lib/current-store";

// Dashboard sections and the capability each page requires. The pages gate
// themselves; this only hides links the Merchant's Role cannot use.
const SECTIONS: Array<{ path: string; title: string; description: string; capability: Capability }> = [
  {
    path: "products",
    title: "Products",
    description: "Manage your catalog — products, variants, pricing.",
    capability: "catalog.view",
  },
  {
    path: "collections",
    title: "Collections",
    description: "Group products for your storefront.",
    capability: "catalog.view",
  },
  {
    path: "discounts",
    title: "Discounts",
    description: "Codes and automatic discounts.",
    capability: "discounts.view",
  },
  { path: "customers", title: "Customers", description: "People who buy from this Store.", capability: "customers.view" },
  {
    path: "domains",
    title: "Custom Domains",
    description: "Serve your Store on your own domain.",
    capability: "domains.manage",
  },
  { path: "billing", title: "Billing", description: "Your Tier and Usage.", capability: "billing.view" },
];

export default async function StoreDashboardPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  // Authorization gate: any valid Role in this Store. A non-member gets the
  // not-found page (don't leak that the Store exists).
  const access = await authorizeStorePage(storeId, "store.view");
  if (access.status !== "ok") return <RequiresRole role={access.required} storeId={storeId} />;

  // The Store's name and Subdomain, from the Merchant's own Memberships.
  const memberships = await listMemberships(access.userId);
  const current = memberships.find((m) => m.storeId === storeId);

  return (
    <main className="min-h-screen p-8">
      <div className="mx-auto max-w-4xl">
        <a
          href="/dashboard"
          className="text-sm text-gray-500 hover:text-black"
        >
          ← All stores
        </a>
        <h1 className="mt-2 text-2xl font-bold">{current?.storeName ?? "Store"}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {current?.subdomain}.shp0.dev ·{" "}
          <span className="capitalize">{access.role}</span>
        </p>

        <div className="mt-8 space-y-4">
          {SECTIONS.filter((section) => can(access.role, section.capability)).map((section) => (
            <a
              key={section.path}
              href={`/dashboard/${storeId}/${section.path}`}
              className="block rounded-lg border p-4 hover:border-black hover:shadow-sm transition"
            >
              <div className="font-semibold">{section.title}</div>
              <div className="mt-1 text-sm text-gray-500">{section.description}</div>
            </a>
          ))}

          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-gray-500">
            Orders, settings, and more come in upcoming issues.
          </div>
        </div>
      </div>
    </main>
  );
}
