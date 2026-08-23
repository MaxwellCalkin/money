import type { SqlExecutor } from "./database.ts";

export type TreasuryProvider = "column" | (string & {});
export type TreasuryPayoutState =
  | "queued" | "submitting" | "submitted" | "settled"
  | "failed" | "returned" | "cancelled" | "manual_review";

type Micros = bigint | number | string;
type Timestamp = Date | string;

interface TreasuryCommandRow extends Record<string, unknown> {
  result_status: string;
  replayed: boolean;
  funding_id?: string | null;
  payout_id?: string | null;
  transfer_id?: string | null;
  reversal_transfer_id?: string | null;
  receipt_id?: string | null;
  denial_code?: string | null;
  reason?: string | null;
  user_balance_micros?: Micros | null;
  source_balance_micros?: Micros | null;
  recovered_exposure_micros?: Micros | null;
  opened_exposure_micros?: Micros | null;
}

interface RouteRow extends Record<string, unknown> {
  id: string;
  user_id?: string;
  provider: string;
  label: string;
  status: "active" | "disabled";
  created_at: Timestamp;
}

interface DestinationRow extends Record<string, unknown> {
  id: string;
  account_id?: string;
  provider: string;
  label: string;
  status: "verified" | "disabled";
  verified_at: Timestamp;
  created_at: Timestamp;
}

interface PayoutRow extends Record<string, unknown> {
  id: string;
  destination_id: string;
  provider: string;
  asset_code: string;
  amount_micros: Micros;
  state: TreasuryPayoutState;
  attempts: number;
  provider_transfer_id: string | null;
  last_error: string | null;
  requested_at: Timestamp;
  submitted_at: Timestamp | null;
  settled_at: Timestamp | null;
  terminal_at: Timestamp | null;
}

interface FundingRow extends Record<string, unknown> {
  id: string;
  provider: string;
  asset_code: string;
  amount_micros: Micros;
  state: "settled" | "returned";
  settled_at: Timestamp;
  returned_at: Timestamp | null;
  created_at: Timestamp;
}

interface ExposureRow extends Record<string, unknown> {
  id: string;
  funding_id: string;
  amount_micros: Micros;
  recovered_micros: Micros;
  state: "open" | "recovered" | "written_off";
  reason: string;
  created_at: Timestamp;
  resolved_at: Timestamp | null;
}

interface ControlRow extends Record<string, unknown> {
  funding_enabled: boolean;
  payouts_enabled: boolean;
  external_spend_enabled: boolean;
  card_spend_enabled?: boolean;
  max_payout_micros: Micros;
  max_pending_payout_micros: Micros;
  max_open_exposure_micros?: Micros;
  max_reconciliation_variance_micros?: Micros;
  breaker_reason: string | null;
  updated_at: Timestamp;
}

interface HealthRow extends Record<string, unknown> {
  asset_code: string;
  expected_asset_micros: Micros;
  observed_asset_micros: Micros;
  uncertain_outflow_micros: Micros;
  shortfall_micros: Micros;
  excess_micros: Micros;
  open_exposure_micros: Micros;
  active_asset_accounts: number;
  observed_asset_accounts: number;
  oldest_observed_at: Timestamp | null;
  snapshot_complete: boolean;
  within_tolerance: boolean;
}

export interface TreasuryRoute {
  id: string;
  userId?: string;
  provider: string;
  label: string;
  status: "active" | "disabled";
  createdAt: Date;
}

export interface TreasuryDestination {
  id: string;
  accountId?: string;
  provider: string;
  label: string;
  status: "verified" | "disabled";
  verifiedAt: Date;
  createdAt: Date;
}

export interface TreasuryPayout {
  id: string;
  destinationId: string;
  provider: string;
  asset: string;
  amountMicros: bigint;
  state: TreasuryPayoutState;
  attempts: number;
  providerTransferId?: string;
  lastError?: string;
  requestedAt: Date;
  submittedAt?: Date;
  settledAt?: Date;
  terminalAt?: Date;
}

export interface TreasuryFunding {
  id: string;
  provider: string;
  asset: string;
  amountMicros: bigint;
  state: "settled" | "returned";
  settledAt: Date;
  returnedAt?: Date;
  createdAt: Date;
}

export interface TreasuryExposure {
  id: string;
  fundingId: string;
  amountMicros: bigint;
  recoveredMicros: bigint;
  state: "open" | "recovered" | "written_off";
  reason: string;
  createdAt: Date;
  resolvedAt?: Date;
}

