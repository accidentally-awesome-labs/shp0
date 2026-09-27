export const instant = false;

import { notFound } from "next/navigation";

import { getDashboardDomains, retryDomainAction } from "@/app/actions/domains";
import { resolveDashboardStore } from "@/lib/current-store";
import { AddDomainForm } from "./add-domain-form";

export default async function DomainsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;

  // Authorization gate: 404 unless the Merchant holds a Membership here.
  const resolved = await resolveDashboardStore(storeId);
  if (!resolved) notFound();

  const domains = await getDashboardDomains(storeId);

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="mb-8 text-2xl font-bold">Custom Domains</h1>

      <AddDomainForm storeId={storeId} />

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
                    {domain.isApex ? "Apex domain" : "Subdomain of your domain"}
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
                <div className="mt-3 rounded bg-gray-50 p-3 text-sm">
                  <p className="font-medium text-gray-700">TXT record to add at your DNS provider</p>
                  <code className="mt-1 block break-all font-mono text-xs text-gray-800">
                    {domain.txtVerificationValue}
                  </code>
                  <p className="mt-2 text-gray-500">
                    Automatic verification is not available yet. This domain stays pending and
                    does not serve your Store until it has been verified.
                  </p>
                </div>
              )}
              {domain.verificationStatus === "failed" && (
                <form action={retryDomainAction.bind(null, storeId, domain.id)} className="mt-2">
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
