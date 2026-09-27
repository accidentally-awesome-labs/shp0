import { headers } from "next/headers";
import { cache } from "react";

import {
  OPERATOR_USER_IDS_ENV,
  assertOperator,
  decideOperatorAccess,
  type OperatorAccess,
} from "@shp0/auth/operator";
import { auth } from "@/lib/auth";

export type { OperatorAccess };

/**
 * Operator (platform admin) access for the current request — Issue #52.
 *
 * Operators are the Merchant user ids listed in SHP0_OPERATOR_USER_IDS
 * (comma-separated). Unset or empty means nobody is an Operator and the
 * platform admin is locked (fail closed). The policy itself lives in
 * @shp0/auth/operator (unit-tested); this module only binds it to the
 * request's session.
 *
 * Every call reads the session from the request headers, so anything gated on
 * it renders per request and is never part of a prerendered or cached shell.
 * The allowlist is read at call time, never at build time, and never logged.
 *
 * React cache() dedupes the session lookup within one server render (the
 * /admin gate plus the data functions it then calls). It never spans requests,
 * and a server action invoked over HTTP gets its own fresh check.
 */
export const getOperatorAccess = cache(async (): Promise<OperatorAccess> => {
  const session = await auth.api.getSession({ headers: await headers() });
  return decideOperatorAccess(session?.user.id, process.env[OPERATOR_USER_IDS_ENV]);
});

/**
 * Throw unless the caller is an Operator: "Not authenticated" without a
 * session, a generic "Not authorized" otherwise. Server actions are reachable
 * over HTTP by action id without rendering the admin page, so every operator
 * action and data function must call this itself before touching data
 * (scripts/ci/operator-guard.mjs checks apps/web/app/actions/admin.ts).
 */
export async function requireOperator(): Promise<{ userId: string }> {
  return assertOperator(await getOperatorAccess());
}