export interface TreasuryControls {
  fundingEnabled: boolean;
  payoutsEnabled: boolean;
  externalSpendEnabled: boolean;
  /** Card-rail breaker flag. Always present on `controlState()`; configure and
   * restore return the historical treasury shape without it (they never touch
   * the flag: tripping clears it, restore leaves it false). */
  cardSpendEnabled?: boolean;
  maxPayoutMicros: bigint;
  maxPendingPayoutMicros: bigint;
  maxOpenExposureMicros?: bigint;
  maxReconciliationVarianceMicros?: bigint;
  breakerReason?: string;
  updatedAt: Date;
}

export interface TreasuryHealth {
  asset: string;
  expectedAssetMicros: bigint;
  observedAssetMicros: bigint;
  uncertainOutflowMicros: bigint;
  shortfallMicros: bigint;
  excessMicros: bigint;
  openExposureMicros: bigint;
  activeAssetAccounts: number;
  observedAssetAccounts: number;
  oldestObservedAt?: Date;
  snapshotComplete: boolean;
  withinTolerance: boolean;
}

export interface TreasuryCommandResult {
  status: string;
  replayed: boolean;
  fundingId?: string;
  payoutId?: string;
  transferId?: string;
  reversalTransferId?: string;
  receiptId?: string;
  code?: string;
  reason?: string;
  userBalanceMicros?: bigint;
  sourceBalanceMicros?: bigint;
  recoveredExposureMicros?: bigint;
  openedExposureMicros?: bigint;
}

function date(value: Timestamp): Date {
  return value instanceof Date ? value : new Date(value);
}

function optionalDate(value: Timestamp | null): Date | undefined {
  return value === null ? undefined : date(value);
}

function optionalBigInt(value: Micros | null | undefined): bigint | undefined {
  return value === null || value === undefined ? undefined : BigInt(value);
}

