export const instant = false;
import { createCollectionAction } from "@/app/actions/collections";

export default async function NewCollectionPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;

  return (
    <div className="mx-auto max-w-lg p-8">
      <h1 className="mb-6 text-2xl font-bold">New Collection</h1>
      <form action={createCollectionAction.bind(null, storeId)} className="space-y-4">
        <div>
          <label className="block text-sm font-medium">Name</label>
          <input name="name" required className="mt-1 w-full rounded border px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium">Slug (optional)</label>
          <input name="slug" className="mt-1 w-full rounded border px-3 py-2" placeholder="auto-generated" />
        </div>
        <div>
          <label className="block text-sm font-medium">Type</label>
          <select name="type" className="mt-1 w-full rounded border px-3 py-2">
            <option value="manual">Manual (pick products)</option>
            <option value="automated">Automated (rule-based)</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium">Rule Type (automated only)</label>
          <select name="ruleType" className="mt-1 w-full rounded border px-3 py-2">
            <option value="tag">Tag</option>
            <option value="price_range">Price Range</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium">Tag (if tag rule)</label>
          <input name="tag" className="mt-1 w-full rounded border px-3 py-2" />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block text-sm font-medium">Min Price $ (if price range)</label>
            <input name="minPrice" type="number" step="0.01" className="mt-1 w-full rounded border px-3 py-2" />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-medium">Max Price $ (if price range)</label>
            <input name="maxPrice" type="number" step="0.01" className="mt-1 w-full rounded border px-3 py-2" />
          </div>
        </div>
        <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Create Collection
        </button>
      </form>
    </div>
  );
}
