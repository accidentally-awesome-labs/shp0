"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { createProductAction, deleteProductAction } from "@/app/actions/products";

export default function NewProductPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const storeId = (await params).storeId;
      const formData = new FormData(e.currentTarget);
      await createProductAction(storeId, formData);
      router.push(`/dashboard/${storeId}/products`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create product");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen p-8">
      <div className="mx-auto max-w-2xl">
        <button
          onClick={() => router.back()}
          className="text-sm text-gray-500 hover:text-black"
        >
          ← Back
        </button>
        <h1 className="mt-2 text-2xl font-bold">Add product</h1>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="title" className="block text-sm font-medium">
              Title
            </label>
            <input
              id="title"
              name="title"
              type="text"
              required
              className="mt-1 w-full rounded border px-3 py-2"
              placeholder="Cotton T-Shirt"
            />
          </div>

          <div>
            <label htmlFor="slug" className="block text-sm font-medium">
              Slug <span className="text-gray-400">(leave blank to auto-generate)</span>
            </label>
            <input
              id="slug"
              name="slug"
              type="text"
              className="mt-1 w-full rounded border px-3 py-2"
              placeholder="cotton-t-shirt"
            />
          </div>

          <div>
            <label htmlFor="description" className="block text-sm font-medium">
              Description
            </label>
            <textarea
              id="description"
              name="description"
              rows={3}
              className="mt-1 w-full rounded border px-3 py-2"
              placeholder="A soft, breathable cotton tee."
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label htmlFor="price" className="block text-sm font-medium">
                Price (USD)
              </label>
              <input
                id="price"
                name="price"
                type="text"
                required
                className="mt-1 w-full rounded border px-3 py-2"
                placeholder="19.99"
              />
            </div>
            <div>
              <label htmlFor="sku" className="block text-sm font-medium">
                SKU
              </label>
              <input
                id="sku"
                name="sku"
                type="text"
                className="mt-1 w-full rounded border px-3 py-2"
                placeholder="TSHIRT-001"
              />
            </div>
            <div>
              <label htmlFor="inventory" className="block text-sm font-medium">
                Inventory
              </label>
              <input
                id="inventory"
                name="inventory"
                type="number"
                min="0"
                defaultValue="0"
                className="mt-1 w-full rounded border px-3 py-2"
              />
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {loading ? "Creating…" : "Create product"}
          </button>
        </form>
      </div>
    </main>
  );
}
