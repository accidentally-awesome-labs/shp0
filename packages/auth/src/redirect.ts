/**
 * Where to send a Merchant after sign-in (the ?redirect= parameter).
 *
 * Only a same-origin path is honored. Anything that could leave the site
 * (an absolute URL, a scheme such as javascript: or data:, a protocol-relative
 * "//host", a backslash that browsers read as a slash, a control character
 * that the URL parser drops, or a path whose dot segments normalize to "//")
 * falls back to a fixed path instead.
 *
 * Pure and dependency-free: safe in client components (the sign-in page) and
 * unit-tested without a browser (tests/redirect.test.ts).
 */

export const DEFAULT_REDIRECT_PATH = "/dashboard";

// Resolution base for the origin check. Its host is never contacted.
const PROBE_ORIGIN = "https://redirect-check.invalid";

// C0 controls, DEL and C1 controls. The URL parser silently removes tab, CR
// and LF anywhere in the input, so "/\t/evil.example" would become
// "//evil.example".
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * `raw` as a same-origin path (path, query and fragment, normalized), or
 * `fallback` when it is anything else.
 */
export function safeRedirectPath(raw: unknown, fallback: string = DEFAULT_REDIRECT_PATH): string {
  if (typeof raw !== "string") return fallback;
  // One leading slash, then not a second slash (protocol-relative).
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  // Browsers treat "\" like "/" in http(s) URLs: "/\evil.example" is "//evil.example".
  if (raw.includes("\\")) return fallback;
  if (CONTROL_CHARACTER.test(raw)) return fallback;

  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PROBE_ORIGIN) return fallback;
  // Dot segments can normalize to a leading "//" ("/.//evil.example"), which
  // would be protocol-relative if this path were ever used as a URL again.
  if (url.pathname.startsWith("//")) return fallback;

  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The sign-in page, returning to `returnTo` afterwards: a same-origin path
 * (with its query), or DEFAULT_REDIRECT_PATH when it is anything else. The
 * sign-in page checks the value again with safeRedirectPath.
 */
export function signInPath(returnTo: unknown): string {
  return `/sign-in?redirect=${encodeURIComponent(safeRedirectPath(returnTo))}`;
}
