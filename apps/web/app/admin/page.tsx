export const instant = false;

import {
  getAdminStores,
  getAdminAnalytics,
  suspendStoreAction,
  reinstateStoreAction,
  terminateStoreAction,
} from "@/app/actions/admin";

export default async function AdminPage() {
  const [stores, analytics] = await Promise.all([getAdminStores(), getAdminAnalytics()]);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <h1 className="mb-8 text-2xl font-bold">Platform Admin</h1>

      <div className="mb-8 grid grid-cols-4 gap-4">
        <div className="rounded-lg border p-4">
          <dt className="text-sm text-gray-500">Total Stores</dt>
          <dd className="text-2xl font-bold">{analytics.totalStores}</dd>
        </div>
        <div className="rounded-lg border p-4">
          <dt className="text-sm text-gray-500">Active</dt>
          <dd className="text-2xl font-bold text-green-600">{analytics.activeStores}</dd>
        </div>
        <div className="rounded-lg border p-4">
          <dt className="text-sm text-gray-500">Total Orders</dt>
          <dd className="text-2xl font-bold">{analytics.totalOrders}</dd>
        </div>
        <div className="rounded-lg border p-4">
          <dt className="text-sm text-gray-500">GMV</dt>
          <dd className="text-2xl font-bold">${(analytics.gmvCents / 100).toFixed(2)}</dd>
        </div>
      </div>

      <h2 className="mb-4 text-lg font-medium">Stores</h2>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b text-left text-sm text-gray-500">
            <th className="py-2">Store</th>
            <th className="py-2">Owner</th>
            <th className="py-2">Orders</th>
            <th className="py-2">Status</th>
            <th className="py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {stores.map((store) => (
            <tr key={store.id} className="border-b">
              <td className="py-3">
                <div className="font-medium">{store.name}</div>
                <div className="text-xs text-gray-500">{store.subdomain}</div>
              </td>
              <td className="py-3 text-sm">{store.ownerEmail ?? "—"}</td>
              <td className="py-3 text-sm">{store.orderCount}</td>
              <td className="py-3">
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${
                  store.status === "active" ? "bg-green-100 text-green-700" :
                  store.status === "suspended" ? "bg-yellow-100 text-yellow-700" :
                  "bg-red-100 text-red-700"
                }`}>
                  {store.status}
                </span>
              </td>
              <td className="py-3">
                <div className="flex gap-2">
                  {store.status === "active" && (
                    <form action={suspendStoreAction.bind(null, store.id)}>
                      <button type="submit" className="rounded bg-yellow-600 px-2 py-1 text-xs text-white hover:bg-yellow-700">
                        Suspend
                      </button>
                    </form>
                  )}
                  {store.status === "suspended" && (
                    <>
                      <form action={reinstateStoreAction.bind(null, store.id)}>
                        <button type="submit" className="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700">
                          Reinstate
                        </button>
                      </form>
                      <form action={terminateStoreAction.bind(null, store.id)}>
                        <button type="submit" className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700">
                          Terminate
                        </button>
                      </form>
                    </>
                  )}
                  {store.status === "terminated" && (
                    <span className="text-xs text-gray-400">Terminal</span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
