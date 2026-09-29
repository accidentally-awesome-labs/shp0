export const instant = false;

import Link from "next/link";
import { notFound } from "next/navigation";

import { customerSignInAction } from "@/app/actions/customers";
import { resolveStorefrontStore } from "@/lib/current-store";
import CustomerForm from "../customer-form";

export default async function CustomerSignInPage() {
  // A Customer account belongs to one Store: only a storefront host has one.
  if (!(await resolveStorefrontStore())) notFound();

  return (
    <div className="mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-bold">Sign In</h1>
      <CustomerForm
        action={customerSignInAction}
        fields={[
          { name: "email", label: "Email", type: "email", autoComplete: "email" },
          { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
        ]}
        submitLabel="Sign In"
        pendingLabel="Signing in…"
      />
      <p className="mt-6 text-sm text-gray-600">
        New here?{" "}
        <Link href="/account/sign-up" className="underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}
