"use client";

import { useActionState, useEffect } from "react";
import { customerSignOutAction } from "@/app/actions/customers";

/**
 * Sign out. The form posts the server action even before the page's
 * JavaScript has loaded; then the browser loads the account page afresh,
 * so no route the router keeps hidden outlives the session.
 */
export default function SignOutButton() {
  const [state, formAction, pending] = useActionState(customerSignOutAction, null);
  const signedOut = state?.ok === true;

  useEffect(() => {
    if (signedOut) window.location.assign("/account");
  }, [signedOut]);

  return (
    <form action={formAction}>
      <button
        type="submit"
        disabled={pending || signedOut}
        className="rounded border px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
      >
        {pending || signedOut ? "Signing out…" : "Sign out"}
      </button>
      {state?.ok === false && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          Couldn&apos;t sign you out. Please try again.
        </p>
      )}
    </form>
  );
}
