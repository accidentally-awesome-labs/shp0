import { getSessionCookie } from "better-auth/cookies";

/**
 * Whether request headers carry a Merchant session cookie, under either of
 * the names better-auth gives it: "better-auth.session_token", or
 * "__Secure-better-auth.session_token" when its base URL is https (or, with
 * none set, in production).
 *
 * It delegates to better-auth's own getSessionCookie, so the accepted names
 * follow the library (tests/session-cookie.test.ts pins both). Presence only:
 * the value is not validated here. apps/web/proxy.ts uses it to send
 * signed-out visitors to sign-in; pages and server actions check the session
 * itself.
 *
 * No I/O: it only reads the Cookie header.
 */
export function hasSessionCookie(headers: Headers): boolean {
  return getSessionCookie(headers) !== null;
}
