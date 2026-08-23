import { serve } from "@hono/node-server";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import { PostgresCards } from "../db/cards.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { listenHost } from "../server/listen.ts";
import { readBoundedInteger } from "../treasury/runtime.ts";
import {
  assertIssuerWebhookSecrets,
  ISSUER_API_VERSION,
  ISSUER_SIGNATURE_HEADER,
  parseIssuerAuthorizationRequest,
  parseIssuerEvent,
  verifyIssuerWebhook,
} from "./issuer.ts";
import { parseCardWebhookSecrets, readCardAuthTtlSeconds, readCardWebhookToleranceSeconds } from "./runtime.ts";

const MAX_CARD_EVENT_BYTES = 512 * 1024;
const DEFAULT_DECISION_DEADLINE_MS = 1_500;

export interface CardAuthorizationAppOptions {
  provider: string;
  secrets: readonly string[];
  endpointId: string;
  toleranceSeconds?: number;
  maxBodyBytes?: number;
  authTtlSeconds?: number;
  decisionDeadlineMs?: number;
  now?: () => Date;
}

interface DecisionReply {
  approved: boolean;
  cardId?: string;
  declineCode?: string;
}

/** The synchronous reply is the only thing the issuer acts on, and it must be
 * string-valued metadata. It carries no amounts, no merchant echo, and never
 * anything from the card itself. */
function respondDecision(c: Context, reply: DecisionReply) {
  c.header("stripe-version", ISSUER_API_VERSION);
  c.header("cache-control", "no-store");
  return c.json({
    approved: reply.approved,
    metadata: {
      agentmoney_decision: reply.approved ? "approved" : "declined",
      ...(reply.cardId ? { agentmoney_card: reply.cardId } : {}),
      ...(reply.declineCode ? { agentmoney_decline_code: reply.declineCode } : {}),
    },
  }, 200);
}

async function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // The losing branch may still reject later (for example when the database
  // aborts after we already answered); never let that become an unhandled
  // rejection that kills the ingress process.
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`card authorization decision exceeded ${deadlineMs}ms`)),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Public authorization ingress. Its database identity is money_card_ingress,
 * which can only decide an authorization against an existing reserve and
 * enqueue an event envelope; it cannot settle, prepare, or post transfers.
 * Every uncertain path fails closed to approved:false. */
