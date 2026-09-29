"use client";

import { useActionState, useEffect, useId, useState } from "react";
import type { CustomerFormResult } from "@/app/actions/customers";

type Field = {
  name: "email" | "name" | "password";
  label: string;
  type: "text" | "email" | "password";
  autoComplete: string;
  minLength?: number;
};

type Props = {
  action: (previous: CustomerFormResult | null, formData: FormData) => Promise<CustomerFormResult>;
  fields: readonly Field[];
  submitLabel: string;
  pendingLabel: string;
};

/**
 * A Customer sign-in or sign-up form, fresh each time its page is shown.
 * Next keeps recently visited routes mounted but hidden, and runs their
 * effects' cleanups when it hides them: a new key then remounts the form,
 * so an earlier attempt's message or email never comes back, even for
 * someone else on the same device.
 */
export default function CustomerForm(props: Props) {
  const [visit, setVisit] = useState(0);
  useEffect(() => () => setVisit((count) => count + 1), []);
  return <Form key={visit} {...props} />;
}

/**
 * The action is the server action itself, so the form posts it even before
 * the page's JavaScript has loaded (credentials never go in a URL), and
 * React clears the fields once it succeeds. On success the browser loads the
 * account page afresh (customers.ts says why the action does not redirect).
 * Without JavaScript, the page's SignedInNote says the Customer is in; a
 * refused attempt then shows no message, because Next's prerendered response
 * does not apply the action's result (the form comes back empty).
 */
function Form({ action, fields, submitLabel, pendingLabel }: Props) {
  const [state, formAction, pending] = useActionState(action, null);
  const signedIn = state?.ok === true;
  // Ids unique to this form: the other account form may be mounted, hidden.
  const id = useId();

  useEffect(() => {
    if (signedIn) window.location.assign("/account");
  }, [signedIn]);

  return (
    <form action={formAction} className="space-y-4">
      {fields.map((field) => (
        <div key={field.name}>
          <label htmlFor={`${id}-${field.name}`} className="block text-sm font-medium">
            {field.label}
          </label>
          <input
            id={`${id}-${field.name}`}
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
