import { describe, it, expect } from "vitest";

import {
  PLATFORM_DOMAIN,
  validateCustomDomain,
  normalizeRequestHost,
  isPlatformHost,
  routeStorefrontHost,
  InvalidCustomDomainError,
} from "../src/hostname";
import type { CustomDomainRejection } from "../src/hostname";

/**
 * Custom Domain hostname rules (Issue #58, containment).
 *
 * Pure module, no DB. A Custom Domain must be a real, fully qualified domain
 * name the Merchant could own, and never the platform domain or one of its
 * subdomains: those are served by Subdomain resolution, and letting a Store
 * claim one would let it take over another Store or a platform host.
 */

function rejection(input: string, platformDomain?: string): CustomDomainRejection | "accepted" {
  const result = validateCustomDomain(input, platformDomain);
  return result.ok ? "accepted" : result.reason;
}

describe("validateCustomDomain", () => {
  describe("accepts and normalizes a valid domain", () => {
    it.each([
      ["shop.example.com", "shop.example.com"],
      ["example.com", "example.com"],
      ["  Shop.Example.COM  ", "shop.example.com"],
      ["shop.example.com.", "shop.example.com"],
      ["SHOP.EXAMPLE.COM.", "shop.example.com"],
      ["my-shop.example.co.uk", "my-shop.example.co.uk"],
      ["123.example.com", "123.example.com"],
      ["münchen.de", "xn--mnchen-3ya.de"],
      ["BÜCHER.example", "xn--bcher-kva.example"],
      ["xn--mnchen-3ya.de", "xn--mnchen-3ya.de"],
      ["notshp0.dev", "notshp0.dev"],
      ["shp0.dev.example.com", "shp0.dev.example.com"],
    ])("%j -> %j", (input, expected) => {
      expect(validateCustomDomain(input)).toEqual({ ok: true, hostname: expected });
    });

    it("accepts a 63-character label and a 253-character name", () => {
      const label63 = "a".repeat(63);
      expect(rejection(`${label63}.example.com`)).toBe("accepted");

      // 63 + 1 + 63 + 1 + 63 + 1 + 57 + 1 + 3 = 253
      const name253 = `${label63}.${label63}.${label63}.${"b".repeat(57)}.com`;
      expect(name253).toHaveLength(253);
      expect(validateCustomDomain(name253)).toEqual({ ok: true, hostname: name253 });
    });
  });

  describe("rejects malformed input", () => {
    it.each<[string, CustomDomainRejection]>([
      ["", "empty"],
      ["   ", "empty"],
      ["shop example.com", "whitespace"],
      ["shop.example.com\tx", "whitespace"],
      ["shop.　example.com", "whitespace"],
      ["https://shop.example.com", "scheme"],
      ["http://shop.example.com", "scheme"],
      ["ftp://shop.example.com", "scheme"],
      ["user@shop.example.com", "userinfo"],
      ["user:pass@shop.example.com", "userinfo"],
      ["shop.example.com/path", "path"],
      ["//shop.example.com", "path"],
      ["shop.example.com\\path", "path"],
      ["shop.example.com?x=1", "query"],
      ["shop.example.com#top", "query"],
      ["shop.example.com:8080", "port"],
      ["shop.example.com:", "port"],
      ["*.example.com", "wildcard"],
      ["shop.*.example.com", "wildcard"],
      ["%41.example.com", "invalid"],
      ["victim%2eshp0.dev", "invalid"],
      ["xn--zz.com", "invalid"],
      ["exa‍mple.com", "invalid"],
      ["-shop.example.com", "label"],
      ["shop-.example.com", "label"],
      ["under_score.example.com", "label"],
      ["shop..example.com", "label"],
      ["example.com..", "label"],
      [".example.com", "label"],
      [`${"a".repeat(64)}.example.com`, "label"],
      ["localhost", "localhost"],
      ["LOCALHOST.", "localhost"],
      ["shop.localhost", "localhost"],
      ["example", "single_label"],
      ["com.", "single_label"],
    ])("%j is rejected as %s", (input, reason) => {
      expect(rejection(input)).toBe(reason);
    });

    it("rejects a name longer than 253 characters", () => {
      const label63 = "a".repeat(63);
      const name254 = `${label63}.${label63}.${label63}.${"b".repeat(58)}.com`;
      expect(name254).toHaveLength(254);
      expect(rejection(name254)).toBe("too_long");
    });
  });

  describe("rejects IP address literals", () => {
    it.each([
      "127.0.0.1",
      "10.0.0.1.",
      "0x7f.0.0.1",
      "1.2.3",
      "999.1.1.1",
      "[::1]",
      "::1",
      "2001:db8::1",
      "[2001:db8::1]:443",
    ])("%j", (input) => {
      expect(rejection(input)).toBe("ip_address");
    });
  });

  describe("rejects the platform domain and every subdomain of it", () => {
    it.each([
      "shp0.dev",
      "SHP0.DEV",
      "shp0.dev.",
      "victim.shp0.dev",
      "x.shp0.dev.",
      "app.shp0.dev",
      "www.shp0.dev",
      "a.b.shp0.dev",
      // Unicode forms that IDN conversion maps onto the platform domain.
      "victim。shp0。dev",
      "ｓｈｐ０.dev",
      "sh­p0.dev",
      "victim.shp0.dev．",
    ])("%j", (input) => {
      expect(rejection(input)).toBe("platform_domain");
    });

    it("uses the platform domain it is given", () => {
      expect(rejection("shop.example.test", "example.test")).toBe("platform_domain");
      expect(rejection("shop.shp0.dev", "example.test")).toBe("accepted");
    });

    it("defaults to the shared platform domain", () => {
      expect(PLATFORM_DOMAIN).toBe("shp0.dev");
    });
  });

  it("gives every rejection a message for the Merchant", () => {
    const result = validateCustomDomain("victim.shp0.dev");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/shp0\.dev/);
      const error = new InvalidCustomDomainError(result.reason, result.message);
      expect(error).toBeInstanceOf(Error);
      expect(error.reason).toBe("platform_domain");
      expect(error.message).toBe(result.message);
    }
  });
});

