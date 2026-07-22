import { serve } from "@hono/node-server";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { enforceProductionPreflight } from "../deploy/preflight.ts";
import { PostgresDatabase } from "../db/postgres.ts";
import { PostgresTreasury } from "../db/treasury.ts";
import { listenHost } from "../server/listen.ts";
import { parseColumnEvent, verifyColumnWebhook } from "./column.ts";
import { readBoundedInteger } from "./runtime.ts";

const MAX_COLUMN_EVENT_BYTES = 512 * 1024;

export interface ColumnWebhookOptions {
  secret: string;
  endpointId: string;
  maxBodyBytes?: number;
}

/** Public ingress surface. Its database identity should be
 * money_treasury_ingress, which can only enqueue an event envelope. */
export function createTreasuryWebhookApp(treasury: PostgresTreasury, options: ColumnWebhookOptions) {
  if (!options.secret || !options.endpointId) throw new Error("Column webhook secret and endpoint id are required");
  const maxBodyBytes = options.maxBodyBytes ?? MAX_COLUMN_EVENT_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error("maxBodyBytes must be a positive safe integer");
  const app = new Hono();

  app.onError((error, c) => {
    console.error("treasury webhook ingress failed", error);
    return c.json({ error: "webhook_unavailable" }, 503);
  });
  app.get("/health/live", (c) => c.json({ ok: true }));
  app.post("/webhooks/column", bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }), async (c) => {
    const length = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(length) && length > maxBodyBytes) {
      return c.json({ error: "payload_too_large" }, 413);
    }
    const rawBody = Buffer.from(await c.req.arrayBuffer());
    if (rawBody.length < 2 || rawBody.length > maxBodyBytes) {
      return c.json({ error: rawBody.length > maxBodyBytes ? "payload_too_large" : "invalid_payload" }, rawBody.length > maxBodyBytes ? 413 : 400);
    }
    if (!verifyColumnWebhook({
      rawBody,
      signature: c.req.header("column-signature"),
      endpointId: c.req.header("webhook-endpoint-id"),
      expectedEndpointId: options.endpointId,
      secret: options.secret,
    })) {
      return c.json({ error: "invalid_signature" }, 401);
    }

    let event;
    try {
      event = parseColumnEvent(JSON.parse(rawBody.toString("utf8")) as unknown);
    } catch {
      return c.json({ error: "invalid_payload" }, 400);
    }
    const result = await treasury.enqueueEvent({
      provider: "column",
      providerEventId: event.id,
      endpointId: options.endpointId,
      deliveryHash: createHash("sha256").update(rawBody).digest(),
    });
    c.header("cache-control", "no-store");
    return c.json({ accepted: true, replayed: result.replayed }, 202);
  });
  return app;
}

export async function startTreasuryWebhookServer(
  port = readBoundedInteger(process.env.TREASURY_WEBHOOK_PORT, 4023, 1, 65_535, "TREASURY_WEBHOOK_PORT")
) {
  enforceProductionPreflight("treasury-webhook");
  const connectionString = process.env.MONEY_TREASURY_INGRESS_DATABASE_URL;
  const secret = process.env.MONEY_COLUMN_WEBHOOK_SECRET;
  const endpointId = process.env.MONEY_COLUMN_WEBHOOK_ENDPOINT_ID;
  if (!connectionString || !secret || !endpointId) {
    throw new Error("MONEY_TREASURY_INGRESS_DATABASE_URL, MONEY_COLUMN_WEBHOOK_SECRET, and MONEY_COLUMN_WEBHOOK_ENDPOINT_ID are required");
  }
  const db = new PostgresDatabase({ connectionString, applicationName: "money-treasury-webhook", maxConnections: 5 });
  const app = createTreasuryWebhookApp(new PostgresTreasury(db), { secret, endpointId });
  const server = serve({ fetch: app.fetch, hostname: listenHost("127.0.0.1"), port });
  console.log(`treasury webhook ingress listening on :${port}`);
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
if (isMain) startTreasuryWebhookServer().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
