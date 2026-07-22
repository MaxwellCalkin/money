import { serve } from "@hono/node-server";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hono, type Context, type Next } from "hono";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import { isValidPublicKey, verifyRequest } from "../core/identity.ts";
import {
  PostgresCompliance,
  type ComplianceActionRequest,
  type ComplianceCase,
  type ComplianceCaseAction,
  type ComplianceOperator,
  type ComplianceRestriction,
  type ComplianceSubject,
} from "../db/compliance.ts";
import type { TransactionalDatabase } from "../db/database.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { listenHost } from "../server/listen.ts";
import { complianceConsoleHtml } from "./console-dashboard.ts";

const MAX_BODY_BYTES = 32 * 1024;
const AUTH_WINDOW_MS = 2 * 60_000;
const CLOCK_SKEW_MS = 30_000;

type ConsoleEnv = {
  Variables: {
    operator: ComplianceOperator;
    tokenHash: Buffer;
  };
};

function databaseCode(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor && typeof cursor === "object"; depth += 1) {
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    cursor = candidate.cause;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}

function tokenHash(authorization?: string): Buffer | undefined {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice(7);
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) return undefined;
  return createHash("sha256").update(token, "utf8").digest();
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,200}$/.test(value);
}

function reviewed(value: unknown): value is { reviewReference: string; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.reviewReference === "string" && row.reviewReference.length >= 3
    && row.reviewReference.length <= 255
    && typeof row.reason === "string" && row.reason.length >= 1 && row.reason.length <= 2_000;
}

