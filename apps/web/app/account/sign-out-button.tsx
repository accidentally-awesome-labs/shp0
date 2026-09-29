"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { customerSignOutAction } from "@/app/actions/customers";

/** Sign out, then show the account page signed out. */
export default function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    try {
      await customerSignOutAction();
      router.refresh();
    } catch {
      setFailed(true);
    }
    setPending(false);
  }

  return (
    <div>
      <button
        type="button"
        onClick={signOut}
        disabled={pending}
        className="rounded border px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {failed && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          Couldn&apos;t sign you out. Please try again.
        </p>
      )}
    </div>
  );
}
