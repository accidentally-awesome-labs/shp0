import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

import {
  applySchema,
  closePools,
  platformClient,
  provisionStore,
  addCustomDomain,
  resolveStoreByCustomDomain,
  resolveStoreByHost,
  applyDomainVerification,
  listCustomDomains,
} from "../src/index";

let storeId: string; // lifecycle Store
let storeA: string;
let storeB: string;
let victimStore: string; // served on victim.shp0.dev

beforeAll(async () => {
  await applySchema();
  await platformClient((tx) =>
    tx.execute(
      sql`TRUNCATE custom_domains, subscriptions, addresses, customer_sessions, customers, discount_redemptions, discounts, collection_products, collections, cart_items, carts, order_lines, orders, products, variants, memberships, stores, "user", "session", "account", "verification" CASCADE`,
    ),
  );

  const alice = randomUUID();
  const bob = randomUUID();
  const vic = randomUUID();
  await platformClient((tx) =>
    tx.execute(
      sql`INSERT INTO "user" (id, name, email) VALUES
        (${alice}, 'Alice', 'alice-dom@example.com'),
        (${bob}, 'Bob', 'bob-dom@example.com'),
        (${vic}, 'Vic', 'vic-dom@example.com')`,
    ),
  );
  storeId = (await provisionStore({ name: "DomStore", subdomain: "dom-store", ownerId: alice })).store.id;
  storeA = (await provisionStore({ name: "Store A", subdomain: "dom-a", ownerId: alice })).store.id;
  storeB = (await provisionStore({ name: "Store B", subdomain: "dom-b", ownerId: bob })).store.id;
  victimStore = (await provisionStore({ name: "Victim", subdomain: "victim", ownerId: vic })).store.id;
});

afterAll(async () => {
  await closePools();
});

async function storedRow(hostname: string) {
  const rows = await platformClient((tx) =>
    tx.execute(
      sql`SELECT store_id, verification_status FROM custom_domains WHERE hostname = ${hostname}`,
    ),
  );
  return rows.rows[0] as { store_id: string; verification_status: string } | undefined;
}

/** Set a row's state directly: the precondition, not the behaviour under test. */
async function forceStatus(hostname: string, status: "pending" | "verified" | "failed") {
  await platformClient((tx) =>
    tx.execute(sql`UPDATE custom_domains SET verification_status = ${status} WHERE hostname = ${hostname}`),
  );
}

/**
 * Issue #14 — Custom Domain host→Store resolution + verification lifecycle.
 *
 * SECURITY: only VERIFIED domains resolve to a Store. Unverified/pending/failed
 * domains do NOT resolve (no Current Store).
 */
describe("Custom Domains (Issue #14)", () => {
  it("adds a custom domain in 'pending' state", async () => {
    const result = await addCustomDomain(storeId, "shop.acme.com");
    expect(result.id).toBeDefined();
    expect(result.txtVerificationValue).toContain("shp0-verify=");

    const domains = await listCustomDomains(storeId);
    expect(domains).toHaveLength(1);
    expect(domains[0]!.hostname).toBe("shop.acme.com");
    expect(domains[0]!.verificationStatus).toBe("pending");
    expect(domains[0]!.txtVerificationValue).toBe(result.txtVerificationValue);
  });

  it("does NOT resolve a pending domain (security — only verified resolves)", async () => {
    const resolved = await resolveStoreByCustomDomain("shop.acme.com");
    expect(resolved).toBeNull();
  });

  it("verifies a domain (pending → verified), then it resolves to the Store", async () => {
    const domains = await listCustomDomains(storeId);
    const domainId = domains[0]!.id;

    const result = await applyDomainVerification(storeId, domainId, "dns_ok");
    expect(result).toEqual({ ok: true, status: "verified" });

    // Now it resolves!
    const resolved = await resolveStoreByCustomDomain("shop.acme.com");
    expect(resolved).toBe(storeId);
  });

  it("fails a verified domain on re-verify (verified → failed → STOPS resolving)", async () => {
    const domains = await listCustomDomains(storeId);
    const domainId = domains[0]!.id;

    // Re-verify fails.
    const result = await applyDomainVerification(storeId, domainId, "dns_fail");
    expect(result).toEqual({ ok: true, status: "failed" });

    // CRITICAL: it no longer resolves (security gate — domain-expiry-takeover hole closed).
    const resolved = await resolveStoreByCustomDomain("shop.acme.com");
    expect(resolved).toBeNull();
  });

  it("retries a failed domain (failed → pending), then verifies again", async () => {
    const domains = await listCustomDomains(storeId);
    const domainId = domains[0]!.id;

    // Merchant fixes DNS and retries.
    const retry = await applyDomainVerification(storeId, domainId, "retry");
    expect(retry).toEqual({ ok: true, status: "pending" });

    // Verify again.
    await applyDomainVerification(storeId, domainId, "dns_ok");
    const resolved = await resolveStoreByCustomDomain("shop.acme.com");
    expect(resolved).toBe(storeId);
  });
});

