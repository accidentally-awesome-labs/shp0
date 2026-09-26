import { NextResponse, type NextRequest } from "next/server";

/**
 * Route guard — protects the dashboard and the platform admin from
 * unauthenticated access.
 *
 * Checks for the better-auth session cookie directly (edge-safe, no DB call).
 * If a Merchant hits /dashboard or /admin without one, redirect to /sign-in.
 * The actual session *validity* is checked server-side per-request via auth.api.
 *
 * NOTE: We check the cookie directly rather than importing better-auth/cookies,
 * because that module pulls in `jose` which uses DecompressionStream (not
 * available in the Edge Runtime).
 */
const SESSION_COOKIE = "better-auth.session_token";

export function proxy(request: NextRequest) {
  const sessionCookie = request.cookies.get(SESSION_COOKIE);

  if (!sessionCookie) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("redirect", request.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  // /admin: a signed-out visitor gets a real 307 to sign-in here. This is a
  // convenience, not the guard: the admin page and every operator server action
  // check the session and the Operator allowlist themselves (Issue #52).
  matcher: ["/dashboard/:path*", "/admin/:path*"],
};
