export const instant = false;

import Link from "next/link";
import { notFound } from "next/navigation";

import { getStorefrontCustomer } from "@/app/actions/customers";
import { resolveStorefrontStore } from "@/lib/current-store";
import SignOutButton from "./sign-out-button";

/**
 * The Customer's account in the request host's Store (ADR-0003), where
 * sign-in and sign-up land. Signed out, it offers both.
 */
export default async function AccountPage() {
  if (!(await resolveStorefrontStore())) notFound();
  const customer = await getStorefrontCustomer();

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-bold">Your account</h1>
      {customer ? (
        <div className="space-y-4">
          <div>
            <p className="font-medium">{customer.name}</p>
            <p className="text-sm text-gray-600">{customer.email}</p>
          </div>
          <SignOutButton />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">You&apos;re not signed in.</p>
          <div className="flex gap-3">
            <Link href="/account/sign-in" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
              Sign in
            </Link>
            <Link href="/account/sign-up" className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50">
              Create account
            </Link>
          </div>
        </div>
      )}
      <Link href="/" className="mt-8 inline-block text-sm text-gray-500 hover:text-black">
        ← Continue shopping
      </Link>
    </main>
  );
}
