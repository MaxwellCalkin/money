import { createVercelMetricsApp } from "./vercel-metrics.ts";

// Vercel Node function entry for the `agentmoney-metrics` project: the same
// lazy, memoized, fail-closed boot as vercel-entry.ts, composing only the
// public metrics surface with its single read-only credential.
let app: ReturnType<typeof createVercelMetricsApp> | undefined;
let bootError: string | undefined;

function getApp() {
  if (!app && !bootError) {
    try {
      app = createVercelMetricsApp({ ...process.env });
    } catch (error) {
      bootError = error instanceof Error ? error.message : String(error);
      console.error("vercel metrics boot refused:", bootError);
    }
  }
  return app;
}

export default {
  fetch: (request: Request): Promise<Response> | Response =>
    getApp()?.fetch(request) ?? Response.json({ ok: false, error: "boot_failed" }, { status: 503 }),
};
