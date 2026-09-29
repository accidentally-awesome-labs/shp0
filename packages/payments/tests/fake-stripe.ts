import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";

/**
 * A local stand-in for api.stripe.com, which CI cannot reach (ADR-0006).
 *
 * The real Stripe SDK is pointed at it (host, port, protocol) with network
 * retries off, so tests see exactly the requests the code sends: method,
 * path, form parameters (v1) or JSON body (v2), query, Stripe-Account,
 * Stripe-Context, Stripe-Version and Idempotency-Key. Each request is
 * answered by the next queued reply, or by a default for the path.
 *
 * Like Stripe, it saves the result of a request made with an Idempotency-Key
 * (per account) and returns that saved result, even an error, to any later
 * request with the same key. A request that arrives while another with its
 * key is still executing is answered 409 (idempotency_key_in_use). Rate-
 * limited (429) and conflicting (409) requests never started executing, so
 * Stripe saves nothing for them; a dropped connection is not saved either
 * (the request may never have reached Stripe). A key reused with a different
 * body is refused (400 idempotency_error). Whether v2 errors are saved is an
 * option, since Stripe's v2 behaviour is not established (ADR-0006).
 */

export type RecordedRequest = {
  method: string;
  path: string;
  /** A v1 request's form parameters (empty for v2). */
  params: URLSearchParams;
  /** A v2 request's JSON body (undefined for v1 and GET). */
  body: unknown;
  query: URLSearchParams;
  stripeAccount: string | undefined;
  stripeContext: string | undefined;
  stripeVersion: string | undefined;
  idempotencyKey: string | undefined;
  /** What the fake answered: a status and body, or a dropped connection. */
  reply: FakeReply;
  /** The request was executed (and its result saved), but the connection was dropped before the answer. */
  dropped: boolean;
};

export type FakeReply =
  /** `notKept`: Stripe does not keep this answer under the key (it failed before executing). */
  | { status: number; body: unknown; notKept?: true }
  | { dropConnection: true }
  /** Execute the request and save its result, then drop the connection: Stripe did it, the answer was lost. */
  | { saveThenDrop: true };

/**
 * An Accounts v2 account the fake created, which tests move along (onboarded,
 * restricted, closed) the way Stripe would.
 */
export type FakeAccount = {
  id: string;
  metadata: Record<string, string>;
  created: string;
  closed: boolean;
  /** Whether the merchant configuration is applied. */
  applied: boolean;
  cardPayments: { status: string; status_details: Array<{ code: string; resolution: string }> };
  requirements: {
    entries: Array<{
      awaiting_action_from: "stripe" | "user";
      description: string;
      errors: Array<{ code: string; description: string }>;
      impact: Record<string, unknown>;
      minimum_deadline: { status: "currently_due" | "eventually_due" | "past_due" };
      requested_reasons: Array<{ code: string }>;
    }>;
    summary: { minimum_deadline?: { status: "currently_due" | "eventually_due" | "past_due"; time?: string } };
  };
  /** Leave configuration out of every answer, as if Stripe ignored `include`. */
  hideConfiguration?: boolean;
};

/** A new account's state: onboarding not done, card payments not yet possible. */
export function newAccountState(): Pick<FakeAccount, "closed" | "applied" | "cardPayments" | "requirements"> {
  return {
    closed: false,
    applied: true,
    cardPayments: { status: "restricted", status_details: [{ code: "requirements_past_due", resolution: "provide_info" }] },
    requirements: {
      entries: [
        {
          awaiting_action_from: "user",
          description: "Provide business details",
          errors: [],
          impact: {},
          minimum_deadline: { status: "currently_due" },
          requested_reasons: [{ code: "routine_onboarding" }],
        },
      ],
      summary: { minimum_deadline: { status: "currently_due" } },
    },
  };
}

/** An onboarded account's state: card payments active, nothing due. */
export function activeAccountState(): Pick<FakeAccount, "closed" | "applied" | "cardPayments" | "requirements"> {
  return {
    closed: false,
    applied: true,
    cardPayments: { status: "active", status_details: [] },
    requirements: { entries: [], summary: {} },
  };
}

/**
 * A Checkout Session the fake created, which tests may move along (complete,
 * paid, expired) the way a Customer and Stripe would.
 */
export type FakeSession = {
  id: string;
  account: string | undefined;
  url: string;
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  amount_total: number;
  currency: string;
  metadata: Record<string, string>;
  /** The PaymentIntent, once the Customer has paid or tried to. */
  paymentIntent: { id: string; status: string } | null;
};

