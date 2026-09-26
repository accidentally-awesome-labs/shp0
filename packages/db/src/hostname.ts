/**
 * Host parsing for Store resolution and Custom Domains (Issues #5, #14, #58).
 *
 * Pure functions, no I/O: safe to unit test without a database.
 *
 * The platform domain is the one source for both Subdomain resolution and the
 * Custom Domain rules: a Custom Domain may never be the platform domain or one
 * of its subdomains, because those hosts belong to the platform and to other
 * Stores' Subdomains.
 */
import { domainToASCII } from "node:url";

/** The platform's own domain. Stores are served on `<subdomain>.shp0.dev`. */
export const PLATFORM_DOMAIN = "shp0.dev";

/** Subdomains reserved for the platform itself, never a Store. */
const RESERVED_SUBDOMAINS = new Set(["app", "www", "dashboard", "api", "mail"]);

/**
 * Parse a request host and extract the Store subdomain, if any.
 *
 * Returns the subdomain string for a Store host like "acme.shp0.dev", or null
 * for the platform domain, localhost/dev, and reserved subdomains (app, www,
 * dashboard, api, mail).
 */
export function parseSubdomain(
  host: string,
  platformDomain: string = PLATFORM_DOMAIN,
): string | null {
  // Strip port if present (e.g. "localhost:3000").
  const hostname = host.split(":")[0]!;

  // Must end with the platform domain.
  if (!hostname.endsWith(`.${platformDomain}`)) return null;

  const subdomain = hostname.slice(0, hostname.length - platformDomain.length - 1);

  // No subdomain = the platform domain itself.
  if (!subdomain) return null;

  // Reserved subdomains are platform, not a Store.
  if (RESERVED_SUBDOMAINS.has(subdomain)) return null;

  return subdomain;
}

/**
 * Normalize a request Host header for lookup: trim, lowercase, strip the port
 * and one trailing dot. "Shop.Example.com.:443" → "shop.example.com".
 * A bracketed IPv6 literal keeps its brackets: "[::1]:3000" → "[::1]".
 */
export function normalizeRequestHost(host: string): string {
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith("[")) {
    const end = hostname.indexOf("]");
    return end === -1 ? hostname : hostname.slice(0, end + 1);
  }
  const colon = hostname.indexOf(":");
  if (colon !== -1 && colon === hostname.lastIndexOf(":")) hostname = hostname.slice(0, colon);
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  return hostname;
}

/**
 * True when a normalized hostname is the platform domain or any subdomain of
 * it ("shp0.dev", "acme.shp0.dev", "app.shp0.dev"). "notshp0.dev" is not.
 */
export function isPlatformHost(hostname: string, platformDomain: string = PLATFORM_DOMAIN): boolean {
  return hostname === platformDomain || hostname.endsWith(`.${platformDomain}`);
}

export type CustomDomainRejection =
  | "empty"
  | "whitespace"
  | "scheme"
  | "userinfo"
  | "path"
  | "query"
  | "port"
  | "wildcard"
  | "ip_address"
  | "invalid"
  | "too_long"
  | "label"
  | "localhost"
  | "single_label"
  | "platform_domain";

export type CustomDomainValidation =
  | { ok: true; hostname: string }
  | { ok: false; reason: CustomDomainRejection; message: string };

/** Thrown by addCustomDomain when the hostname is not an acceptable Custom Domain. */
export class InvalidCustomDomainError extends Error {
  readonly reason: CustomDomainRejection;

  constructor(reason: CustomDomainRejection, message: string) {
    super(message);
    this.name = "InvalidCustomDomainError";
    this.reason = reason;
  }
}

const EXAMPLE = "shop.example.com";

function reject(reason: CustomDomainRejection, platformDomain: string): CustomDomainValidation {
  const messages: Record<CustomDomainRejection, string> = {
    empty: `Enter a domain name, such as ${EXAMPLE}.`,
    whitespace: "A domain name cannot contain spaces.",
    scheme: "Enter only the domain name, without http:// or https://.",
    userinfo: "Enter only the domain name, without a user name or @.",
    path: "Enter only the domain name, without a path.",
    query: "Enter only the domain name, without ? or #.",
    port: "Enter the domain name without a port number.",
    wildcard: `Wildcard domains are not supported. Enter one domain name, such as ${EXAMPLE}.`,
    ip_address: "Enter a domain name, not an IP address.",
    invalid: "That is not a valid domain name.",
    too_long: "A domain name can be at most 253 characters long.",
    label:
      "Each part of a domain name must be 1 to 63 letters, digits or hyphens, and cannot start or end with a hyphen.",
    localhost: "localhost cannot be used as a Custom Domain.",
    single_label: `Enter a full domain name, such as ${EXAMPLE}.`,
    platform_domain: `${platformDomain} and its subdomains cannot be added as Custom Domains. Your Store is already served on its Subdomain.`,
  };
  return { ok: false, reason, message: messages[reason] };
}

