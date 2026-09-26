import { headers } from "next/headers";

import {
  OPERATOR_USER_IDS_ENV,
  isOperator,
  parseOperatorUserIds,
} from "@shp0/auth/operator";
import { auth } from "@/lib/auth";

/**
 * Operator (platform admin) access for the current request — Issue #52.
 *
 * Operators are the Merchant user ids listed in SHP0_OPERATOR_USER_IDS
 * (comma-separated). Unset or empty means nobody is an Operator and the
 * platform admin is locked (fail closed). The policy itself lives in
 * @shp0/auth/operator; this module binds it to the request's session.
 *
 * Every call reads the session from the request headers, so anything gated on
 * it renders per request and is never part of a prerendered or cached shell.
 * The allowlist is read at call time, never at build time, and never logged.
 */
export type OperatorAccess =
  | { status: "unauthenticated" }
  | { status: "forbidden" }
  | { status: "operator"; userId: string };

export async function getOperatorAccess(): Promise<OperatorAccess> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { status: "unauthenticated" };

  const operatorUserIds = parseOperatorUserIds(process.env[OPERATOR_USER_IDS_ENV]);
  if (!isOperator(session.user.id, operatorUserIds)) return { status: "forbidden" };

  return { status: "operator", userId: session.user.id };
}

/**
 * Throw unless the caller is an Operator. Server actions are reachable over
 * HTTP by action id without rendering the admin page, so every operator
 * action and data function must call this itself before touching data.
 *
 * The "Not authorized" message is deliberately generic: it says nothing about
 * how Operators are configured.
 */
export async function requireOperator(): Promise<{ userId: string }> {
  const access = await getOperatorAccess();
  if (access.status === "unauthenticated") throw new Error("Not authenticated");
  if (access.status !== "operator") throw new Error("Not authorized");
  return { userId: access.userId };
}
