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
 *
 * Like Stripe, it saves the result of a request made with an Idempotency-Key
 * (per account) and returns that saved result, even an error, to any later
 * request with the same key. Rate-limited (429) and conflicting (409)
 * requests never started executing, so Stripe saves nothing for them; a
 * dropped connection is not saved either (the request may never have
 * reached Stripe).
 */

export type RecordedRequest = {
  method: string;
  path: string;
  params: URLSearchParams;
  stripeAccount: string | undefined;
  idempotencyKey: string | undefined;
  /** What the fake answered: a status and body, or a dropped connection. */
  reply: FakeReply;
};

export type FakeReply = { status: number; body: unknown } | { dropConnection: true };

export type FakeStripe = {
  stripe: Stripe;
  requests: RecordedRequest[];
  /** Queue a reply for the next request that has no saved result. */
  reply(reply: FakeReply): void;
  /** Forget requests, queued replies and saved results. */
  reset(): void;
  close(): Promise<void>;
};

/** Stripe's error body shape, with the error type Stripe uses for the status. */
export function stripeError(status: number, code: string, message = code): FakeReply {
  const type =
    status >= 500
      ? "api_error"
      : status === 429
        ? "rate_limit_error"
        : status === 401
          ? "authentication_error"
          : status === 409
            ? "idempotency_error"
            : "invalid_request_error";
  return { status, body: { error: { type, code, message } } };
}

export async function startFakeStripe(): Promise<FakeStripe> {
  const requests: RecordedRequest[] = [];
  const queue: FakeReply[] = [];
  const saved = new Map<string, FakeReply>();
  let refunds = 0;

  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const params = new URLSearchParams(body);
      const stripeAccount = header(req, "stripe-account");
      const idempotencyKey = header(req, "idempotency-key");
      const savedKey = idempotencyKey === undefined ? undefined : `${stripeAccount ?? ""} ${idempotencyKey}`;

      const reply =
        (savedKey === undefined ? undefined : saved.get(savedKey)) ??
        queue.shift() ??
        defaultReply(req.method ?? "", url.pathname, params);
      if (savedKey !== undefined && !saved.has(savedKey) && !isUnsaved(reply)) saved.set(savedKey, reply);
      requests.push({ method: req.method ?? "", path: url.pathname, params, stripeAccount, idempotencyKey, reply });

      if ("dropConnection" in reply) {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });

  function isUnsaved(reply: FakeReply): boolean {
    return "dropConnection" in reply || reply.status === 429 || reply.status === 409;
  }

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
    reset: () => {
      requests.length = 0;
      queue.length = 0;
      saved.clear();
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
