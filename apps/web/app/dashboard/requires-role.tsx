import Link from "next/link";

import { ROLE_LABEL, type Role } from "@shp0/db/roles";

/**
 * Shown by a Store dashboard page to a member whose Role is below the page's
 * minimum. It names the Role required and nothing else: the page does not
 * fetch its data for them.
 */
export function RequiresRole({ role, storeId }: { role: Role; storeId: string }) {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <Link href={`/dashboard/${storeId}`} className="text-sm text-gray-500 hover:text-black">
        ← Store
      </Link>
      <p className="mt-4 rounded-lg border p-6 text-gray-700">
        This page requires the {ROLE_LABEL[role]} role in this Store.
      </p>
    </main>
  );
}
