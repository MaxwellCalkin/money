/** Mint a short-lived owner browser session without putting the long-lived
 * owner key in browser storage. The returned token lives in the URL fragment,
 * which browsers do not send in HTTP requests or server access logs. */
import { signedHeaders } from "./core/identity.ts";

const API = (process.env.MONEY_API ?? "http://127.0.0.1:4021").replace(/\/$/, "");
const USER_ID = process.env.MONEY_USER_ID;
const OWNER_KEY = process.env.MONEY_OWNER_KEY;

async function main() {
  if (!USER_ID || !OWNER_KEY) {
    throw new Error("MONEY_USER_ID and MONEY_OWNER_KEY are required (printed by npm run onboard)");
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
  });
  const result = await response.json() as { dashboardPath?: string; expiresAt?: number; error?: string; reason?: string };
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
