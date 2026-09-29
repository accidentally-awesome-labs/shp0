import Link from "next/link";

import { getStorefrontCustomer } from "@/app/actions/customers";

/**
 * On the sign-in and sign-up pages: who is signed in already, read on the
 * server. It is what a form posted without JavaScript (or before the page's
 * JavaScript loaded) shows once the Customer is signed in.
 */
export default async function SignedInNote() {
  const customer = await getStorefrontCustomer();
  if (customer === null) return null;
  return (
    <p role="status" className="mb-6 rounded bg-blue-50 p-3 text-sm text-blue-700">
      You&apos;re signed in as {customer.name}.{" "}
      <Link href="/account" className="underline">
        Go to your account
      </Link>
    </p>
  );
}
