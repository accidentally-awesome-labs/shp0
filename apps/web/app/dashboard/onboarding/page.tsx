"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createStoreAction, checkSubdomain } from "@/app/actions/stores";

export default function OnboardingPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [status, setStatus] = useState<"idle" | "available" | "taken" | "checking">("idle");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubdomainChange(value: string) {
    const clean = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setSubdomain(clean);
    if (clean.length < 2) {
      setStatus("idle");
      return;
    }
    setStatus("checking");
    const { available } = await checkSubdomain(clean);
    setStatus(available ? "available" : "taken");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await createStoreAction(new FormData(e.target as HTMLFormElement));
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create store");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-8">
      <h1 className="mb-2 text-2xl font-bold">Create your store</h1>
      <p className="mb-6 text-sm text-gray-600">
        Let&apos;s set up your first store. You can add more later.
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium">
            Store name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
            placeholder="Acme Inc."
          />
        </div>
        <div>
          <label htmlFor="subdomain" className="block text-sm font-medium">
            Store address
          </label>
          <div className="mt-1 flex items-center rounded border">
            <input
              id="subdomain"
              name="subdomain"
              type="text"
              required
              minLength={2}
              pattern="[a-z0-9-]+"
              value={subdomain}
              onChange={(e) => handleSubdomainChange(e.target.value)}
              className="w-full rounded-l px-3 py-2 outline-none"
              placeholder="acme"
            />
            <span className="whitespace-nowrap bg-gray-100 px-3 py-2 text-sm text-gray-500">
              .shp0.dev
            </span>
          </div>
          {status === "checking" && (
            <p className="mt-1 text-xs text-gray-500">Checking…</p>
          )}
          {status === "available" && (
            <p className="mt-1 text-xs text-green-600">
              ✓ {subdomain}.shp0.dev is available
            </p>
          )}
          {status === "taken" && (
            <p className="mt-1 text-xs text-red-600">
              ✗ {subdomain}.shp0.dev is taken
            </p>
          )}
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading || status === "taken" || status === "checking"}
          className="w-full rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {loading ? "Creating…" : "Create store"}
        </button>
      </form>
    </main>
  );
}
