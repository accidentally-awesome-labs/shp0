export const instant = false;
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { getMyStores } from "@/app/actions/stores";

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    redirect("/sign-in?redirect=/dashboard");
  }

  const stores = await getMyStores();

  // No stores yet → onboarding.
  if (stores.length === 0) {
    redirect("/dashboard/onboarding");
  }

  return (
    <main className="min-h-screen p-8">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <p className="mt-1 text-gray-600">
              Welcome, {session.user.name}.
            </p>
          </div>
        </div>

        {/* Store switcher */}
        <div className="mt-8">
          <h2 className="mb-3 text-sm font-medium text-gray-700">Your stores</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {stores.map((s) => (
              <a
                key={s.storeId}
                href={`/dashboard/${s.storeId}`}
                className="block rounded-lg border p-4 hover:border-black hover:shadow-sm transition"
              >
                <div className="font-semibold">{s.storeName}</div>
                <div className="mt-1 text-sm text-gray-500">
                  {s.subdomain}.shp0.dev
                </div>
                <div className="mt-2">
                  <span className="inline-block rounded bg-gray-100 px-2 py-0.5 text-xs capitalize text-gray-600">
                    {s.role}
                  </span>
                </div>
              </a>
            ))}
          </div>
        </div>

        <div className="mt-8 rounded-lg border border-dashed p-6 text-center text-sm text-gray-500">
          Store management (products, orders, settings) comes in upcoming issues.
        </div>
      </div>
    </main>
  );
}

