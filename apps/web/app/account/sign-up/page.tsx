export const instant = false;

import Link from "next/link";
import { notFound } from "next/navigation";

import { customerSignUpAction } from "@/app/actions/customers";
import { resolveStorefrontStore } from "@/lib/current-store";
import { MIN_PASSWORD_LENGTH } from "@shp0/db";
import CustomerForm from "../customer-form";

export default async function CustomerSignUpPage() {
  // A Customer account belongs to one Store: only a storefront host has one.
  if (!(await resolveStorefrontStore())) notFound();

  return (
    <div className="mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-bold">Create Account</h1>
      <CustomerForm
        action={customerSignUpAction}
        fields={[
          { name: "name", label: "Name", type: "text", autoComplete: "name" },
          { name: "email", label: "Email", type: "email", autoComplete: "email" },
          {
            name: "password",
            label: `Password (at least ${MIN_PASSWORD_LENGTH} characters)`,
            type: "password",
            autoComplete: "new-password",
            minLength: MIN_PASSWORD_LENGTH,
          },
        ]}
        submitLabel="Sign Up"
        pendingLabel="Creating your account…"
      />
      <p className="mt-6 text-sm text-gray-600">
        Already have an account?{" "}
        <Link href="/account/sign-in" className="underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