/**
 * The WHATWG URL "ends in a number" test: would a browser read this host as
 * an IPv4 address? True when the last label (ignoring one trailing dot) is
 * all digits or a 0x hex number, e.g. "127.0.0.1", "0x7f.1", "999.1.1.1".
 */
function endsInNumber(hostname: string): boolean {
  const labels = hostname.split(".");
  if (labels.length > 1 && labels[labels.length - 1] === "") labels.pop();
  const last = labels[labels.length - 1]!;
  return /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last);
}

const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validate and normalize a hostname a Merchant wants to add as a Custom Domain.
 *
 * Normalizes: trim, lowercase, IDN → ASCII (punycode), strip one trailing dot.
 * Rejects anything that is not a plain, fully qualified domain name: URLs
 * (scheme, userinfo, path, query, port), wildcards, IP literals, localhost,
 * single-label names, labels outside the LDH rules, names over 253
 * characters, and the platform domain and every subdomain of it.
 *
 * Structural characters are rejected BEFORE IDN conversion, because
 * domainToASCII percent-decodes, parses IPv4 forms and stops at "/". The
 * platform check runs AFTER conversion, because Unicode forms such as
 * "victim。shp0。dev" or fullwidth letters convert to the platform domain.
 */
export function validateCustomDomain(
  input: string,
  platformDomain: string = PLATFORM_DOMAIN,
): CustomDomainValidation {
  const trimmed = input.trim();
  if (trimmed === "") return reject("empty", platformDomain);
  if (/\s/.test(trimmed)) return reject("whitespace", platformDomain);
  if (trimmed.includes("://")) return reject("scheme", platformDomain);
  if (trimmed.includes("@")) return reject("userinfo", platformDomain);
  if (/[/\\]/.test(trimmed)) return reject("path", platformDomain);
  if (/[?#]/.test(trimmed)) return reject("query", platformDomain);
  if (trimmed.includes("[") || trimmed.includes("]") || trimmed.split(":").length > 2) {
    return reject("ip_address", platformDomain); // IPv6 literal
  }
  if (trimmed.includes(":")) return reject("port", platformDomain);
  if (trimmed.includes("*")) return reject("wildcard", platformDomain);
  if (trimmed.includes("%")) return reject("invalid", platformDomain);

  const lowered = trimmed.toLowerCase();
  if (endsInNumber(lowered)) return reject("ip_address", platformDomain);

  const ascii = domainToASCII(lowered);
  if (ascii === "") return reject("invalid", platformDomain);

  const hostname = ascii.endsWith(".") ? ascii.slice(0, -1) : ascii;
  if (hostname === "") return reject("invalid", platformDomain);
  if (endsInNumber(hostname)) return reject("ip_address", platformDomain);
  if (hostname.length > 253) return reject("too_long", platformDomain);

  const labels = hostname.split(".");
  if (!labels.every((label) => LDH_LABEL.test(label))) return reject("label", platformDomain);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return reject("localhost", platformDomain);
  }
  if (labels.length < 2) return reject("single_label", platformDomain);
  if (isPlatformHost(hostname, platformDomain)) return reject("platform_domain", platformDomain);

  return { ok: true, hostname };
}

export type StorefrontHostRoute =
  | { kind: "subdomain"; subdomain: string }
  | { kind: "custom_domain"; hostname: string }
  | { kind: "none" };

/**
 * Decide how a storefront request host is resolved to a Store.
 *
 * - The platform domain and its subdomains are decided by Subdomain
 *   resolution ONLY. They are never looked up in the Custom Domain table, so
 *   a bad stored row (say a verified "victim.shp0.dev") cannot take over
 *   another Store or a platform host.
 * - Any other host is looked up as a Custom Domain, but only if it is already
 *   a canonical, valid Custom Domain hostname (so localhost, IP literals and
 *   the like never reach the table).
 */
export function routeStorefrontHost(
  host: string,
  platformDomain: string = PLATFORM_DOMAIN,
): StorefrontHostRoute {
  const hostname = normalizeRequestHost(host);
  if (hostname === "") return { kind: "none" };

  if (isPlatformHost(hostname, platformDomain)) {
    const subdomain = parseSubdomain(hostname, platformDomain);
    return subdomain ? { kind: "subdomain", subdomain } : { kind: "none" };
  }

  const valid = validateCustomDomain(hostname, platformDomain);
  if (!valid.ok || valid.hostname !== hostname) return { kind: "none" };
  return { kind: "custom_domain", hostname };
}
