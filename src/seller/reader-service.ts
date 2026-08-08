/**
 * The founder-run paid endpoint (docs/GOTOMARKET.md M2): a genuinely useful
 * service agents can buy — fetch a public web page and return its readable
 * text — built on our own seller SDK so pilot wallets have something real to
 * purchase and the paywall dogfoods the published package.
 *
 * Safety reuses the wallet's own outbound discipline: public HTTPS only,
 * DNS/private-target refusal via AgentFetchPolicy, pinned sockets, bounded
 * bodies, no redirects followed.
 *
 * Run: MONEY_API=... MONEY_PROVIDER_ID=... MONEY_PROVIDER_KEY_FILE=...
 *      MONEY_SERVICE_ID=... npm run seller:reader
 */
import { serve } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { readBoundedResponseText } from "../core/bounded-response.ts";
import { secretFromEnv } from "../core/key-files.ts";
import { AgentFetchPolicy, pinnedAgentFetch } from "../mcp/outbound.ts";
import { listenHost } from "../server/listen.ts";
import { moneyPaid } from "./middleware.ts";

const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 200_000;
const FETCH_TIMEOUT_MS = 20_000;

/** Crude but dependency-free readable-text extraction: strip script/style,
 * convert block boundaries to newlines, collapse whitespace, decode the
 * handful of entities that dominate real pages. */
export function readableText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = withoutScripts
    .replace(/<(\/?)(p|div|section|article|br|li|h[1-6]|tr|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const decoded = withBreaks
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
  return decoded
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, MAX_OUTPUT_CHARS);
}

export function createReaderApp(options: {
  networkUrl: string;
  providerId: string;
  providerKey: string;
  serviceId: string;
  fetchPolicy?: AgentFetchPolicy;
  fetchImpl?: typeof pinnedAgentFetch;
}) {
  const policy = options.fetchPolicy ?? new AgentFetchPolicy({});
  const fetchImpl = options.fetchImpl ?? pinnedAgentFetch;
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "agentmoney-reader" }));

  app.get(
    "/read",
    moneyPaid({
      networkUrl: options.networkUrl,
      providerId: options.providerId,
      providerKey: options.providerKey,
      serviceId: options.serviceId,
    }),
    async (c) => {
      const target = c.req.query("url");
      if (!target) return c.json({ error: "invalid_request", reason: "need ?url=" }, 400);
      let validated: URL;
      try {
        validated = await policy.validate(target);
      } catch (error) {
        return c.json({
          error: "target_rejected",
          reason: error instanceof Error ? error.message : "unsafe target",
        }, 400);
      }
      try {
        const response = await fetchImpl(policy, validated.href, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          return c.json({ error: "target_redirected", reason: "redirects are not followed" }, 502);
        }
        const body = await readBoundedResponseText(response, MAX_PAGE_BYTES, "page too large");
        return c.json({
          url: validated.href,
          status: response.status,
          contentType: response.headers.get("content-type") ?? undefined,
          text: readableText(body),
        });
      } catch (error) {
        return c.json({
          error: "fetch_failed",
          reason: error instanceof Error ? error.message : "upstream fetch failed",
        }, 502);
      }
    },
  );

  return app;
}

async function main() {
  const networkUrl = process.env.MONEY_API;
  const providerId = process.env.MONEY_PROVIDER_ID;
  const providerKey = secretFromEnv("MONEY_PROVIDER_KEY");
  const serviceId = process.env.MONEY_SERVICE_ID;
  if (!networkUrl || !providerId || !providerKey || !serviceId) {
    throw new Error("MONEY_API, MONEY_PROVIDER_ID, MONEY_PROVIDER_KEY_FILE (or MONEY_PROVIDER_KEY), and MONEY_SERVICE_ID are required (from npm run onboard:seller)");
  }
  const port = Number(process.env.READER_PORT ?? 4030);
  const app = createReaderApp({ networkUrl, providerId, providerKey, serviceId });
  serve({ fetch: app.fetch, hostname: listenHost("127.0.0.1"), port });
  console.log(`agentmoney reader (paid via ${networkUrl}) listening on :${port}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
