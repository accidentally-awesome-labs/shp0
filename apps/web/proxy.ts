import { NextResponse, type NextRequest } from "next/server";

import { hasSessionCookie } from "@shp0/auth/session-cookie";

/**
 * Route guard: sends signed-out visitors from the dashboard to sign-in.
 *
 * It only checks that a better-auth session cookie is present, under either
 * of its names ("better-auth.session_token", or
 * "__Secure-better-auth.session_token" when better-auth's base URL is https
 * or, with none set, in production); see @shp0/auth/session-cookie. It never
 * validates the cookie and makes no database call, so it is not an
 * authorization layer: a forged cookie gets through. Every dashboard page and
 * server action checks the session and the Merchant's Membership and Role
 * itself (apps/web/lib/current-store.ts).
 *
 * Next.js 16 runs proxy.ts on the Node.js runtime, so it can use
 * better-auth's own cookie helper (the Edge Runtime restriction that once
 * kept it out no longer applies).
 *
 * /admin is deliberately not matched: its page and actions check the
 * Operator allowlist themselves.
 */
export function proxy(request: NextRequest) {
  if (!hasSessionCookie(request.headers)) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("redirect", request.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
