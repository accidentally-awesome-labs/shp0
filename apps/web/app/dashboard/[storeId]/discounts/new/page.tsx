export const instant = false;

import { createDiscountAction, previewDiscountAction } from "@/app/actions/discounts";

export default async function NewDiscountPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;

  return (
    <div className="mx-auto max-w-lg p-8">
      <h1 className="mb-6 text-2xl font-bold">New Discount</h1>
      <form action={createDiscountAction.bind(null, storeId)} className="space-y-4">
        <div>
          <label className="block text-sm font-medium">Name</label>
          <input name="name" required className="mt-1 w-full rounded border px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium">Trigger Type</label>
          <select name="triggerType" className="mt-1 w-full rounded border px-3 py-2">
            <option value="code">Code (customer enters at checkout)</option>
            <option value="automatic">Automatic (always on)</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium">Code (if code trigger)</label>
          <input name="code" className="mt-1 w-full rounded border px-3 py-2" placeholder="SAVE20" />
        </div>
        <div>
          <label className="block text-sm font-medium">Reward Type</label>
          <select name="rewardType" className="mt-1 w-full rounded border px-3 py-2">
            <option value="order_percent">Percentage off order</option>
            <option value="order_fixed">Fixed amount off order</option>
            <option value="free_shipping">Free shipping</option>
          </select>
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block text-sm font-medium">Percent % (if percent)</label>
            <input name="percent" type="number" step="0.01" className="mt-1 w-full rounded border px-3 py-2" />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium">Amount $ ( if fixed)</label>
            <input name="amount" type="number" step="0.01" className="mt-1 w-full rounded border px-3 py-2" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium">Usage Limit (optional)</label>
          <input name="usageLimit" type="number" className="mt-1 w-full rounded border px-3 py-2" placeholder="unlimited" />
        </div>
        <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Create Discount
        </button>
      </form>
    </div>
  );
}
