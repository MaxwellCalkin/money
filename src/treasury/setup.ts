import { pathToFileURL } from "node:url";
import { PostgresDatabase } from "../db/postgres.ts";
import { PostgresTreasury } from "../db/treasury.ts";

function argument(index: number, name: string): string {
  const value = process.argv[index];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function booleanArgument(index: number, name: string): boolean {
  const value = argument(index, name);
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

function microsArgument(index: number, name: string): bigint {
  const value = argument(index, name);
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be positive integer micros`);
  return BigInt(value);
}

function print(value: unknown) {
  console.log(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item));
}

export async function treasurySetup() {
  const connectionString = process.env.MONEY_TREASURY_ADMIN_DATABASE_URL;
  if (!connectionString) throw new Error("MONEY_TREASURY_ADMIN_DATABASE_URL is required");
  const db = new PostgresDatabase({ connectionString, applicationName: "money-treasury-setup", maxConnections: 1 });
  const treasury = new PostgresTreasury(db);
  try {
    const command = argument(2, "command");
    if (command === "deposit-route") {
      const result = await treasury.registerDepositRoute({
        userId: argument(3, "user id"), provider: "column",
        providerRouteRef: argument(4, "Column account-number id"), label: argument(5, "label"),
      });
      console.log(JSON.stringify({ id: result.id, userId: result.userId, provider: result.provider, label: result.label, status: result.status }));
      return;
    }
    if (command === "destination") {
      const result = await treasury.registerDestination({
        accountId: argument(3, "account id"), provider: "column",
        providerRef: argument(4, "verified Column counterparty id"), label: argument(5, "label"),
      });
      console.log(JSON.stringify({ id: result.id, accountId: result.accountId, provider: result.provider, label: result.label, status: result.status }));
      return;
    }
    if (command === "asset-account") {
      const kind = argument(6, "kind");
      if (!(["bank", "stablecoin", "reserve"] as const).includes(kind as "bank")) {
        throw new Error("asset-account kind must be bank, stablecoin, or reserve");
      }
      const result = await treasury.registerAssetAccount({
        provider: argument(3, "provider"), providerAccountRef: argument(4, "provider account ref"),
        asset: argument(5, "asset"), kind: kind as "bank" | "stablecoin" | "reserve",
      });
      console.log(JSON.stringify(result));
      return;
    }
    if (command === "release-freeze") {
      const released = await treasury.releaseFreeze(argument(3, "user id"), argument(4, "review reason"));
      console.log(JSON.stringify({ released }));
      return;
    }
    if (command === "resolve-payout") {
      const state = argument(4, "resolved state");
      if (!(["submitted", "settled", "failed", "returned", "cancelled"] as const).includes(
        state as "submitted"
      )) {
        throw new Error("resolved payout state must be submitted, settled, failed, returned, or cancelled");
      }
      const providerTransferId = argument(5, "provider transfer id or -");
      const result = await treasury.resolvePayoutReview({
        payoutId: argument(3, "payout id"),
        state: state as "submitted" | "settled" | "failed" | "returned" | "cancelled",
        ...(providerTransferId !== "-" ? { providerTransferId } : {}),
        reviewReference: argument(6, "review reference"),
        reason: argument(7, "review reason"),
      });
      print(result);
      return;
    }
    if (command === "resolve-event") {
      const resolution = argument(4, "resolution");
      if (resolution !== "retry" && resolution !== "ignore") {
        throw new Error("event resolution must be retry or ignore");
      }
      const state = await treasury.resolveEventReview({
        inboxId: microsArgument(3, "event inbox id"), resolution,
        reviewReference: argument(5, "review reference"),
        reason: argument(6, "review reason"),
      });
      print({ state });
      return;
    }
    if (command === "resolve-card-event") {
      const resolution = argument(4, "resolution");
      if (resolution !== "retry" && resolution !== "ignore") {
        throw new Error("card event resolution must be retry or ignore");
      }
      const state = await treasury.resolveCardEventReview({
        inboxId: microsArgument(3, "card event inbox id"), resolution,
        reviewReference: argument(5, "review reference"),
        reason: argument(6, "review reason"),
      });
      print({ state });
      return;
    }
    if (command === "configure-controls") {
      const result = await treasury.configureControls({
        fundingEnabled: booleanArgument(3, "funding enabled"),
        payoutsEnabled: booleanArgument(4, "payouts enabled"),
        externalSpendEnabled: booleanArgument(5, "external spend enabled"),
        maxPayoutMicros: microsArgument(6, "max payout"),
        maxPendingPayoutMicros: microsArgument(7, "max pending payout"),
        maxOpenExposureMicros: microsArgument(8, "max open exposure"),
        maxReconciliationVarianceMicros: BigInt(argument(9, "max reconciliation variance")),
        reason: argument(10, "review reason"),
      });
      print(result);
      return;
    }
    if (command === "restore-controls") {
      const result = await treasury.restoreControls(argument(3, "two-person review reference and reason"));
      print(result);
      return;
    }
    if (command === "card-spend") {
      const mode = argument(3, "enable or disable");
      if (mode !== "enable" && mode !== "disable") throw new Error("card-spend mode must be enable or disable");
      const reason = process.argv[4] === "--reason" ? argument(5, "review reason") : argument(4, "review reason");
      const changed = await treasury.setCardSpendEnabled(mode === "enable", reason);
      const controls = await treasury.controlState();
      print({ changed, cardSpendEnabled: controls.cardSpendEnabled ?? false, breakerReason: controls.breakerReason });
      return;
    }
    throw new Error("usage: deposit-route | destination | asset-account | release-freeze | resolve-payout | resolve-event | resolve-card-event | configure-controls | restore-controls | card-spend enable|disable --reason <text>");
  } finally {
    await db.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) treasurySetup().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
