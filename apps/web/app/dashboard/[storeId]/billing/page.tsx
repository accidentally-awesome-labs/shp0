export const instant = false;

import { changeTierAction, getDashboardBilling } from "@/app/actions/billing";

export default async function BillingPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const { tier, usage, tiers } = await getDashboardBilling(storeId);

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-2 text-2xl font-bold">Billing</h1>
      <p className="mb-8 text-gray-500">
        Current plan: <strong>{tier.name}</strong> — {tier.commissionBps / 100}% commission
      </p>

      <div className="mb-8 rounded-lg border p-4">
        <h2 className="mb-3 font-medium">Usage this month</h2>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-gray-500">Products</dt>
            <dd className="font-medium">{usage.productCount} / {tier.limits.maxProducts}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Orders</dt>
            <dd className="font-medium">{usage.orderCountThisMonth} / {tier.limits.maxOrdersPerMonth}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Staff Seats</dt>
            <dd className="font-medium">{usage.staffSeats} / {tier.limits.maxStaffSeats}</dd>
          </div>
        </dl>
      </div>

      <h2 className="mb-4 font-medium">Change Plan</h2>
      <div className="grid grid-cols-3 gap-4">
        {(["free", "pro", "scale"] as const).map((id) => {
          const t = tiers[id];
          const isCurrent = tier.id === id;
          return (
            <div
              key={id}
              className={`rounded-lg border p-4 ${isCurrent ? "border-blue-600 ring-1 ring-blue-600" : ""}`}
            >
              <h3 className="font-bold capitalize">{t.name}</h3>
              <p className="text-2xl font-bold">
                ${(t.priceCents / 100).toFixed(0)}
                <span className="text-sm font-normal text-gray-500">/mo</span>
              </p>
              <p className="mt-2 text-sm text-gray-600">{(t.commissionBps / 100)}% commission</p>
              <ul className="mt-2 space-y-1 text-xs text-gray-500">
                <li>{t.limits.maxProducts} products</li>
                <li>{t.limits.maxOrdersPerMonth} orders/mo</li>
                <li>{t.limits.maxStaffSeats} staff seats</li>
              </ul>
              {!isCurrent && (
                <form action={changeTierAction.bind(null, storeId)} className="mt-4">
                  <input type="hidden" name="tierId" value={id} />
                  <button
                    type="submit"
                    className="w-full rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    Switch to {t.name}
                  </button>
                </form>
              )}
              {isCurrent && (
                <p className="mt-4 text-center text-xs font-medium text-blue-600">Current plan</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
