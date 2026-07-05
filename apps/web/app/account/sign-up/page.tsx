export const instant = false;

import { customerSignUpAction } from "@/app/actions/customers";

export default function CustomerSignUpPage() {
  return (
    <div className="mx-auto max-w-sm p-8">
      <h1 className="mb-6 text-2xl font-bold">Create Account</h1>
      <form action={customerSignUpAction} className="space-y-4">
        <div>
          <label className="block text-sm font-medium">Name</label>
          <input name="name" required className="mt-1 w-full rounded border px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium">Email</label>
          <input name="email" type="email" required className="mt-1 w-full rounded border px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium">Password</label>
          <input name="password" type="password" required className="mt-1 w-full rounded border px-3 py-2" />
        </div>
        <button type="submit" className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Sign Up
        </button>
      </form>
    </div>
  );
}
