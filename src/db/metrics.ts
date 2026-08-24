import type { TransactionalDatabase } from "./database.ts";

export type MetricsOperationClass = "internal" | "external" | "card" | "treasury" | "funding";

export interface PublicMetricsDocument {
  generatedAt: string;
  distinctFundedAgents: number;
  distinctPaidProviders: number;
  operationClasses: Array<{
    operationClass: MetricsOperationClass;
    transfers: number;
    volumeMicros: string;
  }>;
  fundingLineage: {
    devFundingMicros: string;
    externalFundingMicros: string;
    spendMicros: string;
    devAttributedSpendMicros: string;
    externalAttributedSpendMicros: string;
  };
  weekly: Array<{
    week: string;
    weekStart: string;
    transfers: number;
    volumeMicros: string;
    activeAgents: number;
    chainRoot: string;
  }>;
  cohorts: Array<{
    cohortWeek: string;
    weekStart: string;
    cohortSize: number;
    activeByWeek: number[];
  }>;
}

export interface ReceiptVerification {
  exists: boolean;
  transferSeq?: string;
  evidenceHash?: string;
  operationClass?: MetricsOperationClass;
  weekBucket?: string;
}

const OPERATION_CLASSES: ReadonlySet<string> = new Set([
  "internal", "external", "card", "treasury", "funding",
]);

/** Thin gateway over the two public metrics functions. The metrics database
 * role can execute exactly these; it holds no table selects, so nothing this
 * class could be talked into querying would return account-level data. */
export class PostgresMetrics {
  constructor(readonly db: TransactionalDatabase) {}

  async publicMetrics(): Promise<PublicMetricsDocument> {
    const result = await this.db.query<{ metrics: unknown }>(
      "select money_private.public_metrics() as metrics"
    );
    const document = result.rows[0]?.metrics;
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("public metrics returned no document");
    }
    return document as PublicMetricsDocument;
  }

  /** Lookup by exact receipt uuid only; unknown ids report existence false.
   * The database surface has no listing or enumeration counterpart. */
  async verifyReceipt(receiptId: string): Promise<ReceiptVerification> {
    const result = await this.db.query<{
      receipt_exists: boolean;
      transfer_seq: string | number | bigint;
      evidence_hash_hex: string;
      operation_class: string;
      week_bucket: string;
    }>(
      "select * from money_private.verify_receipt($1::uuid)",
      [receiptId]
    );
    const row = result.rows[0];
    if (!row || row.receipt_exists !== true) return { exists: false };
    if (!OPERATION_CLASSES.has(row.operation_class)) {
      throw new Error("receipt verification returned an unknown operation class");
    }
    return {
      exists: true,
      transferSeq: String(row.transfer_seq),
      evidenceHash: row.evidence_hash_hex,
      operationClass: row.operation_class as MetricsOperationClass,
      weekBucket: row.week_bucket,
    };
  }
}
