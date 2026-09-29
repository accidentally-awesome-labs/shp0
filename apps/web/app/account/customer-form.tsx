"use client";

import { useActionState, useEffect } from "react";
import type { CustomerFormResult } from "@/app/actions/customers";

type Field = {
  name: "email" | "name" | "password";
  label: string;
  type: "text" | "email" | "password";
  autoComplete: string;
  minLength?: number;
};

/**
 * A Customer sign-in or sign-up form. The action is the server action
 * itself, so the form posts it even before the page's JavaScript has loaded
 * (credentials never go in a URL), and React clears the fields once it
 * succeeds. On success the browser loads the account page afresh: a client
 * navigation would keep this form, with what was typed, in the router's
 * hidden routes (customers.ts says why the action does not redirect).
 */
export default function CustomerForm({
  action,
  fields,
  submitLabel,
  pendingLabel,
}: {
  action: (previous: CustomerFormResult | null, formData: FormData) => Promise<CustomerFormResult>;
  fields: readonly Field[];
  submitLabel: string;
  pendingLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const signedIn = state?.ok === true;

  useEffect(() => {
    if (signedIn) window.location.assign("/account");
  }, [signedIn]);

  return (
    <form action={formAction} className="space-y-4">
      {fields.map((field) => (
        <div key={field.name}>
          <label htmlFor={field.name} className="block text-sm font-medium">
            {field.label}
          </label>
          <input
            id={field.name}
            name={field.name}
            type={field.type}
            autoComplete={field.autoComplete}
            minLength={field.minLength}
            required
            // After a refusal, what was typed (never the password).
            defaultValue={state && !state.ok && field.name !== "password" ? state.values[field.name] : undefined}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </div>
      ))}
      {state && !state.ok && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}
      {signedIn && (
        <p role="status" className="text-sm text-gray-600">
          You&apos;re signed in.{" "}
          <a href="/account" className="underline">
            Go to your account
          </a>
        </p>
      )}
      <button
        type="submit"
        disabled={pending || signedIn}
        className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? pendingLabel : submitLabel}
      </button>
    </form>
  );
}