export type FakeStripe = {
  stripe: Stripe;
  requests: RecordedRequest[];
  /** Checkout Sessions created through the fake, by id. */
  sessions: Map<string, FakeSession>;
  /** Accounts v2 accounts created through the fake, by id. */
  accounts: Map<string, FakeAccount>;
  /** Queue a reply for the next request that has no saved result. */
  reply(reply: FakeReply): void;
  /**
   * Run `hook` when the next request arrives, before it is answered: for
   * something that happens while shp0 waits on Stripe.
   */
  beforeNextReply(hook: () => Promise<void>): void;
  /** Forget requests, queued replies, hooks, saved results, sessions and accounts. */
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

/**
 * Start the fake. `clientRetries` is the returned client's maxNetworkRetries:
 * 0 by default, so a test sees exactly the requests the code sends; 2 is the
 * SDK's default, which production's client uses. `v2ReplayErrors` chooses
 * whether an error answer to a v2 request is saved under its key (v1 errors
 * always are).
 */
export async function startFakeStripe({
  clientRetries = 0,
  v2ReplayErrors = true,
}: { clientRetries?: number; v2ReplayErrors?: boolean } = {}): Promise<FakeStripe> {
  const requests: RecordedRequest[] = [];
  const queue: FakeReply[] = [];
  const hooks: Array<() => Promise<void>> = [];
  /** Saved results by key, with the body they were made with. */
  const saved = new Map<string, { reply: FakeReply; body: string }>();
  const accounts = new Map<string, FakeAccount>();
  let links = 0;
  /** Keys of requests being executed (a hook may hold one open). */
  const executing = new Set<string>();
  const sessions = new Map<string, FakeSession>();
  let refunds = 0;
  let sessionCount = 0;

  const server = createServer((req, res) => {
    void readBody(req).then(async (body) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const isJson = (header(req, "content-type") ?? "").startsWith("application/json");
      const json: unknown = isJson && body !== "" ? JSON.parse(body) : undefined;
      const params = new URLSearchParams(isJson ? "" : body);
      const stripeAccount = header(req, "stripe-account");
      const stripeContext = header(req, "stripe-context");
      const idempotencyKey = header(req, "idempotency-key");
      const scope = stripeAccount ?? stripeContext ?? "";
      const savedKey = idempotencyKey === undefined ? undefined : `${scope} ${idempotencyKey}`;
      const isV2 = url.pathname.startsWith("/v2/");

      let reply: FakeReply;
      let dropped = false;
      const previous = savedKey === undefined ? undefined : saved.get(savedKey);
      if (previous && previous.body !== body) {
        reply = {
          status: 400,
          body: {
            error: {
              type: "idempotency_error",
              code: "idempotency_key_reused",
              message: "Keys for idempotent requests can only be used with the same parameters.",
            },
          },
        };
      } else if (savedKey !== undefined && !previous && executing.has(savedKey)) {
        reply = stripeError(
          409,
          "idempotency_key_in_use",
          "There is currently another in-progress request using this Idempotent Key.",
        );
      } else {
        if (savedKey !== undefined) executing.add(savedKey);
        try {
          await hooks.shift()?.();
          let next = previous?.reply ?? queue.shift();
          if (next && "saveThenDrop" in next) {
            next = undefined;
            dropped = true;
          }
          reply =
            next ??
            defaultReply(req.method ?? "", url.pathname, params, json, scope, url.searchParams);
          const keep = !isUnsaved(reply) && !(isV2 && !v2ReplayErrors && "status" in reply && reply.status >= 400);
          if (savedKey !== undefined && !previous && keep) saved.set(savedKey, { reply, body });
        } finally {
          if (savedKey !== undefined) executing.delete(savedKey);
        }
      }
      requests.push({
        method: req.method ?? "",
        path: url.pathname,
        params,
        body: json,
        query: url.searchParams,
        stripeAccount,
        stripeContext,
        stripeVersion: header(req, "stripe-version"),
        idempotencyKey,
        reply,
        dropped,
      });

      if (dropped || !("status" in reply)) {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status, {
        "content-type": "application/json",
        // Stripe marks an answer it replays under a key (v1 documents it; assumed for v2).
        ...(previous && previous.body === body ? { "idempotent-replayed": "true" } : {}),
      });
      res.end(JSON.stringify(reply.body));
    });
  });

  function isUnsaved(reply: FakeReply): boolean {
    return !("status" in reply) || reply.status === 429 || reply.status === 409 || reply.notKept === true;
  }

  /** The v2 `include` values of a request: from a JSON body, or include[N] in the query. */
  function includesOf(json: unknown, query: URLSearchParams): string[] {
    const fromBody = (json as { include?: unknown } | undefined)?.include;
    if (Array.isArray(fromBody)) return fromBody.map(String);
    return [...query].filter(([key]) => /^include\[\d*\]$/.test(key)).map(([, value]) => value);
  }

  function accountBody(account: FakeAccount, include: string[]) {
    const body: Record<string, unknown> = {
      id: account.id,
      object: "v2.core.account",
      applied_configurations: account.applied ? ["merchant"] : [],
      closed: account.closed,
      created: account.created,
      dashboard: "full",
      livemode: false,
      metadata: account.metadata,
    };
    if (include.includes("configuration.merchant") && !account.hideConfiguration) {
      body.configuration = {
        merchant: {
          applied: account.applied,
          capabilities: { card_payments: { ...account.cardPayments } },
        },
      };
    }
    if (include.includes("requirements")) body.requirements = account.requirements;
    if (include.includes("defaults")) {
      body.defaults = { responsibilities: { fees_collector: "stripe", losses_collector: "stripe", requirements_collector: "stripe" } };
    }
    return body;
  }

  function sessionBody(session: FakeSession, expand: string[]) {
    return {
      id: session.id,
      object: "checkout.session",
      mode: "payment",
      url: session.status === "open" ? session.url : null,
      status: session.status,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      currency: session.currency,
      metadata: session.metadata,
      payment_intent: expand.includes("payment_intent")
        ? session.paymentIntent && { object: "payment_intent", ...session.paymentIntent }
        : (session.paymentIntent?.id ?? null),
    };
  }

  function defaultReply(
    method: string,
    path: string,
    params: URLSearchParams,
    json: unknown,
    scope: string,
    query: URLSearchParams,
  ): FakeReply {
    const account = scope === "" ? undefined : scope;
    if (method === "POST" && path === "/v2/core/accounts") {
      const id = `acct_${randomBytes(8).toString("hex")}`;
      const created: FakeAccount = {
        id,
        metadata: ((json as { metadata?: Record<string, string> } | undefined)?.metadata ?? {}) as Record<string, string>,
        created: new Date().toISOString(),
        ...newAccountState(),
      };
      accounts.set(id, created);
      return { status: 200, body: accountBody(created, includesOf(json, query)) };
    }
    const accountPath = /^\/v2\/core\/accounts\/([^/]+)$/.exec(path);
    if (method === "GET" && accountPath) {
      const found = accounts.get(decodeURIComponent(accountPath[1]!));
      if (!found) return stripeError(404, "resource_missing", `No such account: '${accountPath[1]}'`);
      return { status: 200, body: accountBody(found, includesOf(undefined, query)) };
    }
    if (method === "POST" && path === "/v2/core/account_links") {
      const request = json as { account?: string; use_case?: unknown } | undefined;
      if (!request?.account || !accounts.has(request.account)) {
        return stripeError(404, "resource_missing", `No such account: '${request?.account}'`);
      }
      links += 1;
      const now = Date.now();
      return {
        status: 200,
        body: {
          object: "v2.core.account_link",
          account: request.account,
          created: new Date(now).toISOString(),
          expires_at: new Date(now + 5 * 60_000).toISOString(),
          livemode: false,
          url: `https://connect.stripe.test/setup/${links}`,
          use_case: request.use_case,
        },
      };
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      sessionCount += 1;
      const id = `cs_test_fake_${sessionCount}`;
      let amount = 0;
      for (let i = 0; params.has(`line_items[${i}][quantity]`); i++) {
        amount +=
          Number(params.get(`line_items[${i}][quantity]`)) *
          Number(params.get(`line_items[${i}][price_data][unit_amount]`));
      }
      const metadata: Record<string, string> = {};
      for (const [key, value] of params) {
        const match = /^metadata\[(.+)\]$/.exec(key);
        if (match) metadata[match[1]!] = value;
      }
      const session: FakeSession = {
        id,
        account,
        url: `https://checkout.stripe.test/c/pay/${id}`,
        status: "open",
        payment_status: "unpaid",
        amount_total: amount,
        currency: params.get("line_items[0][price_data][currency]") ?? "usd",
        metadata,
        paymentIntent: null,
      };
      sessions.set(id, session);
      return { status: 200, body: sessionBody(session, []) };
    }
    const retrieve = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path);
    if (method === "GET" && retrieve) {
      const session = sessions.get(retrieve[1]!);
      if (!session || session.account !== account) {
        return stripeError(404, "resource_missing", `No such checkout.session: '${retrieve[1]}'`);
      }
      // The SDK sends expand[0]=…; accept expand[]=… as well.
      const expand = [...query].filter(([key]) => /^expand\[\d*\]$/.test(key)).map(([, value]) => value);
      return { status: 200, body: sessionBody(session, expand) };
    }
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
    maxNetworkRetries: clientRetries,
  });

  return {
    stripe,
    requests,
    reply: (reply) => {
      queue.push(reply);
    },
    beforeNextReply: (hook) => {
      hooks.push(hook);
    },
    sessions,
    accounts,
    reset: () => {
      requests.length = 0;
      queue.length = 0;
      hooks.length = 0;
      saved.clear();
      executing.clear();
      sessions.clear();
      accounts.clear();
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
