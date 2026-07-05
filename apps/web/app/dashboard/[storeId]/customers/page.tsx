export const instant = false;

import { getDashboardCustomers } from "@/app/actions/customers";

export default async function CustomersPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const customers = await getDashboardCustomers(storeId);

  return (
    <div className="mx-auto max-w-4xl p-8">
      <h1 className="mb-8 text-2xl font-bold">Customers</h1>
      {customers.length === 0 ? (
        <p className="text-gray-500">No customers yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {customers.map((c) => (
            <li key={c.id} className="flex items-center justify-between p-4">
              <div>
                <p className="font-medium">{c.name}</p>
                <p className="text-sm text-gray-500">{c.email}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