function caseView(item: ComplianceCase) {
  return {
    ...item,
    ...(item.transferSeq !== undefined ? { transferSeq: item.transferSeq.toString() } : {}),
    dueAt: item.dueAt?.toISOString(),
    closedAt: item.closedAt?.toISOString(),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function subjectView(item: ComplianceSubject) {
  return {
    ...item,
    ...(item.expectedSingleMicros !== undefined
      ? { expectedSingleMicros: item.expectedSingleMicros.toString() } : {}),
    ...(item.expectedMonthlyMicros !== undefined
      ? { expectedMonthlyMicros: item.expectedMonthlyMicros.toString() } : {}),
    identityExpiresAt: item.identityExpiresAt?.toISOString(),
    identityVerifiedAt: item.identityVerifiedAt?.toISOString(),
    screeningExpiresAt: item.screeningExpiresAt?.toISOString(),
    nextReviewAt: item.nextReviewAt?.toISOString(),
    createdAt: item.createdAt?.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function restrictionView(item: ComplianceRestriction) {
  return {
    ...item,
    restrictedAt: item.restrictedAt.toISOString(),
    releasedAt: item.releasedAt?.toISOString(),
  };
}

function actionRequestView(item: ComplianceActionRequest) {
  return {
    ...item,
    requestedAt: item.requestedAt.toISOString(),
    expiresAt: item.expiresAt.toISOString(),
    decidedAt: item.decidedAt?.toISOString(),
    executedAt: item.executedAt?.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

function caseActionView(item: ComplianceCaseAction) {
  return {
    ...item,
    id: item.id.toString(),
    ...(item.evidenceHash ? { evidenceHash: item.evidenceHash.toString("hex") } : {}),
    createdAt: item.createdAt.toISOString(),
  };
}

export function createComplianceConsoleApi(
  db: TransactionalDatabase,
  compliance = new PostgresCompliance(db),
) {
  const app = new Hono<ConsoleEnv>();
  app.onError((error, c) => {
    console.error("compliance console API error", error);
    return c.json({ error: "internal_error", reason: "The request could not be completed." }, 500);
  });

  const failure = (c: Context<ConsoleEnv>, error: unknown, fallback: string) => {
    const code = databaseCode(error);
    const reason = errorMessage(error);
    if (code === "28000") return c.json({ error: "unauthorized", reason }, 401);
    if (code === "42501") return c.json({ error: "forbidden", reason }, 403);
    if (code === "P0002") return c.json({ error: "not_found", reason }, 404);
    if (code === "22023" || code === "23503") return c.json({ error: "invalid_request", reason }, 400);
    if (code === "23505") return c.json({ error: "conflict", reason }, 409);
    console.error(fallback, error);
    return c.json({ error: fallback, reason: "The request could not be completed." }, 500);
  };

  const readBody = async <T>(c: Context<ConsoleEnv>): Promise<T | null> => {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return null;
    try { return JSON.parse(raw || "{}") as T; } catch { return null; }
  };

  const requireOperator = async (c: Context<ConsoleEnv>, next: Next) => {
    const hash = tokenHash(c.req.header("authorization"));
    if (!hash) return c.json({ error: "unauthorized" }, 401);
    const operator = await compliance.resolveOperatorSession(hash).catch(() => undefined);
    if (!operator) return c.json({ error: "unauthorized" }, 401);
    c.set("operator", operator);
    c.set("tokenHash", hash);
    await next();
  };

  app.use("/console/*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });
  app.use("/operators/sessions/current", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });

  app.get("/health/live", (c) => c.json({ ok: true }));
  app.get("/health/ready", async (c) => {
    try {
      const result = await db.query<{ ready: boolean }>(`
        select to_regclass('money.compliance_operators') is not null
          and to_regprocedure('money_private.resolve_compliance_operator_session(bytea)') is not null
          and to_regprocedure('money_private.request_compliance_action_as_operator(bytea,text,text,jsonb,text,text,text)') is not null
          as ready
      `);
      return result.rows[0]?.ready
        ? c.json({ ok: true })
        : c.json({ ok: false, error: "schema_not_ready" }, 503);
    } catch {
      return c.json({ ok: false, error: "database_unavailable" }, 503);
    }
  });

  app.get("/console", (c) => {
    c.header("content-security-policy", "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    c.header("referrer-policy", "no-referrer");
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "no-store");
    return c.html(complianceConsoleHtml);
  });

  app.post("/operators/sessions", async (c) => {
    const operatorId = c.req.header("x-operator-id");
    const nonce = c.req.header("x-signature-nonce");
    const signature = c.req.header("x-signature");
    const signedAt = Number(c.req.header("x-signature-ts"));
    const declared = Number(c.req.header("content-length") ?? 0);
    if (!operatorId || !nonce || nonce.length < 8 || !signature
      || !Number.isSafeInteger(signedAt)
      || (Number.isFinite(declared) && declared > MAX_BODY_BYTES)) {
      return c.json({ error: "unauthenticated", reason: "a signed operator request is required" }, 401);
    }
    const now = Date.now();
    if (now - signedAt > AUTH_WINDOW_MS || signedAt - now > CLOCK_SKEW_MS) {
      return c.json({ error: "unauthenticated", reason: "signature timestamp is outside the accepted window" }, 401);
    }
    const body = await c.req.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return c.json({ error: "unauthenticated", reason: "request body is too large" }, 401);
    }
    const identity = await compliance.operatorIdentity(operatorId).catch(() => undefined);
    if (!identity?.publicKey || identity.status !== "active" || !isValidPublicKey(identity.publicKey)) {
      return c.json({ error: "unauthenticated", reason: "unknown or inactive operator" }, 401);
    }
    const path = new URL(c.req.url).pathname;
    if (!verifyRequest(identity.publicKey, signature, {
      method: "POST", path, body, ts: signedAt, nonce,
    })) {
      return c.json({ error: "unauthenticated", reason: "signature verification failed" }, 401);
    }
    const requestHash = createHash("sha256")
      .update(["POST", path, body, String(signedAt), nonce].join("\n"), "utf8").digest();
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token, "utf8").digest();
    try {
      const expiresAt = await db.transaction(async (tx) => {
        const scoped = new PostgresCompliance(tx);
        await scoped.consumeOperatorRequest({
          operatorId,
          expectedPublicKey: identity.publicKey!,
          nonce,
          signedAtMs: signedAt,
          requestHash,
        });
        return scoped.createOperatorSession(operatorId, hash);
      });
      return c.json({
        token,
        expiresAt: expiresAt.getTime(),
        consolePath: `/console#token=${encodeURIComponent(token)}`,
        operator: { id: identity.id, handle: identity.handle, role: identity.role },
      }, 201);
    } catch (error) {
      return failure(c, error, "operator_session_failed");
    }
  });

  app.delete("/operators/sessions/current", requireOperator, async (c) => {
    await compliance.revokeOperatorSession(c.get("tokenHash"));
    return c.json({ revoked: true });
  });

  app.get("/console/state", requireOperator, async (c) => {
    try {
      const hash = c.get("tokenHash");
      const [cases, subjects, restrictions, actionRequests] = await Promise.all([
        compliance.listOperatorCases(hash, 200),
        compliance.listOperatorSubjects(hash, 200),
        compliance.listOperatorRestrictions(hash, 200),
        compliance.listOperatorActionRequests(hash, 200),
      ]);
      const operator = c.get("operator");
      return c.json({
        operator: { id: operator.id, name: operator.name, handle: operator.handle, role: operator.role },
        cases: cases.map(caseView),
        subjects: subjects.map(subjectView),
        restrictions: restrictions.map(restrictionView),
        actionRequests: actionRequests.map(actionRequestView),
      });
    } catch (error) {
      return failure(c, error, "console_state_failed");
    }
  });

  app.get("/console/cases/:id/actions", requireOperator, async (c) => {
    const caseId = c.req.param("id") ?? "";
    if (!validUuid(caseId)) return c.json({ error: "not_found" }, 404);
    try {
      const rows = await compliance.listOperatorCaseActions(c.get("tokenHash"), caseId, 200);
      return c.json({ actions: rows.map(caseActionView) });
    } catch (error) {
      return failure(c, error, "case_actions_failed");
    }
  });

  app.post("/console/cases/:id/claim", requireOperator, async (c) => {
    const caseId = c.req.param("id") ?? "";
    const body = await readBody<{ idempotencyKey: string; reviewReference: string; reason: string }>(c);
    if (!validUuid(caseId) || !body || !safeKey(body.idempotencyKey) || !reviewed(body)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    try {
      return c.json({ case: caseView(await compliance.claimCaseAsOperator({
        tokenHash: c.get("tokenHash"), caseId, ...body,
      })) });
    } catch (error) {
      return failure(c, error, "case_claim_failed");
    }
  });

  app.post("/console/cases/:id/notes", requireOperator, async (c) => {
    const caseId = c.req.param("id") ?? "";
    const body = await readBody<{
      idempotencyKey: string; reviewReference: string; reason: string; evidenceHash?: string;
    }>(c);
    if (!validUuid(caseId) || !body || !safeKey(body.idempotencyKey) || !reviewed(body)
      || (body.evidenceHash !== undefined && !/^[0-9a-f]{64}$/i.test(body.evidenceHash))) {
      return c.json({ error: "invalid_request" }, 400);
    }
    try {
      return c.json({ action: caseActionView(await compliance.addCaseNoteAsOperator({
        tokenHash: c.get("tokenHash"), caseId,
        idempotencyKey: body.idempotencyKey,
        reviewReference: body.reviewReference,
        reason: body.reason,
        ...(body.evidenceHash ? { evidenceHash: Buffer.from(body.evidenceHash, "hex") } : {}),
      })) });
    } catch (error) {
      return failure(c, error, "case_note_failed");
    }
  });

  app.post("/console/cases/:id/restrict", requireOperator, async (c) => {
    const caseId = c.req.param("id") ?? "";
    const body = await readBody<{
      subjectAccountId: string; reasonCode: string; idempotencyKey: string;
      reviewReference: string; reason: string;
    }>(c);
    if (!validUuid(caseId) || !body || !/^usr_[A-Za-z0-9_-]{8,128}$/.test(body.subjectAccountId)
      || !/^[a-z][a-z0-9_.:-]{1,63}$/.test(body.reasonCode)
      || !safeKey(body.idempotencyKey) || !reviewed(body)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    try {
      return c.json({ restriction: restrictionView(await compliance.restrictSubjectAsOperator({
        tokenHash: c.get("tokenHash"), caseId, ...body,
      })) });
    } catch (error) {
      return failure(c, error, "subject_restriction_failed");
    }
  });

  app.post("/console/actions", requireOperator, async (c) => {
    const body = await readBody<{
      actionType: ComplianceActionRequest["actionType"];
      targetId: string;
      payload: Record<string, unknown>;
      idempotencyKey: string;
      reviewReference: string;
      reason: string;
    }>(c);
    if (!body || !["subject_approval", "restriction_release", "case_resolution", "risk_limit_change"].includes(body.actionType)
      || typeof body.targetId !== "string" || !body.payload || Array.isArray(body.payload)
      || typeof body.payload !== "object" || !safeKey(body.idempotencyKey) || !reviewed(body)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    try {
      return c.json({ request: actionRequestView(await compliance.requestActionAsOperator({
        tokenHash: c.get("tokenHash"), ...body,
      })) }, 201);
    } catch (error) {
      return failure(c, error, "reviewed_action_failed");
    }
  });

  const decideAction = async (c: Context<ConsoleEnv>, decision: "approve" | "reject") => {
    const requestId = c.req.param("id") ?? "";
    const body = await readBody<{ reviewReference: string; reason: string }>(c);
    if (!validUuid(requestId) || !body || !reviewed(body)) {
      return c.json({ error: "invalid_request" }, 400);
    }
    try {
      const method = decision === "approve"
        ? compliance.approveActionAsOperator.bind(compliance)
        : compliance.rejectActionAsOperator.bind(compliance);
      return c.json({ request: actionRequestView(await method({
        tokenHash: c.get("tokenHash"), requestId, ...body,
      })) });
    } catch (error) {
      return failure(c, error, `action_${decision}_failed`);
    }
  };
  app.post("/console/actions/:id/approve", requireOperator, (c) => decideAction(c, "approve"));
  app.post("/console/actions/:id/reject", requireOperator, (c) => decideAction(c, "reject"));

  return app;
}

function port(value: string | undefined): number {
  const parsed = value === undefined ? 4026 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("COMPLIANCE_CONSOLE_PORT must be an integer from 1 to 65535");
  }
  return parsed;
}

export async function startComplianceConsoleServer(
  listenPort = port(process.env.COMPLIANCE_CONSOLE_PORT),
) {
  enforceProductionPreflight("compliance-console");
  const connectionString = process.env.MONEY_COMPLIANCE_CONSOLE_DATABASE_URL;
  if (!connectionString) throw new Error("MONEY_COMPLIANCE_CONSOLE_DATABASE_URL is required");
  const db = new PostgresDatabase({
    connectionString,
    applicationName: "money-compliance-console",
    maxConnections: 5,
  });
  const app = createComplianceConsoleApi(db);
  const hostname = listenHost("127.0.0.1");
  const server = serve({ fetch: app.fetch, hostname, port: listenPort });
  console.log(`compliance console listening on http://${hostname}:${listenPort}/console`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  };
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  return { app, server, db, close };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startComplianceConsoleServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
