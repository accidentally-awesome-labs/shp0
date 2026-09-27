import { describe, it, expect } from "vitest";

import { hasSessionCookie } from "../src/session-cookie";

/**
 * Whether a request carries a Merchant session cookie (apps/web/proxy.ts).
 *
 * better-auth names the session cookie "better-auth.session_token", or
 * "__Secure-better-auth.session_token" when its base URL is https (or, with
 * none set, in production). The proxy only looked for the unprefixed name,
 * so on any HTTPS deployment it sent every signed-in Merchant from
 * /dashboard back to /sign-in.
 *
 * Presence only: the proxy is a redirect for signed-out visitors, not an
 * authorization layer. Pages and server actions validate the session.
 *
 * Pure: no network, no database.
 */
const withCookie = (cookie: string) => new Headers({ cookie });

describe("hasSessionCookie", () => {
  it.each([
    ["the plain name (http base URL)", "better-auth.session_token=abc.def"],
    ["the __Secure- name (https base URL, or production)", "__Secure-better-auth.session_token=abc.def"],
    ["the __Secure- name among other cookies", "theme=dark; __Secure-better-auth.session_token=abc.def; x=1"],
    ["the plain name among other cookies", "a=1; better-auth.session_token=abc.def"],
  ])("accepts %s", (_label, cookie) => {
    expect(hasSessionCookie(withCookie(cookie))).toBe(true);
  });

  it.each([
    ["no Cookie header", null],
    ["an empty Cookie header", ""],
    ["unrelated cookies", "theme=dark; shp0_cart_token=abc"],
    ["the storefront Customer session", "customer_session=abc"],
    ["an empty session token", "better-auth.session_token="],
    ["an empty __Secure- session token", "__Secure-better-auth.session_token="],
    ["a longer name that only ends with the cookie name", "xbetter-auth.session_token=abc"],
    ["the session data cookie, not the token", "better-auth.session_data=abc"],
    ["the __Host- prefix, which better-auth does not use for it", "__Host-better-auth.session_token=abc"],
  ])("rejects %s", (_label, cookie) => {
    const headers = cookie === null ? new Headers() : withCookie(cookie);
    expect(hasSessionCookie(headers)).toBe(false);
  });
});