/**
 * Issue #58 — containment of the Custom Domain takeover.
 *
 * Storefront resolution used to check Custom Domains before Subdomains, and
 * any hostname could be added. A Store could claim "victim.shp0.dev" (or the
 * platform's own hosts) and, once verified, be served there instead.
 */
describe("Custom Domain takeover containment (Issue #58)", () => {
  describe("adding a Custom Domain", () => {
    it.each(["victim.shp0.dev", "SHP0.DEV", "x.shp0.dev.", "app.shp0.dev"])(
      "rejects the platform host %j and stores nothing",
      async (hostname) => {
        await expect(addCustomDomain(storeA, hostname)).rejects.toMatchObject({
          name: "InvalidCustomDomainError",
          reason: "platform_domain",
        });

        const rows = await platformClient((tx) =>
          tx.execute(sql`SELECT hostname FROM custom_domains WHERE lower(hostname) LIKE '%shp0.dev%'`),
        );
        expect(rows.rows).toEqual([]);
      },
    );

    it.each([
      ["https://shop.example.com", "scheme"],
      ["shop.example.com:8080", "port"],
      ["shop.example.com/path", "path"],
      ["*.example.com", "wildcard"],
      ["127.0.0.1", "ip_address"],
      ["localhost", "localhost"],
      ["intranet", "single_label"],
      ["", "empty"],
    ])("rejects the malformed hostname %j (%s) and stores nothing", async (hostname, reason) => {
      await expect(addCustomDomain(storeA, hostname)).rejects.toMatchObject({ reason });
      expect(await listCustomDomains(storeA)).toEqual([]);
    });

    it("stores a valid hostname in normalized form", async () => {
      await addCustomDomain(storeA, "  Shop.Norm-Test.COM. ");
      await addCustomDomain(storeA, "münchen.de");

      const domains = await listCustomDomains(storeA);
      const byHost = new Map(domains.map((d) => [d.hostname, d]));
      expect([...byHost.keys()].sort()).toEqual(["shop.norm-test.com", "xn--mnchen-3ya.de"]);
      expect(byHost.get("shop.norm-test.com")!.isApex).toBe(false);
      expect(byHost.get("xn--mnchen-3ya.de")!.isApex).toBe(true);
    });

    it("reports a hostname that is already added as a typed error, with the same answer whichever Store holds it", async () => {
      await addCustomDomain(storeA, "dup.claim-test.com");

      // Same Store, another spelling of the same hostname.
      const sameStore = await addCustomDomain(storeA, "DUP.Claim-Test.com.").catch((error: unknown) => error);
      // Another Store.
      const otherStore = await addCustomDomain(storeB, "dup.claim-test.com").catch((error: unknown) => error);

      for (const error of [sameStore, otherStore]) {
        expect(error).toMatchObject({ name: "InvalidCustomDomainError", reason: "already_added" });
      }
      expect((otherStore as Error).message).toBe((sameStore as Error).message);

      const rows = await platformClient((tx) =>
        tx.execute(sql`SELECT store_id FROM custom_domains WHERE hostname = 'dup.claim-test.com'`),
      );
      expect(rows.rows).toEqual([{ store_id: storeA }]);
    });
  });

  describe("resolving a request host", () => {
    it("resolves a verified domain for an uppercase, port or trailing-dot Host", async () => {
      await addCustomDomain(storeA, "shop.case-test.com");
      await forceStatus("shop.case-test.com", "verified");

      for (const host of [
        "shop.case-test.com",
        "SHOP.CASE-TEST.COM",
        "shop.case-test.com:443",
        "shop.case-test.com.",
        "Shop.Case-Test.com.:8443",
      ]) {
        expect(await resolveStoreByCustomDomain(host), host).toBe(storeA);
      }
    });

    it("never resolves a stored platform-host row through the Custom Domain table", async () => {
      // Existing bad data: Store B holds VERIFIED rows for platform hosts,
      // written before hostname validation existed.
      await platformClient((tx) =>
        tx.execute(
          sql`INSERT INTO custom_domains (store_id, hostname, verification_status) VALUES
            (${storeB}, 'victim.shp0.dev', 'verified'),
            (${storeB}, 'shp0.dev', 'verified'),
            (${storeB}, 'app.shp0.dev', 'verified')`,
        ),
      );

      for (const host of ["victim.shp0.dev", "VICTIM.shp0.dev:443", "shp0.dev", "app.shp0.dev."]) {
        expect(await resolveStoreByCustomDomain(host), host).toBeNull();
      }
    });

    it("lets Subdomain resolution decide platform hosts, whatever the Custom Domain table holds", async () => {
      // The platform-host rows from the previous test are still stored.
      expect(await storedRow("victim.shp0.dev")).toEqual({ store_id: storeB, verification_status: "verified" });

      expect(await resolveStoreByHost("victim.shp0.dev")).toBe(victimStore);
      expect(await resolveStoreByHost("VICTIM.SHP0.DEV.:443")).toBe(victimStore);
      expect(await resolveStoreByHost("dom-b.shp0.dev")).toBe(storeB);
      expect(await resolveStoreByHost("shp0.dev")).toBeNull();
      expect(await resolveStoreByHost("app.shp0.dev")).toBeNull();
    });

    it("resolves a verified Custom Domain through the same entry point", async () => {
      expect(await resolveStoreByHost("SHOP.CASE-TEST.COM:443")).toBe(storeA);
      expect(await resolveStoreByHost("unknown.example.com")).toBeNull();
      expect(await resolveStoreByHost("localhost:3000")).toBeNull();
    });
  });

  describe("store scoping", () => {
    let bDomainId: string;

    beforeAll(async () => {
      bDomainId = (await addCustomDomain(storeB, "shop.beta-scope.com")).id;
    });

    it("does not list another Store's domains", async () => {
      const aHosts = (await listCustomDomains(storeA)).map((d) => d.hostname);
      expect(aHosts).not.toContain("shop.beta-scope.com");
      expect((await listCustomDomains(storeB)).map((d) => d.id)).toContain(bDomainId);
    });

    it("does not let Store A verify Store B's domain", async () => {
      const result = await applyDomainVerification(storeA, bDomainId, "dns_ok");
      expect(result).toEqual({ ok: false, reason: "not_found" });

      expect((await storedRow("shop.beta-scope.com"))!.verification_status).toBe("pending");
      expect(await resolveStoreByCustomDomain("shop.beta-scope.com")).toBeNull();
    });

    it("does not let Store A retry Store B's domain, and answers as if it did not exist", async () => {
      expect(await applyDomainVerification(storeB, bDomainId, "dns_fail")).toEqual({ ok: true, status: "failed" });

      const crossStore = await applyDomainVerification(storeA, bDomainId, "retry");
      const unknown = await applyDomainVerification(storeA, randomUUID(), "retry");
      const malformed = await applyDomainVerification(storeA, "not-a-uuid", "retry");
      expect(crossStore).toEqual({ ok: false, reason: "not_found" });
      expect(unknown).toEqual(crossStore);
      expect(malformed).toEqual(crossStore);

      expect((await storedRow("shop.beta-scope.com"))!.verification_status).toBe("failed");
    });

    it("still lets the owning Store retry its own domain", async () => {
      expect(await applyDomainVerification(storeB, bDomainId, "retry")).toEqual({ ok: true, status: "pending" });
    });
  });
});
