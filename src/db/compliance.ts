import type { SqlExecutor } from "./database.ts";

type Timestamp = Date | string;
type Micros = bigint | number | string;

export type ComplianceSubjectState =
  | "unverified" | "pending" | "review" | "approved"
  | "rejected" | "restricted" | "closed";
export type ScreeningState = "pending" | "clear" | "review" | "blocked" | "error" | "expired";
export type RiskTier = "low" | "standard" | "high" | "prohibited";

interface SubjectRow extends Record<string, unknown> {
  account_id: string;
  subject_type: "individual" | "business";
  state: ComplianceSubjectState;
  risk_tier: RiskTier;
  country_code: string | null;
  screening_state: ScreeningState;
  identity_expires_at: Timestamp | null;
  screening_expires_at: Timestamp | null;
  next_review_at: Timestamp | null;
  updated_at: Timestamp;
}

interface EvidenceResultRow extends Record<string, unknown> {
  evidence_id: string;
  replayed: boolean;
  subject_state: ComplianceSubjectState;
  screening_state: ScreeningState;
}

interface CounterpartyRow extends Record<string, unknown> {
  id: string;
  kind: "wallet" | "bank_destination" | "merchant" | "domain";
  label: string;
  provider: string | null;
  provider_ref: string | null;
  state: ScreeningState;
  screened_at: Timestamp | null;
  expires_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface CaseRow extends Record<string, unknown> {
  id: string;
  subject_account_id: string | null;
  counterparty_id: string | null;
  transfer_seq: Micros | null;
  risk_decision_id: string | null;
  kind: string;
  severity: "low" | "medium" | "high" | "critical";
  status: string;
  alert_code: string;
  summary: string;
  assigned_to: string | null;
  due_at: Timestamp | null;
  closed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface RestrictionRow extends Record<string, unknown> {
  id: string;
  subject_account_id: string;
  case_id: string | null;
  reason_code: string;
  reason: string;
  restricted_at: Timestamp;
  released_at: Timestamp | null;
}

interface RiskDecisionRow extends Record<string, unknown> {
  id: string;
  actor_id: string;
  operation: string;
  source_subject_id: string | null;
  destination_subject_id: string | null;
  counterparty_id: string | null;
  asset_code: string;
  amount_micros: Micros;
  risk_tier: RiskTier | null;
  outcome: "allow" | "deny" | "review";
  rule_codes: string[];
  reason: string;
  created_at: Timestamp;
}

interface EventEnvelopeRow extends Record<string, unknown> {
  inbox_id: Micros;
  replayed: boolean;
  event_state: string;
}

interface EventClaimRow extends Record<string, unknown> {
  inbox_id: Micros;
  provider: string;
  provider_event_id: string;
  provider_result_ref: string;
  attempts: number;
}

export interface ComplianceSubject {
  accountId: string;
  subjectType: "individual" | "business";
  state: ComplianceSubjectState;
  riskTier: RiskTier;
  countryCode?: string;
  screeningState: ScreeningState;
  identityExpiresAt?: Date;
  screeningExpiresAt?: Date;
  nextReviewAt?: Date;
  updatedAt: Date;
}

export interface ComplianceCounterparty {
  id: string;
  kind: CounterpartyRow["kind"];
  label: string;
  provider?: string;
  providerRef?: string;
  state: ScreeningState;
  screenedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ComplianceCase {
  id: string;
  subjectAccountId?: string;
  counterpartyId?: string;
  transferSeq?: bigint;
  riskDecisionId?: string;
  kind: string;
  severity: CaseRow["severity"];
  status: string;
  alertCode: string;
  summary: string;
  assignedTo?: string;
  dueAt?: Date;
  closedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ComplianceRestriction {
  id: string;
  subjectAccountId: string;
  caseId?: string;
  reasonCode: string;
  reason: string;
  restrictedAt: Date;
  releasedAt?: Date;
}

export interface RiskDecision {
  id: string;
  actorId: string;
  operation: string;
  sourceSubjectId?: string;
  destinationSubjectId?: string;
  counterpartyId?: string;
  asset: string;
  amountMicros: bigint;
  riskTier?: RiskTier;
  outcome: RiskDecisionRow["outcome"];
  ruleCodes: string[];
  reason: string;
  createdAt: Date;
}

export interface ComplianceEventClaim {
  inboxId: bigint;
  provider: string;
  providerEventId: string;
  providerResultRef: string;
  attempts: number;
}

export interface RiskLimits {
  riskTier: Exclude<RiskTier, "prohibited">;
  perTransferMicros: bigint;
  dailyCrossUserMicros: bigint;
  dailyExternalMicros: bigint;
  dailyPayoutMicros: bigint;
  rolling30dOutflowMicros: bigint;
  updatedAt: Date;
}

function date(value: Timestamp): Date {
  return value instanceof Date ? value : new Date(value);
}

function optionalDate(value: Timestamp | null): Date | undefined {
  return value === null ? undefined : date(value);
}

function subject(row: SubjectRow): ComplianceSubject {
  return {
    accountId: row.account_id,
    subjectType: row.subject_type,
    state: row.state,
    riskTier: row.risk_tier,
    ...(row.country_code ? { countryCode: row.country_code } : {}),
    screeningState: row.screening_state,
    ...(optionalDate(row.identity_expires_at) ? { identityExpiresAt: optionalDate(row.identity_expires_at)! } : {}),
    ...(optionalDate(row.screening_expires_at) ? { screeningExpiresAt: optionalDate(row.screening_expires_at)! } : {}),
    ...(optionalDate(row.next_review_at) ? { nextReviewAt: optionalDate(row.next_review_at)! } : {}),
    updatedAt: date(row.updated_at),
  };
}

function counterparty(row: CounterpartyRow): ComplianceCounterparty {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.provider_ref ? { providerRef: row.provider_ref } : {}),
    state: row.state,
    ...(optionalDate(row.screened_at) ? { screenedAt: optionalDate(row.screened_at)! } : {}),
    ...(optionalDate(row.expires_at) ? { expiresAt: optionalDate(row.expires_at)! } : {}),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function complianceCase(row: CaseRow): ComplianceCase {
  return {
    id: row.id,
    ...(row.subject_account_id ? { subjectAccountId: row.subject_account_id } : {}),
    ...(row.counterparty_id ? { counterpartyId: row.counterparty_id } : {}),
    ...(row.transfer_seq !== null ? { transferSeq: BigInt(row.transfer_seq) } : {}),
    ...(row.risk_decision_id ? { riskDecisionId: row.risk_decision_id } : {}),
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    alertCode: row.alert_code,
    summary: row.summary,
    ...(row.assigned_to ? { assignedTo: row.assigned_to } : {}),
    ...(optionalDate(row.due_at) ? { dueAt: optionalDate(row.due_at)! } : {}),
    ...(optionalDate(row.closed_at) ? { closedAt: optionalDate(row.closed_at)! } : {}),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function restriction(row: RestrictionRow): ComplianceRestriction {
  return {
    id: row.id,
    subjectAccountId: row.subject_account_id,
    ...(row.case_id ? { caseId: row.case_id } : {}),
    reasonCode: row.reason_code,
    reason: row.reason,
    restrictedAt: date(row.restricted_at),
    ...(optionalDate(row.released_at) ? { releasedAt: optionalDate(row.released_at)! } : {}),
  };
}

function riskDecision(row: RiskDecisionRow): RiskDecision {
  return {
    id: row.id,
    actorId: row.actor_id,
    operation: row.operation,
    ...(row.source_subject_id ? { sourceSubjectId: row.source_subject_id } : {}),
    ...(row.destination_subject_id ? { destinationSubjectId: row.destination_subject_id } : {}),
    ...(row.counterparty_id ? { counterpartyId: row.counterparty_id } : {}),
    asset: row.asset_code,
    amountMicros: BigInt(row.amount_micros),
    ...(row.risk_tier ? { riskTier: row.risk_tier } : {}),
    outcome: row.outcome,
    ruleCodes: row.rule_codes,
    reason: row.reason,
    createdAt: date(row.created_at),
  };
}

export class PostgresCompliance {
  constructor(private readonly db: SqlExecutor) {}

  async state(requesterId: string): Promise<ComplianceSubject | undefined> {
    const result = await this.db.query<SubjectRow>(
      "select * from money_private.compliance_subject_state($1)", [requesterId]
    );
    return result.rows[0] ? subject(result.rows[0]) : undefined;
  }

  async beginVerification(input: {
    userId: string;
    subjectType: "individual" | "business";
    countryCode: string;
    expectedSingleMicros: bigint;
    expectedMonthlyMicros: bigint;
  }): Promise<ComplianceSubject> {
    const result = await this.db.query<SubjectRow>(
      "select * from money_private.begin_compliance_verification($1,$2,$3,$4,$5)",
      [input.userId, input.subjectType, input.countryCode,
        input.expectedSingleMicros, input.expectedMonthlyMicros]
    );
    if (!result.rows[0]) throw new Error("compliance onboarding returned no subject");
    return subject(result.rows[0]);
  }

  async recordEvidence(input: {
    subjectAccountId: string;
    kind: "identity" | "business" | "beneficial_owner" | "sanctions" | "pep" | "adverse_media";
    provider: string;
    providerResultRef: string;
    decision: "clear" | "review" | "blocked" | "error";
    evidenceHash: Buffer;
    listVersion?: string;
    observedAt: Date;
    expiresAt: Date;
    normalized?: Record<string, unknown>;
  }): Promise<{ evidenceId: string; replayed: boolean; subjectState: ComplianceSubjectState; screeningState: ScreeningState }> {
    const result = await this.db.query<EvidenceResultRow>(
      "select * from money_private.record_compliance_evidence($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [input.subjectAccountId, input.kind, input.provider, input.providerResultRef,
        input.decision, input.evidenceHash, input.listVersion ?? null,
        input.observedAt, input.expiresAt, input.normalized ?? {}]
    );
    const row = result.rows[0];
    if (!row) throw new Error("compliance evidence returned no result");
    return {
      evidenceId: row.evidence_id,
      replayed: row.replayed,
      subjectState: row.subject_state,
      screeningState: row.screening_state,
    };
  }

  async enqueueEvent(input: {
    provider: string;
    providerEventId: string;
    providerResultRef: string;
    endpointId: string;
    deliveryHash: Buffer;
  }): Promise<{ inboxId: bigint; replayed: boolean; state: string }> {
    const result = await this.db.query<EventEnvelopeRow>(
      "select * from money_private.enqueue_compliance_event($1,$2,$3,$4,$5)",
      [input.provider, input.providerEventId, input.providerResultRef,
        input.endpointId, input.deliveryHash]
    );
    const row = result.rows[0];
    if (!row) throw new Error("compliance enqueue returned no result");
    return { inboxId: BigInt(row.inbox_id), replayed: row.replayed, state: row.event_state };
  }

  async claimEvents(workerId: string, limit = 25): Promise<ComplianceEventClaim[]> {
    const result = await this.db.query<EventClaimRow>(
      "select * from money_private.claim_compliance_events($1,$2)", [workerId, limit]
    );
    return result.rows.map((row) => ({
      inboxId: BigInt(row.inbox_id), provider: row.provider,
      providerEventId: row.provider_event_id, providerResultRef: row.provider_result_ref,
      attempts: row.attempts,
    }));
  }

  async completeEvent(workerId: string, inboxId: bigint, evidenceId: string): Promise<boolean> {
    const result = await this.db.query<{ complete_compliance_event: boolean }>(
      "select money_private.complete_compliance_event($1,$2,$3) as complete_compliance_event",
      [workerId, inboxId, evidenceId]
    );
    return result.rows[0]?.complete_compliance_event ?? false;
  }

  async failEvent(
    workerId: string,
    inboxId: bigint,
    error: string,
    retrySeconds: number,
    dead: boolean
  ): Promise<string> {
    const result = await this.db.query<{ fail_compliance_event: string }>(
      "select money_private.fail_compliance_event($1,$2,$3,$4,$5) as fail_compliance_event",
      [workerId, inboxId, error, retrySeconds, dead]
    );
    if (!result.rows[0]) throw new Error("compliance event failure returned no result");
    return result.rows[0].fail_compliance_event;
  }

  async approveSubject(input: {
    subjectAccountId: string;
    riskTier: Exclude<RiskTier, "prohibited">;
    nextReviewAt: Date;
    reviewReference: string;
    reason: string;
  }): Promise<ComplianceSubject> {
    const result = await this.db.query<SubjectRow>(
      "select * from money_private.approve_compliance_subject($1,$2,$3,$4,$5)",
      [input.subjectAccountId, input.riskTier, input.nextReviewAt,
        input.reviewReference, input.reason]
    );
    if (!result.rows[0]) throw new Error("compliance approval returned no subject");
    return subject(result.rows[0]);
  }

  async openCase(input: {
    subjectAccountId?: string;
    counterpartyId?: string;
    transferSeq?: bigint;
    kind: string;
    severity: ComplianceCase["severity"];
    alertCode: string;
    summary: string;
    dueAt?: Date;
    reviewReference: string;
    reason: string;
  }): Promise<ComplianceCase> {
    const result = await this.db.query<CaseRow>(
      "select * from money_private.open_compliance_case($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [input.subjectAccountId ?? null, input.counterpartyId ?? null,
        input.transferSeq ?? null, input.kind, input.severity, input.alertCode,
        input.summary, input.dueAt ?? null, input.reviewReference, input.reason]
    );
    if (!result.rows[0]) throw new Error("compliance case returned no result");
    return complianceCase(result.rows[0]);
  }

  async resolveCase(input: {
    caseId: string;
    status: "closed_no_action" | "blocked" | "reported";
    reviewReference: string;
    reason: string;
    evidenceHash?: Buffer;
  }): Promise<ComplianceCase> {
    const result = await this.db.query<CaseRow>(
      "select * from money_private.resolve_compliance_case($1,$2,$3,$4,$5)",
      [input.caseId, input.status, input.reviewReference, input.reason, input.evidenceHash ?? null]
    );
    if (!result.rows[0]) throw new Error("compliance case resolution returned no result");
    return complianceCase(result.rows[0]);
  }

  async restrictSubject(input: {
    subjectAccountId: string;
    caseId?: string;
    reasonCode: string;
    reason: string;
  }): Promise<ComplianceRestriction> {
    const result = await this.db.query<RestrictionRow>(
      "select * from money_private.restrict_compliance_subject($1,$2,$3,$4)",
      [input.subjectAccountId, input.caseId ?? null, input.reasonCode, input.reason]
    );
    if (!result.rows[0]) throw new Error("compliance restriction returned no result");
    return restriction(result.rows[0]);
  }

  async releaseRestriction(input: {
    subjectAccountId: string;
    reviewReference: string;
    reason: string;
  }): Promise<ComplianceSubject> {
    const result = await this.db.query<SubjectRow>(
      "select * from money_private.release_compliance_restriction($1,$2,$3)",
      [input.subjectAccountId, input.reviewReference, input.reason]
    );
    if (!result.rows[0]) throw new Error("restriction release returned no subject");
    return subject(result.rows[0]);
  }

  async registerCounterparty(input: {
    kind: ComplianceCounterparty["kind"];
    canonicalRef: string;
    label: string;
    provider?: string;
    providerRef?: string;
  }): Promise<ComplianceCounterparty> {
    const result = await this.db.query<CounterpartyRow>(
      "select * from money_private.register_compliance_counterparty($1,$2,$3,$4,$5)",
      [input.kind, input.canonicalRef, input.label, input.provider ?? null, input.providerRef ?? null]
    );
    if (!result.rows[0]) throw new Error("counterparty registration returned no result");
    return counterparty(result.rows[0]);
  }

  async recordCounterpartyScreening(input: {
    counterpartyId: string;
    state: "clear" | "review" | "blocked" | "error";
    evidenceHash: Buffer;
    listVersion?: string;
    screenedAt: Date;
    expiresAt: Date;
  }): Promise<ComplianceCounterparty> {
    const result = await this.db.query<CounterpartyRow>(
      "select * from money_private.record_counterparty_screening($1,$2,$3,$4,$5,$6)",
      [input.counterpartyId, input.state, input.evidenceHash, input.listVersion ?? null,
        input.screenedAt, input.expiresAt]
    );
    if (!result.rows[0]) throw new Error("counterparty screening returned no result");
    return counterparty(result.rows[0]);
  }

  async linkTreasuryDestination(input: {
    destinationId: string;
    counterpartyId: string;
    reviewReference: string;
  }): Promise<void> {
    await this.db.query(
      "select * from money_private.link_treasury_destination_compliance($1,$2,$3)",
      [input.destinationId, input.counterpartyId, input.reviewReference]
    );
  }

  async configureRiskLimits(input: {
    riskTier: Exclude<RiskTier, "prohibited">;
    perTransferMicros: bigint;
    dailyCrossUserMicros: bigint;
    dailyExternalMicros: bigint;
    dailyPayoutMicros: bigint;
    rolling30dOutflowMicros: bigint;
    reviewReference: string;
    reason: string;
  }): Promise<RiskLimits> {
    const result = await this.db.query<{
      risk_tier: Exclude<RiskTier, "prohibited">;
      per_transfer_micros: Micros;
      daily_cross_user_micros: Micros;
      daily_external_micros: Micros;
      daily_payout_micros: Micros;
      rolling_30d_outflow_micros: Micros;
      updated_at: Timestamp;
    }>(
      "select * from money_private.configure_risk_limits($1,$2,$3,$4,$5,$6,$7,$8)",
      [input.riskTier, input.perTransferMicros, input.dailyCrossUserMicros,
        input.dailyExternalMicros, input.dailyPayoutMicros,
        input.rolling30dOutflowMicros, input.reviewReference, input.reason]
    );
    const row = result.rows[0];
    if (!row) throw new Error("risk limit configuration returned no result");
    return {
      riskTier: row.risk_tier,
      perTransferMicros: BigInt(row.per_transfer_micros),
      dailyCrossUserMicros: BigInt(row.daily_cross_user_micros),
      dailyExternalMicros: BigInt(row.daily_external_micros),
      dailyPayoutMicros: BigInt(row.daily_payout_micros),
      rolling30dOutflowMicros: BigInt(row.rolling_30d_outflow_micros),
      updatedAt: date(row.updated_at),
    };
  }

  async sweepExpired(limit = 100): Promise<{
    restrictedSubjects: number;
    expiredCounterparties: number;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("compliance sweep limit must be 1-500");
    }
    const result = await this.db.query<{
      restricted_subjects: number;
      expired_counterparties: number;
    }>("select * from money_private.sweep_expired_compliance($1)", [limit]);
    return {
      restrictedSubjects: Number(result.rows[0]?.restricted_subjects ?? 0),
      expiredCounterparties: Number(result.rows[0]?.expired_counterparties ?? 0),
    };
  }

  async listCases(limit = 100): Promise<ComplianceCase[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("case limit must be 1-500");
    const result = await this.db.query<CaseRow>(
      "select * from money.compliance_cases order by created_at desc, id desc limit $1", [limit]
    );
    return result.rows.map(complianceCase);
  }

  async listRiskDecisions(limit = 100): Promise<RiskDecision[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("decision limit must be 1-500");
    const result = await this.db.query<RiskDecisionRow>(
      "select * from money.risk_decisions order by created_at desc, id desc limit $1", [limit]
    );
    return result.rows.map(riskDecision);
  }
}
