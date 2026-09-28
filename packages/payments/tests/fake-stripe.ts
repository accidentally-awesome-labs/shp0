import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";

/**
 * A local stand-in for api.stripe.com, which CI cannot reach (ADR-0006).
 *
 * The real Stripe SDK is pointed at it (host, port, protocol) with network
 * retries off, so tests see exactly the requests the code sends: method,
 * path, form parameters, Stripe-Account and Idempotency-Key. Each request is
 * answered by the next queued reply, or by a default for the path.
 */

export type RecordedRequest = {
  method: string;
  path: string;
  params: URLSearchParams;
  stripeAccount: string | undefined;
  idempotencyKey: string | undefined;
};

export type FakeReply = { status: number; body: unknown };

export type FakeStripe = {
  stripe: Stripe;
  requests: RecordedRequest[];
  /** Queue a reply for the next request (instead of the default). */
  reply(reply: FakeReply): void;
  close(): Promise<void>;
};

/** Stripe's error body shape. */
export function stripeError(status: number, code: string, message = code): FakeReply {
  return { status, body: { error: { type: "invalid_request_error", code, message } } };
}

export async function startFakeStripe(): Promise<FakeStripe> {
  const requests: RecordedRequest[] = [];
  const queue: FakeReply[] = [];
  let refunds = 0;

  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const params = new URLSearchParams(body);
      requests.push({
        method: req.method ?? "",
        path: url.pathname,
        params,
        stripeAccount: header(req, "stripe-account"),
        idempotencyKey: header(req, "idempotency-key"),
      });
      const reply = queue.shift() ?? defaultReply(req.method ?? "", url.pathname, params);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });

  function defaultReply(method: string, path: string, params: URLSearchParams): FakeReply {
    if (method === "POST" && path === "/v1/refunds") {
      refunds += 1;
      return {
        status: 200,
        body: {
          id: `re_test_${refunds}`,
          object: "refund",
          status: "succeeded",
          payment_intent: params.get("payment_intent"),
        },
      };
    }
    return stripeError(404, "resource_missing", `fake Stripe has no route for ${method} ${path}`);
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const stripe = new Stripe("sk_test_fake", {
    host: "127.0.0.1",
    port,
    protocol: "http",
    maxNetworkRetries: 0,
  });

  return {
    stripe,
    requests,
    reply: (reply) => {
      queue.push(reply);
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