export function createCardAuthorizationApp(cards: PostgresCards, options: CardAuthorizationAppOptions) {
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(options.provider)) {
    throw new Error("card issuer provider name is invalid");
  }
  if (!options.endpointId || options.endpointId.length > 255) {
    throw new Error("card webhook endpoint id is required");
  }
  const secrets = assertIssuerWebhookSecrets(options.secrets);
  const maxBodyBytes = options.maxBodyBytes ?? MAX_CARD_EVENT_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be a positive safe integer");
  }
  const decisionDeadlineMs = options.decisionDeadlineMs ?? DEFAULT_DECISION_DEADLINE_MS;
  if (!Number.isSafeInteger(decisionDeadlineMs) || decisionDeadlineMs < 10 || decisionDeadlineMs > 1_900) {
    throw new Error("decisionDeadlineMs must be an integer between 10 and 1900");
  }
  const authTtlSeconds = options.authTtlSeconds ?? 604_800;
  if (!Number.isSafeInteger(authTtlSeconds) || authTtlSeconds < 60 || authTtlSeconds > 2_592_000) {
    throw new Error("authTtlSeconds must be an integer between 60 and 2592000");
  }

  const app = new Hono();
  app.onError((error, c) => {
    console.error("card webhook ingress failed", error instanceof Error ? error.message : error);
    if (c.req.method === "POST" && c.req.path.endsWith("/authorization")) {
      return respondDecision(c, { approved: false, declineCode: "system" });
    }
    return c.json({ error: "webhook_unavailable" }, 503);
  });
  app.get("/health/live", (c) => c.json({ ok: true }));

  const guarded = bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  });

  async function readRawBody(c: Context): Promise<Buffer | Response> {
    const length = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(length) && length > maxBodyBytes) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    if (rawBody.length > maxBodyBytes) return c.json({ error: "payload_too_large" }, 413);
    if (rawBody.length < 2) return c.json({ error: "invalid_payload" }, 400);
    return rawBody;
  }

  function verified(c: Context, rawBody: Buffer): boolean {
    return verifyIssuerWebhook({
      rawBody,
      signatureHeader: c.req.header(ISSUER_SIGNATURE_HEADER),
      secrets,
      ...(options.toleranceSeconds !== undefined ? { toleranceSeconds: options.toleranceSeconds } : {}),
      ...(options.now ? { now: options.now() } : {}),
    });
  }

  app.post("/webhooks/:provider/authorization", guarded, async (c) => {
    if (c.req.param("provider") !== options.provider) {
      return c.json({ error: "unknown_provider" }, 404);
    }
    const rawBody = await readRawBody(c);
    if (!Buffer.isBuffer(rawBody)) return rawBody;
    if (!verified(c, rawBody)) return c.json({ error: "invalid_signature" }, 401);

    let request;
    try {
      request = parseIssuerAuthorizationRequest(JSON.parse(rawBody.toString("utf8")) as unknown);
    } catch {
      // A malformed request from an authenticated issuer is still not spend
      // authority. Decline without touching the database.
      return respondDecision(c, { approved: false, declineCode: "invalid_request" });
    }
    try {
      const decision = await withDeadline(cards.decideAuthorization({
        provider: options.provider,
        providerEventId: request.eventId,
        providerAuthorizationRef: request.authorizationRef,
        providerCardRef: request.providerCardRef,
        amountMicros: request.amountMicros,
        merchantDescriptor: request.merchantDescriptor,
        merchantMcc: request.merchantMcc,
        ...(request.merchantNetworkId !== undefined ? { merchantNetworkId: request.merchantNetworkId } : {}),
        ...(request.merchantCountry !== undefined ? { merchantCountry: request.merchantCountry } : {}),
        authTtlSeconds,
      }), decisionDeadlineMs);
      return respondDecision(c, {
        approved: decision.decision === "approved",
        ...(decision.cardId ? { cardId: decision.cardId } : {}),
        ...(decision.declineCode ? { declineCode: decision.declineCode } : {}),
      });
    } catch (error) {
      console.error(
        "card authorization decision failed",
        error instanceof Error ? error.message : "unknown error",
      );
      return respondDecision(c, { approved: false, declineCode: "system" });
    }
  });

  app.post("/webhooks/:provider/events", guarded, async (c) => {
    if (c.req.param("provider") !== options.provider) {
      return c.json({ error: "unknown_provider" }, 404);
    }
    const rawBody = await readRawBody(c);
    if (!Buffer.isBuffer(rawBody)) return rawBody;
    if (!verified(c, rawBody)) return c.json({ error: "invalid_signature" }, 401);
    let event;
    try {
      event = parseIssuerEvent(JSON.parse(rawBody.toString("utf8")) as unknown);
    } catch {
      return c.json({ error: "invalid_payload" }, 400);
    }
    // Store only the envelope. The worker re-fetches the event and its object
    // from the issuer before any command; these bytes never move money.
    const result = await cards.enqueueEvent({
      provider: options.provider,
      providerEventId: event.id,
      endpointId: options.endpointId,
      deliveryHash: createHash("sha256").update(rawBody).digest(),
    });
    c.header("cache-control", "no-store");
    return c.json({ accepted: true, replayed: result.replayed }, 202);
  });

  return app;
}

export async function startCardAuthorizationServer(
  port = readBoundedInteger(process.env.CARD_AUTHORIZATION_PORT, 4027, 1, 65_535, "CARD_AUTHORIZATION_PORT"),
) {
  enforceProductionPreflight("card-authorization");
  const connectionString = process.env.MONEY_CARD_INGRESS_DATABASE_URL;
  const provider = process.env.MONEY_CARD_PROVIDER;
  const endpointId = process.env.MONEY_CARD_WEBHOOK_ENDPOINT_ID;
  if (!connectionString || !provider || !endpointId) {
    throw new Error(
      "MONEY_CARD_INGRESS_DATABASE_URL, MONEY_CARD_PROVIDER, and MONEY_CARD_WEBHOOK_ENDPOINT_ID are required",
    );
  }
  const secrets = parseCardWebhookSecrets(process.env.MONEY_CARD_WEBHOOK_SECRETS);
  const db = new PostgresDatabase({
    connectionString, applicationName: "money-card-authorization", maxConnections: 5,
  });
  const app = createCardAuthorizationApp(new PostgresCards(db), {
    provider,
    secrets,
    endpointId,
    toleranceSeconds: readCardWebhookToleranceSeconds(process.env),
    authTtlSeconds: readCardAuthTtlSeconds(process.env),
  });
  const server = serve({ fetch: app.fetch, hostname: listenHost("127.0.0.1"), port });
  console.log(`card authorization ingress listening on :${port}`);
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
if (isMain) startCardAuthorizationServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
