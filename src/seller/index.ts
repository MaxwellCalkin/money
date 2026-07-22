/**
 * Public entry for the seller SDK package: the Hono paywall middleware, the
 * signed seller client (challenges, redemption, cumulative-capped refunds),
 * and the *_FILE-aware secret reader so MONEY_PROVIDER_KEY_FILE works out of
 * the box. Assembled into a standalone package by scripts/build-packages.mjs.
 */
export {
  createMoneySellerClient,
  moneyPaid,
  type MoneySellerClientOptions,
  type MoneySellerOptions,
  type NetworkJson,
  type SellerNetworkResponse,
} from "./middleware.ts";
export { secretFromEnv } from "../core/key-files.ts";
