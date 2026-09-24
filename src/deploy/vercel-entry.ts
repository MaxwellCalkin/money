import { createVercelBetaApp } from "./vercel-beta.ts";

// Vercel Node function entry for the main `agentmoney` project. Boot is lazy
// and memoized per instance: a refused boot answers 503 on every request and
// logs the reason once (reasons name variables, never values). The default
// export carries `fetch`, the Web-Standard handler shape Vercel's Node
// launcher routes raw Requests to — no body pre-parsing, so the webhook HMAC
// and the signed-body hash see the bytes the client sent.
let app: ReturnType<typeof createVercelBetaApp> | undefined;
let bootError: string | undefined;

function getApp() {
  if (!app && !bootError) {
    try {
      app = createVercelBetaApp({ ...process.env });
    } catch (error) {
      bootError = error instanceof Error ? error.message : String(error);
      console.error("vercel beta boot refused:", bootError);
    }
  }
  return app;
}

export default {
  fetch: (request: Request): Promise<Response> | Response =>
    getApp()?.fetch(request) ?? Response.json({ ok: false, error: "boot_failed" }, { status: 503 }),
};