function command(row?: TreasuryCommandRow): TreasuryCommandResult {
  if (!row) throw new Error("treasury command returned no result");
  return {
    status: row.result_status,
    replayed: row.replayed,
    ...(row.funding_id ? { fundingId: row.funding_id } : {}),
    ...(row.payout_id ? { payoutId: row.payout_id } : {}),
    ...(row.transfer_id ? { transferId: row.transfer_id } : {}),
    ...(row.reversal_transfer_id ? { reversalTransferId: row.reversal_transfer_id } : {}),
    ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    ...(row.denial_code ? { code: row.denial_code } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(optionalBigInt(row.user_balance_micros) !== undefined
      ? { userBalanceMicros: optionalBigInt(row.user_balance_micros)! } : {}),
    ...(optionalBigInt(row.source_balance_micros) !== undefined
      ? { sourceBalanceMicros: optionalBigInt(row.source_balance_micros)! } : {}),
    ...(optionalBigInt(row.recovered_exposure_micros) !== undefined
      ? { recoveredExposureMicros: optionalBigInt(row.recovered_exposure_micros)! } : {}),
    ...(optionalBigInt(row.opened_exposure_micros) !== undefined
      ? { openedExposureMicros: optionalBigInt(row.opened_exposure_micros)! } : {}),
  };
}

function route(row: RouteRow): TreasuryRoute {
  return {
    id: row.id,
    ...(row.user_id ? { userId: row.user_id } : {}),
    provider: row.provider,
    label: row.label,
    status: row.status,
    createdAt: date(row.created_at),
  };
}

function destination(row: DestinationRow): TreasuryDestination {
  return {
    id: row.id,
    ...(row.account_id ? { accountId: row.account_id } : {}),
    provider: row.provider,
    label: row.label,
    status: row.status,
    verifiedAt: date(row.verified_at),
    createdAt: date(row.created_at),
  };
}

function payout(row: PayoutRow): TreasuryPayout {
  return {
    id: row.id,
    destinationId: row.destination_id,
    provider: row.provider,
    asset: row.asset_code,
    amountMicros: BigInt(row.amount_micros),
    state: row.state,
    attempts: row.attempts,
    ...(row.provider_transfer_id ? { providerTransferId: row.provider_transfer_id } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    requestedAt: date(row.requested_at),
    ...(optionalDate(row.submitted_at) ? { submittedAt: optionalDate(row.submitted_at)! } : {}),
    ...(optionalDate(row.settled_at) ? { settledAt: optionalDate(row.settled_at)! } : {}),
    ...(optionalDate(row.terminal_at) ? { terminalAt: optionalDate(row.terminal_at)! } : {}),
  };
}

/** Typed boundary over the least-privilege treasury SECURITY DEFINER commands.
 * Each process should construct this with its own database role; the class does
 * not broaden what that role can execute. */
export class PostgresTreasury {
  constructor(readonly db: SqlExecutor) {}

  async registerDepositRoute(input: { userId: string; provider: string; providerRouteRef: string; label: string }) {
    const result = await this.db.query<RouteRow>(
      "select * from money_private.register_treasury_deposit_route($1,$2,$3,$4)",
      [input.userId, input.provider, input.providerRouteRef, input.label]
    );
    if (!result.rows[0]) throw new Error("treasury deposit route returned no result");
    return route(result.rows[0]);
  }

  async registerDestination(input: { accountId: string; provider: string; providerRef: string; label: string }) {
    const result = await this.db.query<DestinationRow>(
      "select * from money_private.register_treasury_destination($1,$2,$3,$4)",
      [input.accountId, input.provider, input.providerRef, input.label]
    );
    if (!result.rows[0]) throw new Error("treasury destination returned no result");
    return destination(result.rows[0]);
  }

  async setDestinationStatus(accountId: string, destinationId: string, status: "verified" | "disabled") {
    const result = await this.db.query<{ id: string; status: "verified" | "disabled"; updated_at: Timestamp }>(
      "select * from money_private.set_treasury_destination_status($1,$2::uuid,$3)",
      [accountId, destinationId, status]
    );
    const row = result.rows[0];
    if (!row) throw new Error("treasury destination status returned no result");
    return { id: row.id, status: row.status, updatedAt: date(row.updated_at) };
  }

  async registerAssetAccount(input: { provider: string; providerAccountRef: string; asset: string; kind: "bank" | "stablecoin" | "reserve" }) {
    const result = await this.db.query<{
      id: string; provider: string; account_ref: string; asset_code: string;
      kind: "bank" | "stablecoin" | "reserve"; active: boolean;
    }>("select * from money_private.register_treasury_asset_account($1,$2,$3,$4)", [
      input.provider, input.providerAccountRef, input.asset, input.kind,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error("treasury asset account returned no result");
    return { id: row.id, provider: row.provider, accountRef: row.account_ref, asset: row.asset_code, kind: row.kind, active: row.active };
  }

  async enqueueEvent(input: { provider: string; providerEventId: string; endpointId: string; deliveryHash: Uint8Array }) {
    const result = await this.db.query<{ inbox_id: Micros; replayed: boolean; state: string }>(
      "select * from money_private.enqueue_treasury_provider_event($1,$2,$3,$4::bytea)",
      [input.provider, input.providerEventId, input.endpointId, Buffer.from(input.deliveryHash)]
    );
    const row = result.rows[0];
    if (!row) throw new Error("treasury event enqueue returned no result");
    return { inboxId: BigInt(row.inbox_id), replayed: row.replayed, state: row.state };
  }

  async claimEvents(workerId: string, limit: number) {
    const result = await this.db.query<{
      inbox_id: Micros; provider: string; provider_event_id: string; attempts: number;
    }>("select * from money_private.claim_treasury_provider_events($1,$2)", [workerId, limit]);
    return result.rows.map((row) => ({
      inboxId: BigInt(row.inbox_id), provider: row.provider,
      providerEventId: row.provider_event_id, attempts: row.attempts,
    }));
  }

  async completeEvent(workerId: string, inboxId: bigint, outcome: "completed" | "ignored") {
    await this.db.query("select money_private.complete_treasury_provider_event($1,$2::bigint,$3)", [workerId, inboxId.toString(), outcome]);
  }

  async failEvent(workerId: string, inboxId: bigint, error: string, retryAfterSeconds: number, dead = false) {
    await this.db.query(
      "select money_private.fail_treasury_provider_event($1,$2::bigint,$3,$4,$5)",
      [workerId, inboxId.toString(), error, retryAfterSeconds, dead]
    );
  }

  async resolveEventReview(input: {
    inboxId: bigint; resolution: "retry" | "ignore"; reviewReference: string; reason: string;
  }): Promise<"queued" | "ignored"> {
    const result = await this.db.query<{ state: "queued" | "ignored" }>(
      "select money_private.resolve_treasury_event_review($1::bigint,$2,$3,$4) as state",
      [input.inboxId.toString(), input.resolution, input.reviewReference, input.reason]
    );
    const state = result.rows[0]?.state;
    if (!state) throw new Error("treasury event review resolution returned no result");
    return state;
  }

  async pollCursor(provider: string): Promise<Date | undefined> {
    const result = await this.db.query<{ cursor: Timestamp | null }>(
      "select money_private.get_treasury_poll_cursor($1) as cursor", [provider]
    );
    return result.rows[0]?.cursor ? date(result.rows[0].cursor) : undefined;
  }

  async setPollCursor(provider: string, polledThrough: Timestamp): Promise<Date> {
    const result = await this.db.query<{ cursor: Timestamp }>(
      "select money_private.set_treasury_poll_cursor($1,$2::timestamptz) as cursor",
      [provider, date(polledThrough).toISOString()]
    );
    if (!result.rows[0]) throw new Error("treasury poll cursor returned no result");
    return date(result.rows[0].cursor);
  }

  async settleFunding(input: {
    provider: string; providerEventId: string; eventType: string; providerTransferId: string;
    providerRouteRef: string; asset: string; amountMicros: Micros; occurredAt: Timestamp;
    payloadHash: Uint8Array; canonicalPayload: Record<string, unknown>;
  }): Promise<TreasuryCommandResult> {
    const result = await this.db.query<TreasuryCommandRow>(
      `select * from money_private.settle_treasury_funding(
        $1,$2,$3,$4,$5,$6,$7::bigint,$8::timestamptz,$9::bytea,$10::jsonb
      )`,
      [input.provider, input.providerEventId, input.eventType, input.providerTransferId,
        input.providerRouteRef, input.asset, BigInt(input.amountMicros).toString(), date(input.occurredAt).toISOString(),
        Buffer.from(input.payloadHash), JSON.stringify(input.canonicalPayload)]
    );
    return command(result.rows[0]);
  }

  async returnFunding(input: {
    provider: string; providerEventId: string; eventType: string; providerTransferId: string;
    asset: string; amountMicros: Micros; reason: string; occurredAt: Timestamp;
    payloadHash: Uint8Array; canonicalPayload: Record<string, unknown>;
  }): Promise<TreasuryCommandResult> {
    const result = await this.db.query<TreasuryCommandRow>(
      `select * from money_private.return_treasury_funding(
        $1,$2,$3,$4,$5,$6::bigint,$7,$8::timestamptz,$9::bytea,$10::jsonb
      )`,
      [input.provider, input.providerEventId, input.eventType, input.providerTransferId,
        input.asset, BigInt(input.amountMicros).toString(), input.reason, date(input.occurredAt).toISOString(),
        Buffer.from(input.payloadHash), JSON.stringify(input.canonicalPayload)]
    );
    return command(result.rows[0]);
  }

  async requestPayout(input: { sourceAccountId: string; idempotencyKey: string; destinationId: string; asset: string; amountMicros: Micros }) {
    const result = await this.db.query<TreasuryCommandRow>(
      "select * from money_private.request_treasury_payout($1,$2,$3::uuid,$4,$5::bigint)",
      [input.sourceAccountId, input.idempotencyKey, input.destinationId, input.asset, BigInt(input.amountMicros).toString()]
    );
    return command(result.rows[0]);
  }

  async cancelPayout(sourceAccountId: string, payoutId: string) {
    const result = await this.db.query<TreasuryCommandRow>(
      "select * from money_private.cancel_treasury_payout($1,$2::uuid)", [sourceAccountId, payoutId]
    );
    return command(result.rows[0]);
  }

  async claimPayouts(workerId: string, limit: number) {
    const result = await this.db.query<{
      payout_id: string; provider: string; provider_ref: string; source_account_id: string;
      asset_code: string; amount_micros: Micros; attempts: number;
    }>("select * from money_private.claim_treasury_payouts($1,$2)", [workerId, limit]);
    return result.rows.map((row) => ({
      payoutId: row.payout_id, provider: row.provider, providerRef: row.provider_ref,
      sourceAccountId: row.source_account_id, asset: row.asset_code,
      amountMicros: BigInt(row.amount_micros), attempts: row.attempts,
    }));
  }

  async releasePayoutClaim(workerId: string, payoutId: string, error: string, retryAfterSeconds: number) {
    await this.db.query(
      "select money_private.release_treasury_payout_claim($1,$2::uuid,$3,$4)",
      [workerId, payoutId, error, retryAfterSeconds]
    );
  }

  async failPayoutSubmission(workerId: string, payoutId: string, error: string) {
    const result = await this.db.query<{
      payout_id: string; state: "failed"; reversal_transfer_id: string; receipt_id: string;
    }>("select * from money_private.fail_treasury_payout_submission($1,$2::uuid,$3)", [workerId, payoutId, error]);
    const row = result.rows[0];
    if (!row) throw new Error("failed treasury payout submission returned no result");
    return { payoutId: row.payout_id, state: row.state, reversalTransferId: row.reversal_transfer_id, receiptId: row.receipt_id };
  }

  async markPayoutManualReview(workerId: string, payoutId: string, providerTransferId: string | undefined, error: string) {
    await this.db.query(
      "select money_private.mark_treasury_payout_manual_review($1,$2::uuid,$3,$4)",
      [workerId, payoutId, providerTransferId ?? null, error]
    );
  }

  async resolvePayoutReview(input: {
    payoutId: string;
    state: Exclude<TreasuryPayoutState, "queued" | "submitting" | "manual_review">;
    providerTransferId?: string;
    reviewReference: string;
    reason: string;
  }) {
    const result = await this.db.query<{
      payout_id: string; state: TreasuryPayoutState; replayed: boolean;
      reversal_transfer_id: string | null; receipt_id: string | null;
    }>("select * from money_private.resolve_treasury_payout_review($1::uuid,$2,$3,$4,$5)", [
      input.payoutId, input.state, input.providerTransferId ?? null,
      input.reviewReference, input.reason,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error("payout review resolution returned no result");
    return {
      payoutId: row.payout_id, state: row.state, replayed: row.replayed,
      ...(row.reversal_transfer_id ? { reversalTransferId: row.reversal_transfer_id } : {}),
      ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    };
  }

  async recordPayoutSubmission(workerId: string, payoutId: string, providerTransferId: string, providerState: Exclude<TreasuryPayoutState, "queued" | "submitting">) {
    const result = await this.db.query<{
      payout_id: string; state: TreasuryPayoutState; replayed: boolean;
      reversal_transfer_id: string | null; receipt_id: string | null;
    }>("select * from money_private.record_treasury_payout_submission($1,$2::uuid,$3,$4)", [
      workerId, payoutId, providerTransferId, providerState,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error("treasury payout submission returned no result");
    return {
      payoutId: row.payout_id, state: row.state, replayed: row.replayed,
      ...(row.reversal_transfer_id ? { reversalTransferId: row.reversal_transfer_id } : {}),
      ...(row.receipt_id ? { receiptId: row.receipt_id } : {}),
    };
  }

  async transitionPayout(input: {
    provider: string; providerEventId: string; eventType: string; providerTransferId: string;
    providerState: Exclude<TreasuryPayoutState, "queued" | "submitting">;
    asset: string; amountMicros: Micros; occurredAt: Timestamp;
    payloadHash: Uint8Array; canonicalPayload: Record<string, unknown>;
  }) {
    const result = await this.db.query<TreasuryCommandRow>(
      `select * from money_private.transition_treasury_payout(
        $1,$2,$3,$4,$5,$6,$7::bigint,$8::timestamptz,$9::bytea,$10::jsonb
      )`,
      [input.provider, input.providerEventId, input.eventType, input.providerTransferId,
        input.providerState, input.asset, BigInt(input.amountMicros).toString(), date(input.occurredAt).toISOString(),
        Buffer.from(input.payloadHash), JSON.stringify(input.canonicalPayload)]
    );
    return command(result.rows[0]);
  }

  async configureControls(input: {
    fundingEnabled: boolean; payoutsEnabled: boolean; externalSpendEnabled: boolean;
    maxPayoutMicros: Micros; maxPendingPayoutMicros: Micros; maxOpenExposureMicros: Micros;
    maxReconciliationVarianceMicros: Micros; reason: string;
  }): Promise<TreasuryControls> {
    const result = await this.db.query<ControlRow>(
      `select * from money_private.configure_treasury_controls(
        $1,$2,$3,$4::bigint,$5::bigint,$6::bigint,$7::bigint,$8
      )`,
      [input.fundingEnabled, input.payoutsEnabled, input.externalSpendEnabled,
        BigInt(input.maxPayoutMicros).toString(), BigInt(input.maxPendingPayoutMicros).toString(),
        BigInt(input.maxOpenExposureMicros).toString(), BigInt(input.maxReconciliationVarianceMicros).toString(), input.reason]
    );
    if (!result.rows[0]) throw new Error("treasury controls returned no result");
    return this.controlFromRow(result.rows[0]);
  }

  async tripBreaker(reason: string) {
    await this.db.query("select money_private.trip_treasury_breaker($1)", [reason]);
  }

  /** Enables or disables new card reserves and authorizations. Tripping the
   * breaker clears the flag; restore leaves it false until an operator calls
   * this explicitly. Returns whether the flag changed. */
  async setCardSpendEnabled(enabled: boolean, reason: string): Promise<boolean> {
    const result = await this.db.query<{ changed: boolean }>(
      "select money_private.set_card_spend_enabled($1, $2) as changed", [enabled, reason]
    );
    return result.rows[0]?.changed ?? false;
  }

  /** Operator resolution of a dead-lettered issuer card event. Card spend must
   * stay disabled while the review happens; every resolution is audited in
   * money.card_event_reviews. */
  async resolveCardEventReview(input: {
    inboxId: bigint; resolution: "retry" | "ignore"; reviewReference: string; reason: string;
  }): Promise<"queued" | "ignored"> {
    const result = await this.db.query<{ state: "queued" | "ignored" }>(
      "select money_private.resolve_card_provider_event($1::bigint,$2,$3,$4) as state",
      [input.inboxId.toString(), input.resolution, input.reviewReference, input.reason]
    );
    const state = result.rows[0]?.state;
    if (!state) throw new Error("card event review resolution returned no result");
    return state;
  }

  async restoreControls(reason: string): Promise<TreasuryControls> {
    const result = await this.db.query<ControlRow>(
      "select * from money_private.restore_treasury_controls($1)", [reason]
    );
    if (!result.rows[0]) throw new Error("treasury control restore returned no result");
    return this.controlFromRow(result.rows[0]);
  }

  async releaseFreeze(userId: string, reason: string): Promise<number> {
    const result = await this.db.query<{ count: number }>(
      "select money_private.release_treasury_freeze($1,$2) as count", [userId, reason]
    );
    return result.rows[0]?.count ?? 0;
  }

  async routes(requesterId: string): Promise<TreasuryRoute[]> {
    const result = await this.db.query<RouteRow>("select * from money_private.list_treasury_deposit_routes($1)", [requesterId]);
    return result.rows.map(route);
  }

  async destinations(requesterId: string): Promise<TreasuryDestination[]> {
    const result = await this.db.query<DestinationRow>("select * from money_private.list_treasury_destinations($1)", [requesterId]);
    return result.rows.map(destination);
  }

  async payouts(requesterId: string, limit = 100): Promise<TreasuryPayout[]> {
    const result = await this.db.query<PayoutRow>("select * from money_private.list_treasury_payouts($1,$2)", [requesterId, limit]);
    return result.rows.map(payout);
  }

  async payout(requesterId: string, payoutId: string): Promise<TreasuryPayout | undefined> {
    const result = await this.db.query<PayoutRow>(
      "select * from money_private.get_treasury_payout($1,$2::uuid)", [requesterId, payoutId]
    );
    return result.rows[0] ? payout(result.rows[0]) : undefined;
  }

  async fundings(requesterId: string, limit = 100): Promise<TreasuryFunding[]> {
    const result = await this.db.query<FundingRow>("select * from money_private.list_treasury_fundings($1,$2)", [requesterId, limit]);
    return result.rows.map((row) => ({
      id: row.id, provider: row.provider, asset: row.asset_code,
      amountMicros: BigInt(row.amount_micros), state: row.state,
      settledAt: date(row.settled_at), ...(optionalDate(row.returned_at) ? { returnedAt: optionalDate(row.returned_at)! } : {}),
      createdAt: date(row.created_at),
    }));
  }

  async exposures(requesterId: string, limit = 100): Promise<TreasuryExposure[]> {
    const result = await this.db.query<ExposureRow>("select * from money_private.list_treasury_exposures($1,$2)", [requesterId, limit]);
    return result.rows.map((row) => ({
      id: row.id, fundingId: row.funding_id, amountMicros: BigInt(row.amount_micros),
      recoveredMicros: BigInt(row.recovered_micros), state: row.state, reason: row.reason,
      createdAt: date(row.created_at), ...(optionalDate(row.resolved_at) ? { resolvedAt: optionalDate(row.resolved_at)! } : {}),
    }));
  }

  private controlFromRow(row: ControlRow): TreasuryControls {
    return {
      fundingEnabled: row.funding_enabled, payoutsEnabled: row.payouts_enabled,
      externalSpendEnabled: row.external_spend_enabled,
      ...(row.card_spend_enabled !== undefined ? { cardSpendEnabled: row.card_spend_enabled } : {}),
      maxPayoutMicros: BigInt(row.max_payout_micros),
      maxPendingPayoutMicros: BigInt(row.max_pending_payout_micros),
      ...(optionalBigInt(row.max_open_exposure_micros) !== undefined
        ? { maxOpenExposureMicros: optionalBigInt(row.max_open_exposure_micros)! } : {}),
      ...(optionalBigInt(row.max_reconciliation_variance_micros) !== undefined
        ? { maxReconciliationVarianceMicros: optionalBigInt(row.max_reconciliation_variance_micros)! } : {}),
      ...(row.breaker_reason ? { breakerReason: row.breaker_reason } : {}),
      updatedAt: date(row.updated_at),
    };
  }

  /** Treasury controls plus the card-rail flag. The card flag lives behind its
   * own function (migration 0012 leaves treasury_control_state() and its
   * grants untouched); a caller whose role has not yet been re-granted by
   * db/roles.sql reads it as disabled rather than losing the whole state. */
  async controlState(): Promise<TreasuryControls> {
    const result = await this.db.query<ControlRow>("select * from money_private.treasury_control_state()");
    if (!result.rows[0]) throw new Error("treasury control state returned no result");
    return { ...this.controlFromRow(result.rows[0]), cardSpendEnabled: await this.cardSpendEnabled() };
  }

  private async cardSpendEnabled(): Promise<boolean> {
    try {
      const result = await this.db.query<{ enabled: boolean }>(
        "select money_private.card_spend_control_state() as enabled"
      );
      return result.rows[0]?.enabled === true;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // 42501: role not yet re-granted; 42883: migration 0012 not applied. Fail closed.
      if (code === "42501" || code === "42883") return false;
      throw error;
    }
  }

  async health(): Promise<TreasuryHealth[]> {
    const result = await this.db.query<HealthRow>("select * from money_private.treasury_health()");
    return result.rows.map((row) => ({
      asset: row.asset_code, expectedAssetMicros: BigInt(row.expected_asset_micros),
      observedAssetMicros: BigInt(row.observed_asset_micros),
      uncertainOutflowMicros: BigInt(row.uncertain_outflow_micros),
      shortfallMicros: BigInt(row.shortfall_micros), excessMicros: BigInt(row.excess_micros),
      openExposureMicros: BigInt(row.open_exposure_micros),
      activeAssetAccounts: row.active_asset_accounts, observedAssetAccounts: row.observed_asset_accounts,
      ...(optionalDate(row.oldest_observed_at) ? { oldestObservedAt: optionalDate(row.oldest_observed_at)! } : {}),
      snapshotComplete: row.snapshot_complete, withinTolerance: row.within_tolerance,
    }));
  }

  async recordAssetSnapshot(input: {
    provider: string; providerAccountRef: string; asset: string;
    bookMicros: Micros; availableMicros: Micros; holdingMicros?: Micros;
    lockedMicros?: Micros; pendingMicros?: Micros; providerObservationId: string; observedAt: Timestamp;
  }) {
    const result = await this.db.query<{ snapshot_id: Micros; replayed: boolean; within_tolerance: boolean }>(
      `select * from money_private.record_treasury_asset_snapshot(
        $1,$2,$3,$4::bigint,$5::bigint,$6::bigint,$7::bigint,$8::bigint,$9,$10::timestamptz
      )`,
      [input.provider, input.providerAccountRef, input.asset,
        BigInt(input.bookMicros).toString(), BigInt(input.availableMicros).toString(),
        BigInt(input.holdingMicros ?? 0).toString(), BigInt(input.lockedMicros ?? 0).toString(),
        BigInt(input.pendingMicros ?? 0).toString(), input.providerObservationId, date(input.observedAt).toISOString()]
    );
    const row = result.rows[0];
    if (!row) throw new Error("treasury asset snapshot returned no result");
    return { snapshotId: BigInt(row.snapshot_id), replayed: row.replayed, withinTolerance: row.within_tolerance };
  }
}
