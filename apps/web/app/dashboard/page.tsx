import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session) {
    redirect("/sign-in?redirect=/dashboard");
  }

  return (
    <main className="min-h-screen p-8">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <p className="mt-2 text-gray-600">
        Welcome, {session.user.name}. Your Store provisioning comes next (Issue #4).
      </p>
    </main>
  );
}