describe("normalizeRequestHost", () => {
  it.each([
    ["shop.example.com", "shop.example.com"],
    ["SHOP.Example.COM", "shop.example.com"],
    ["shop.example.com:3000", "shop.example.com"],
    ["shop.example.com.", "shop.example.com"],
    ["Shop.Example.com.:8443", "shop.example.com"],
    [" shop.example.com ", "shop.example.com"],
    ["[::1]:3000", "[::1]"],
    ["", ""],
  ])("%j -> %j", (host, expected) => {
    expect(normalizeRequestHost(host)).toBe(expected);
  });
});

describe("isPlatformHost", () => {
  it.each(["shp0.dev", "acme.shp0.dev", "app.shp0.dev", "a.b.shp0.dev"])("%j is a platform host", (host) => {
    expect(isPlatformHost(host)).toBe(true);
  });

  it.each(["notshp0.dev", "shp0.dev.example.com", "example.com", "shp0.devx", ""])(
    "%j is not a platform host",
    (host) => {
      expect(isPlatformHost(host)).toBe(false);
    },
  );
});

/**
 * The resolution-order guard. A request host that is the platform domain or
 * one of its subdomains is decided by Subdomain resolution only; it is never
 * looked up in the Custom Domain table, so a bad row stored there (for example
 * a verified "victim.shp0.dev") cannot take over another Store.
 */
describe("routeStorefrontHost", () => {
  it.each([
    ["acme.shp0.dev", "acme"],
    ["ACME.SHP0.DEV", "acme"],
    ["acme.shp0.dev:443", "acme"],
    ["acme.shp0.dev.", "acme"],
    ["victim.shp0.dev", "victim"],
  ])("routes platform host %j to the Subdomain %j", (host, subdomain) => {
    expect(routeStorefrontHost(host)).toEqual({ kind: "subdomain", subdomain });
  });

  it.each(["shp0.dev", "SHP0.DEV.", "app.shp0.dev", "www.shp0.dev:443", "dashboard.shp0.dev"])(
    "never routes platform host %j to a Custom Domain",
    (host) => {
      expect(routeStorefrontHost(host)).toEqual({ kind: "none" });
    },
  );

  it.each([
    ["shop.example.com", "shop.example.com"],
    ["SHOP.EXAMPLE.COM", "shop.example.com"],
    ["shop.example.com:8080", "shop.example.com"],
    ["shop.example.com.", "shop.example.com"],
  ])("routes %j to the Custom Domain %j", (host, hostname) => {
    expect(routeStorefrontHost(host)).toEqual({ kind: "custom_domain", hostname });
  });

  it.each(["localhost", "localhost:3000", "127.0.0.1:3000", "[::1]:3000", "intranet", "", "example.com.."])(
    "does not look up %j in the Custom Domain table",
    (host) => {
      expect(routeStorefrontHost(host)).toEqual({ kind: "none" });
    },
  );

  it("uses the platform domain it is given", () => {
    expect(routeStorefrontHost("acme.example.test", "example.test")).toEqual({
      kind: "subdomain",
      subdomain: "acme",
    });
    expect(routeStorefrontHost("acme.shp0.dev", "example.test")).toEqual({
      kind: "custom_domain",
      hostname: "acme.shp0.dev",
    });
  });
});
