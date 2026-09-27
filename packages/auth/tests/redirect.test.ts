import { describe, it, expect } from "vitest";

import { DEFAULT_REDIRECT_PATH, safeRedirectPath, signInPath } from "../src/redirect";

/**
 * The ?redirect= target after sign-in.
 *
 * The Merchant sign-in page used to router.push() whatever ?redirect= held,
 * so a link to /sign-in?redirect=https://evil.example sent a Merchant who had
 * just signed in to another site (confirmed in Chromium, as was the
 * protocol-relative //evil.example). Only a same-origin path is honored;
 * anything else falls back.
 *
 * Pure: no network, no environment.
 */
describe("safeRedirectPath", () => {
  it("falls back to /dashboard", () => {
    expect(DEFAULT_REDIRECT_PATH).toBe("/dashboard");
    expect(safeRedirectPath(null)).toBe("/dashboard");
  });

  describe("keeps a same-origin path", () => {
    it.each([
      ["/dashboard", "/dashboard"],
      ["/", "/"],
      ["/dashboard/3f1c0f5e-1f7a-4a52-9d2e-0b8f1f4e2a10/products", "/dashboard/3f1c0f5e-1f7a-4a52-9d2e-0b8f1f4e2a10/products"],
      ["/admin", "/admin"],
      ["/dashboard?tab=billing#usage", "/dashboard?tab=billing#usage"],
      ["/search?q=https://evil.example", "/search?q=https://evil.example"],
      // Percent-encoded slashes stay encoded: still a single path segment here.
      ["/%2F%2Fevil.example", "/%2F%2Fevil.example"],
      ["/a/../dashboard", "/dashboard"],
    ])("%j -> %j", (raw, expected) => {
      expect(safeRedirectPath(raw)).toBe(expected);
    });
  });

  describe("rejects anything that is not a same-origin path", () => {
    it.each([
      ["an absolute https URL", "https://evil.example/phish"],
      ["an absolute http URL", "http://evil.example"],
      ["a protocol-relative URL", "//evil.example/proto-relative"],
      ["three slashes", "///evil.example"],
      ["slash backslash", "/\\evil.example"],
      ["backslash slash", "\\/evil.example"],
      ["two backslashes", "\\\\evil.example"],
      ["a backslash later in the path", "/dashboard\\..\\..\\evil"],
      ["a javascript: URL", "javascript:alert(document.domain)"],
      ["a mixed-case javascript: URL", "JaVaScRiPt:alert(1)"],
      ["a data: URL", "data:text/html,<script>alert(1)</script>"],
      ["a scheme without slashes", "https:evil.example"],
      ["a relative path", "dashboard"],
      ["a dot path", "./dashboard"],
      ["a query only", "?redirect=//evil.example"],
      ["a fragment only", "#top"],
      ["the empty string", ""],
      ["leading whitespace", " /dashboard"],
      ["leading whitespace before //", " //evil.example"],
      // The URL parser drops tab and newline anywhere, turning these into //evil.example.
      ["a tab between the slashes", "/\t/evil.example"],
      ["a newline between the slashes", "/\n/evil.example"],
      ["a carriage return between the slashes", "/\r/evil.example"],
      ["a NUL byte", "/dashboard\u0000"],
      ["another C0 control character", "/dash\u001fboard"],
      ["DEL", "/dash\u007fboard"],
      ["a C1 control character", "/dash\u0085board"],
      ["a path that normalizes to //", "/.//evil.example"],
      ["a path that normalizes to // via ..", "/a/..//evil.example"],
      ["an encoded-dot path that normalizes to //", "/%2e//evil.example"],
    ])("%s", (_label, raw) => {
      expect(safeRedirectPath(raw)).toBe("/dashboard");
    });

    it.each([
      ["undefined", undefined],
      ["a number", 42],
      ["an array", ["/dashboard"]],
      ["an object", { toString: () => "/dashboard" }],
    ])("%s", (_label, raw) => {
      expect(safeRedirectPath(raw)).toBe("/dashboard");
    });
  });

  it("uses the given fallback", () => {
    expect(safeRedirectPath("https://evil.example", "/admin")).toBe("/admin");
    expect(safeRedirectPath(null, "/")).toBe("/");
    expect(safeRedirectPath("/dashboard/x", "/admin")).toBe("/dashboard/x");
  });

  it("every accepted value resolves to the same origin, whatever the origin", () => {
    const inputs = [
      "/dashboard",
      "/%2F%2Fevil.example",
      "/a/../dashboard",
      "/.//evil.example",
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "https://evil.example",
    ];
    for (const origin of ["https://app.shp0.dev", "http://localhost:3000"]) {
      for (const raw of inputs) {
        const target = safeRedirectPath(raw);
        expect(new URL(target, origin).origin).toBe(origin);
        expect(target.startsWith("/")).toBe(true);
        expect(target.startsWith("//")).toBe(false);
      }
    }
  });
});

/**
 * The sign-in URL a signed-out Merchant is sent to, carrying where to return.
 *
 * The proxy used to keep only the path (a query string was lost), and the
 * Store dashboard page gate sent a stale or forged session to a fixed
 * /sign-in?redirect=/dashboard, dropping the Store. Both now build it here.
 */
describe("signInPath", () => {
  const returnTo = (path: string) =>
    new URL(path, "https://app.shp0.dev").searchParams.get("redirect");

  it("points at /sign-in and round-trips a same-origin path through ?redirect=", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/3f1c0f5e-1f7a-4a52-9d2e-0b8f1f4e2a10",
      "/dashboard/3f1c0f5e-1f7a-4a52-9d2e-0b8f1f4e2a10/products?tab=drafts&page=2",
      "/dashboard/x/customers?q=a+b%20c#list",
      "/dashboard/%2F%2Fevil.example",
    ]) {
      const target = signInPath(path);
      expect(target.startsWith("/sign-in?redirect=")).toBe(true);
      expect(returnTo(target)).toBe(path);
      // What the sign-in page does with it.
      expect(safeRedirectPath(returnTo(target))).toBe(path);
    }
  });

  it("encodes the path as one query value", () => {
    expect(signInPath("/dashboard/abc/products?x=1&redirect=//evil.example")).toBe(
      "/sign-in?redirect=%2Fdashboard%2Fabc%2Fproducts%3Fx%3D1%26redirect%3D%2F%2Fevil.example",
    );
  });

  it.each([
    ["an absolute URL", "https://evil.example/phish"],
    ["a protocol-relative URL", "//evil.example"],
    ["a backslash", "/\\evil.example"],
    ["a tab between the slashes", "/\t/evil.example"],
    ["not a string", undefined],
  ])("returns to /dashboard for %s", (_label, raw) => {
    expect(signInPath(raw)).toBe("/sign-in?redirect=%2Fdashboard");
  });
});
