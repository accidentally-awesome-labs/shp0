export const instant = false;

import Link from "next/link";
import { addDomainAction, getDashboardDomains, verifyDomainAction, retryDomainAction } from "@/app/actions/domains";

export default async function DomainsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const domains = await getDashboardDomains(storeId);

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-8 text-2xl font-bold">Custom Domains</h1>

      <form action={addDomainAction.bind(null, storeId)} className="mb-8 flex gap-2">
        <input
          name="hostname"
          placeholder="shop.yourdomain.com"
          className="flex-1 rounded border px-3 py-2"
        />
        <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Add Domain
        </button>
      </form>

      {domains.length === 0 ? (
        <p className="text-gray-500">No custom domains yet. Your store is served on its subdomain by default.</p>
      ) : (
        <ul className="space-y-4">
          {domains.map((domain) => (
            <li key={domain.id} className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{domain.hostname}</p>
                  <p className="text-sm text-gray-500">
                    {domain.isApex ? "Apex (TXT record)" : "Subdomain (CNAME)"}
                  </p>
                </div>
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${
                  domain.verificationStatus === "verified" ? "bg-green-100 text-green-700" :
                  domain.verificationStatus === "pending" ? "bg-yellow-100 text-yellow-700" :
                  "bg-red-100 text-red-700"
                }`}>
                  {domain.verificationStatus}
                </span>
              </div>
              {domain.verificationStatus === "pending" && (
                <form action={verifyDomainAction.bind(null, domain.id)} className="mt-2">
                  <button type="submit" className="text-xs text-blue-600 hover:underline">
                    Verify now
                  </button>
                </form>
              )}
              {domain.verificationStatus === "failed" && (
                <form action={retryDomainAction.bind(null, domain.id)} className="mt-2">
                  <button type="submit" className="text-xs text-blue-600 hover:underline">
                    Retry verification
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
