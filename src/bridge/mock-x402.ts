import { Hono } from "hono";
import { decodeXPayment, encodeSettlement, type Eip3009Authorization, type PaymentRequired402 } from "./x402.ts";
import type { SigningDomain } from "./wallet.ts";

/**
 * A mock EXTERNAL x402 seller: speaks the real v1 wire format (JSON 402 body,
 * X-PAYMENT request header, X-PAYMENT-RESPONSE settlement header) so the
 * bridge client is exercised against protocol-shaped traffic without moving
 * real money.
 *
 * Honesty rules baked in: `verify` is REQUIRED (a broken or no-op wallet
 * signer must fail loudly, never pass silently), and authorization nonces
 * are single-use (mirroring the on-chain EIP-3009 replay revert). What this
 * mock still cannot certify: real EIP-712/secp256k1 signing, facilitator
 * verify/settle timing, gas/fees. Mock-green ≠ chain-ready.
 */
export interface MockX402Options {
  payTo: string;
  asset: string;
  network: string;
  /** Atomic units (6-decimal USDC ⇒ micro-dollars). */
  priceAtomic: string;
  resourcePath: string;
  verify: (auth: Eip3009Authorization, domain: SigningDomain, signature: string) => boolean;
  extra?: { name: string; version: string };
}

export function createMockX402Server(opts: MockX402Options) {
  const app = new Hono();
  const usedNonces = new Set<string>();
  const extra = opts.extra ?? { name: "USDC", version: "2" };

  const demand = (error: string) => {
    const body: PaymentRequired402 = {
      x402Version: 1,
      error,
      accepts: [
        {
          scheme: "exact",
          network: opts.network,
          maxAmountRequired: opts.priceAtomic,
          asset: opts.asset,
          payTo: opts.payTo,
          resource: opts.resourcePath,
          description: "Mock external market report",
          mimeType: "application/json",
          maxTimeoutSeconds: 60,
          extra,
        },
      ],
    };
    return body;
  };

  app.get(opts.resourcePath, (c) => {
    const header = c.req.header("x-payment");
    if (!header) return c.json(demand("Payment required to access this resource"), 402);

    const payment = decodeXPayment(header);
    if (!payment) return c.json(demand("malformed X-PAYMENT header"), 402);
    const auth = payment.payload.authorization;
    const nowSec = Math.floor(Date.now() / 1000);

    const reject = (why: string) => c.json(demand(`payment rejected: ${why}`), 402);
    if (payment.scheme !== "exact" || payment.network !== opts.network) return reject("wrong scheme or network");
    if (auth.to.toLowerCase() !== opts.payTo.toLowerCase()) return reject("authorization is not to this seller");
    if (!/^\d+$/.test(auth.value) || Number(auth.value) < Number(opts.priceAtomic)) return reject("underpaid");
    if (Number(auth.validAfter) > nowSec) return reject("authorization not yet valid");
    if (Number(auth.validBefore) <= nowSec) return reject("authorization expired");
    if (usedNonces.has(auth.nonce)) return reject("authorization nonce already used (on-chain replay would revert)");
    const domain: SigningDomain = { name: extra.name, version: extra.version, network: opts.network, asset: opts.asset };
    if (!opts.verify(auth, domain, payment.payload.signature)) return reject("signature verification failed");

    usedNonces.add(auth.nonce);
    c.header(
      "x-payment-response",
      encodeSettlement({
        success: true,
        transaction: "0xmock" + auth.nonce.slice(2, 26),
        network: opts.network,
        payer: auth.from,
      })
    );
    return c.json({
      resource: opts.resourcePath,
      report: "External machine-economy market report: agents settle in micros.",
      pricedAtomic: opts.priceAtomic,
      served: new Date().toISOString(),
    });
  });

  return { app, usedNonces };
}
