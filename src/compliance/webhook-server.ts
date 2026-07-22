import { serve } from "@hono/node-server";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import { PostgresCompliance } from "../db/compliance.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { listenHost } from "../server/listen.ts";
import type { ComplianceWebhookCodec } from "./provider.ts";
import { createComplianceWebhookCodecFromEnv } from "./runtime.ts";

const MAX_COMPLIANCE_EVENT_BYTES = 64 * 1024;

export interface ComplianceWebhookOptions {
  codec: ComplianceWebhookCodec;
  maxBodyBytes?: number;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, name: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

/** Public compliance ingress stores only a signed event/result-reference
 * envelope. The provider result is fetched independently by another process. */
export function createComplianceWebhookApp(
  compliance: PostgresCompliance,
  options: ComplianceWebhookOptions
) {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_COMPLIANCE_EVENT_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error("maxBodyBytes must be a positive safe integer");
  }
  const app = new Hono();
  app.onError((error, c) => {
    console.error("compliance webhook ingress failed", error);
    return c.json({ error: "webhook_unavailable" }, 503);
  });
  app.get("/health/live", (c) => c.json({ ok: true }));
  app.post("/webhooks/compliance", bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }), async (c) => {
    const length = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(length) && length > maxBodyBytes) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    if (rawBody.length < 2 || rawBody.length > maxBodyBytes) {
      return c.json({ error: rawBody.length > maxBodyBytes ? "payload_too_large" : "invalid_payload" },
        rawBody.length > maxBodyBytes ? 413 : 400);
    }
    if (!options.codec.authenticate({ rawBody, headers: c.req.raw.headers })) {
      return c.json({ error: "invalid_signature" }, 401);
    }
    let event;
    try {
      event = options.codec.parse(JSON.parse(rawBody.toString("utf8")) as unknown);
    } catch {
      return c.json({ error: "invalid_payload" }, 400);
    }
    if (!event) {
      c.header("cache-control", "no-store");
      return c.json({ accepted: false, ignored: true }, 202);
    }
    const result = await compliance.enqueueEvent({
      provider: options.codec.provider,
      providerEventId: event.id,
      providerResultRef: event.resultRef,
      endpointId: options.codec.endpointId,
      deliveryHash: createHash("sha256").update(rawBody).digest(),
    });
    c.header("cache-control", "no-store");
    return c.json({ accepted: true, replayed: result.replayed }, 202);
  });
  return app;
}

export async function startComplianceWebhookServer(
  port = boundedInteger(process.env.COMPLIANCE_WEBHOOK_PORT, 4024, 1, 65_535, "COMPLIANCE_WEBHOOK_PORT")
) {
  enforceProductionPreflight("compliance-webhook");
  const connectionString = process.env.MONEY_COMPLIANCE_INGRESS_DATABASE_URL;
  if (!connectionString) throw new Error("MONEY_COMPLIANCE_INGRESS_DATABASE_URL is required");
  const db = new PostgresDatabase({
    connectionString, applicationName: "money-compliance-webhook", maxConnections: 5,
  });
  const app = createComplianceWebhookApp(new PostgresCompliance(db), {
    codec: createComplianceWebhookCodecFromEnv(),
  });
  const server = serve({ fetch: app.fetch, hostname: listenHost("127.0.0.1"), port });
  console.log(`compliance webhook ingress listening on :${port}`);
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
if (isMain) startComplianceWebhookServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
