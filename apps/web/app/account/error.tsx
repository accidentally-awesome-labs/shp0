"use client";

import Link from "next/link";

/**
 * The account pages' error screen: what a Customer sees when a form's
 * request never reached the store (offline, or an unexpected answer), in
 * place of the whole page failing.
 */
export default function AccountError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="mb-4 text-2xl font-bold">Something went wrong</h1>
      <p className="text-sm text-gray-600">We couldn&apos;t reach the store. Check your connection and try again.</p>
      <div className="mt-6 flex gap-3">
        <button type="button" onClick={reset} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Try again
        </button>
        <Link href="/" className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50">
          Continue shopping
        </Link>
      </div>
    </main>
  );
}
