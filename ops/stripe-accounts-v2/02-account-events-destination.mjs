#!/usr/bin/env node
// PR #91 (ADR-0006), step 2: the thin event destination that tells shp0 when a
// Store's Stripe account (Accounts v2) changes. Test mode only: a live-mode
// destination is set up by a person.
//
// From the repo root, after `pnpm install`:
//
//   STRIPE_SECRET_KEY=sk_test_... node ops/stripe-accounts-v2/02-account-events-destination.mjs \
//     create https://<app host> [--secret-out <file>]
//   STRIPE_SECRET_KEY=sk_test_... node ops/stripe-accounts-v2/02-account-events-destination.mjs \
//     ping <destination id>
//
// create:
//   - makes one destination, `event_payload: 'thin'`, at
//     https://<app host>/api/stripe/account-events, for the 5 account events
//     the route handles (ACCOUNT_EVENT_TYPES in packages/payments);
//   - makes nothing if a destination already points at that URL, and says
//     which one it is;
//   - writes the signing secret to a new file (mode 600, default
//     ./stripe-account-events-secret, refused if the file exists) and never
//     prints it. Set it as STRIPE_ACCOUNT_EVENTS_SECRET where the app runs,
//     then delete the file. Stripe returns the secret only on create.
// ping: once the app has the secret, sends a v2.core.event_destination.ping.
//   The app answers 200 and logs "ignored: event type not handled" when the
//   secret is right; a wrong secret is answered 400.

import { createRequire } from "node:module";
import { openSync, writeSync, closeSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(new URL("../../packages/payments/package.json", import.meta.url));
const Stripe = require("stripe");

const EVENTS = [
  "v2.core.account[configuration.merchant].capability_status_updated",
  "v2.core.account[configuration.merchant].updated",
  "v2.core.account[requirements].updated",
  "v2.core.account.updated",
  "v2.core.account.closed",
];
const ROUTE = "/api/stripe/account-events";

function fail(message) {
  console.error(`refused: ${message}`);
  process.exit(1);
}

function client() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!/^(sk|rk)_test_/.test(key)) fail("STRIPE_SECRET_KEY must be a test-mode key (sk_test_ or rk_test_)");
  const config = { maxNetworkRetries: 2 };
  // For this script's own test only: a local fake of Stripe's API.
  const local = process.env.SHP0_OPS_STRIPE_LOCAL_API;
  if (local) {
    const url = new URL(local);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
      fail("SHP0_OPS_STRIPE_LOCAL_API must be an http://127.0.0.1 URL");
    }
    Object.assign(config, { host: url.hostname, port: Number(url.port), protocol: "http" });
  }
  return new Stripe(key, config);
}

function endpointUrl(appUrl) {
  let url;
  try {
    url = new URL(appUrl);
  } catch {
    fail(`not a URL: ${appUrl}`);
  }
  if (url.protocol !== "https:") fail("the app URL must be https");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    fail("give the app's origin only, like https://shp0.example.com");
  }
  return `${url.origin}${ROUTE}`;
}

function describe(d) {
  return [
    `  id:             ${d.id}`,
    `  status:         ${d.status}`,
    `  livemode:       ${d.livemode}`,
    `  event_payload:  ${d.event_payload}`,
    `  events_from:    ${(d.events_from ?? ["@self (default)"]).join(", ")}`,
    `  url:            ${d.webhook_endpoint?.url ?? "(not returned)"}`,
    `  enabled_events: ${d.enabled_events.join("\n                  ")}`,
  ].join("\n");
}

async function create(appUrl, secretOut) {
  const url = endpointUrl(appUrl);
  const stripe = client();

  for await (const d of stripe.v2.core.eventDestinations.list({ include: ["webhook_endpoint.url"] })) {
    if (d.webhook_endpoint?.url !== url) continue;
    const same =
      d.event_payload === "thin" &&
      d.enabled_events.length === EVENTS.length &&
      EVENTS.every((e) => d.enabled_events.includes(e));
    console.log(`A destination already points at ${url}; nothing was created.\n${describe(d)}`);
    if (!same) console.log("Its payload or events differ from the 5 thin events the route handles: update it in the Dashboard.");
    if (d.status !== "enabled") console.log("It is disabled.");
    console.log("Stripe shows its signing secret only in the Dashboard (Workbench > Webhooks).");
    return;
  }

  // The file is made before Stripe is asked, so a secret is never left with nowhere to go.
  const path = resolve(secretOut);
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    fail(`cannot create ${path} (${error.code}): choose a new file with --secret-out`);
  }

  let d;
  try {
    d = await stripe.v2.core.eventDestinations.create({
      name: "shp0 account events",
      description: "Store Stripe accounts (Accounts v2): shp0 re-reads the account on each event (ADR-0006)",
      type: "webhook_endpoint",
      event_payload: "thin",
      enabled_events: EVENTS,
      webhook_endpoint: { url },
      include: ["webhook_endpoint.url", "webhook_endpoint.signing_secret"],
    });
  } catch (error) {
    closeSync(fd);
    console.error(`Stripe refused the destination: ${error?.type ?? error?.name}: ${error?.message}`);
    console.error(`${path} is empty; delete it.`);
    process.exit(1);
  }

  const secret = d.webhook_endpoint?.signing_secret ?? "";
  if (secret) writeSync(fd, `${secret}\n`);
  closeSync(fd);
  console.log(`Created the destination:\n${describe(d)}`);
  if (d.livemode) console.log("WARNING: Stripe reports this destination as live mode.");
  if (!/^whsec_/.test(secret)) {
    console.log(`Stripe returned no signing secret; ${path} is empty. Roll the secret in the Dashboard.`);
    process.exit(1);
  }
  if (secret === process.env.STRIPE_WEBHOOK_SECRET) {
    console.log("WARNING: the secret equals STRIPE_WEBHOOK_SECRET; the route refuses that. Roll it in the Dashboard.");
    process.exit(1);
  }
  console.log(`\nIts signing secret is in ${path} (mode 600). Set it as STRIPE_ACCOUNT_EVENTS_SECRET where the app runs, then delete the file.`);
}

async function ping(id) {
  if (!/^ed_[A-Za-z0-9_]+$/.test(id ?? "")) fail("give the destination id (ed_...)");
  const event = await client().v2.core.eventDestinations.ping(id);
  console.log(`Sent ${event.type} (${event.id}). The app logs "ignored: event type not handled" when its secret is right.`);
}

const [command, arg, ...rest] = process.argv.slice(2);
let secretOut = "stripe-account-events-secret";
if (rest[0] === "--secret-out" && rest[1]) secretOut = rest[1];
else if (rest.length) fail(`unexpected arguments: ${rest.join(" ")}`);

if (command === "create" && arg) await create(arg, secretOut);
else if (command === "ping" && arg && !rest.length) await ping(arg);
else fail("usage: create https://<app host> [--secret-out <file>] | ping <destination id>");
