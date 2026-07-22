/** Mint a short-lived owner browser session without putting the long-lived
 * owner key in browser storage. The returned token lives in the URL fragment,
 * which browsers do not send in HTTP requests or server access logs. */
import {
  configuredHttpOrigin,
  DEFAULT_CLIENT_TIMEOUT_MS,
  readBoundedJsonResponse,
} from "./core/api-client.ts";
import { signedHeaders } from "./core/identity.ts";
import { secretFromEnv } from "./core/key-files.ts";

const API = configuredHttpOrigin(process.env.MONEY_API ?? "http://127.0.0.1:4021", "MONEY_API");
const USER_ID = process.env.MONEY_USER_ID;

async function main() {
  let OWNER_KEY: string | undefined;
  try {
    OWNER_KEY = secretFromEnv("MONEY_OWNER_KEY");
  } catch (error) {
    throw new Error(`could not read MONEY_OWNER_KEY_FILE: ${error instanceof Error ? error.message : error}`);
  }
  if (!USER_ID || !OWNER_KEY) {
    throw new Error("MONEY_USER_ID and MONEY_OWNER_KEY_FILE (or MONEY_OWNER_KEY) are required (written by npm run onboard)");
  }
  const path = "/owner/sessions";
  const body = "{}";
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedHeaders(USER_ID, OWNER_KEY, { method: "POST", path, body }, "x-user-id"),
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(DEFAULT_CLIENT_TIMEOUT_MS),
  });
  const result = await readBoundedJsonResponse<{
    dashboardPath?: string;
    expiresAt?: number;
    error?: string;
    reason?: string;
  }>(response, undefined, "money API response");
  if (!response.ok || !result.dashboardPath) {
    throw new Error(`session creation failed (${response.status}): ${JSON.stringify(result)}`);
  }
  console.log("Open your private owner control plane:");
  console.log(`${API}${result.dashboardPath}`);
  console.log();
  console.log(`Session expires ${new Date(result.expiresAt!).toLocaleString()}. The owner key was not sent to the browser.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
