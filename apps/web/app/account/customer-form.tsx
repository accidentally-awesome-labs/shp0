"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { CustomerFormResult } from "@/app/actions/customers";

type Field = { name: string; label: string; type: "text" | "email" | "password"; autoComplete: string; minLength?: number };

/**
 * A Customer sign-in or sign-up form. It follows the action's answer in the
 * browser: to the account page, or an inline message (customers.ts says
 * why the action does not redirect itself).
 */
export default function CustomerForm({
  action,
  fields,
  submitLabel,
  pendingLabel,
}: {
  action: (formData: FormData) => Promise<CustomerFormResult>;
  fields: readonly Field[];
  submitLabel: string;
  pendingLabel: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const result = await action(new FormData(event.currentTarget));
      if (result.ok) {
        // Stay disabled until the account page replaces this one.
        router.push("/account");
        router.refresh();
        return;
      }
      setError(result.error);
    } catch {
      // A thrown error's message is a digest in production: say something useful.
      setError("Something went wrong. Please try again.");
    }
    setPending(false);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
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
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? pendingLabel : submitLabel}
      </button>
    </form>
  );
}
