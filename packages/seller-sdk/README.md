# @agentmoney/seller-sdk

Charge AI agents for your API. This is the seller SDK for a
[money](https://github.com/MaxwellCalkin/money) network: a
[Hono](https://hono.dev) paywall middleware plus a signed client for
challenges, receipt redemption, and refunds. Prices come from your registered
service — the network is authoritative, so a compromised route can never
invent one.

## Quickstart (10 minutes)

1. **Register as a provider.** Your network operator (or the repo's
   `npm run onboard:seller`) registers your `@handle`, your service, and its
   price, and gives you `MONEY_API`, `MONEY_PROVIDER_ID`, `MONEY_SERVICE_ID`,
   and a provider key file for `MONEY_PROVIDER_KEY_FILE`.

2. **Mount the paywall:**

```ts
import { Hono } from "hono";
import { createMoneySellerClient, moneyPaid, secretFromEnv } from "@agentmoney/seller-sdk";

const providerKey = secretFromEnv("MONEY_PROVIDER_KEY")!; // reads MONEY_PROVIDER_KEY_FILE or the inline var

const app = new Hono();
app.get("/report", moneyPaid({
  networkUrl: process.env.MONEY_API!,
  providerId: process.env.MONEY_PROVIDER_ID!,
  providerKey,
  serviceId: process.env.MONEY_SERVICE_ID!,
}), (c) => c.json({ report: "valuable machine-readable result" }));
```

Unpaid requests receive a 402 challenge issued by the network from your
registered price; the middleware redeems the agent's receipt (pay-once,
redeem-once) before your handler runs.

3. **Refund when you should** — partial or full, idempotent, capped at the
   original purchase:

```ts
const seller = createMoneySellerClient({
  networkUrl: process.env.MONEY_API!,
  providerId: process.env.MONEY_PROVIDER_ID!,
  providerKey,
});

await seller.refund({
  receiptId: "rcpt_...",
  amountMicros: 10_000, // $0.01 = 10,000 micros
  memo: "service credit",
  idempotencyKey: "refund-order-123-v1",
});
```

## Notes

- Zero runtime dependencies. `hono` is an optional peer used only for the
  middleware's types — `createMoneySellerClient` works in any Node app.
- Amounts are integer micro-dollars (1,000,000 micros = $1).
- Every call to the network is Ed25519-signed with your provider key and
  bound to method, path, body, timestamp, and a nonce.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
