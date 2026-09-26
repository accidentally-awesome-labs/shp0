"use client";

import { useActionState } from "react";

import { addDomainAction } from "@/app/actions/domains";

export function AddDomainForm({ storeId }: { storeId: string }) {
  const [state, formAction, pending] = useActionState(addDomainAction.bind(null, storeId), {
    error: null,
    hostname: "",
  });

  return (
    <div className="mb-8">
      <form action={formAction} className="flex gap-2">
        <input
          name="hostname"
          placeholder="shop.yourdomain.com"
          defaultValue={state.hostname}
          aria-invalid={state.error ? true : undefined}
          className="flex-1 rounded border px-3 py-2"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? "Adding..." : "Add Domain"}
        </button>
      </form>
      {state.error && <p className="mt-2 text-sm text-red-600">{state.error}</p>}
    </div>
  );
}
