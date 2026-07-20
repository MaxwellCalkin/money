import { signedHeaders } from "../core/identity.ts";

const API = (process.env.MONEY_COMPLIANCE_CONSOLE_URL ?? "http://127.0.0.1:4026").replace(/\/$/, "");
const OPERATOR_ID = process.env.MONEY_COMPLIANCE_OPERATOR_ID;
const OPERATOR_KEY = process.env.MONEY_COMPLIANCE_OPERATOR_KEY;

async function main() {
  if (!OPERATOR_ID || !OPERATOR_KEY) {
    throw new Error("MONEY_COMPLIANCE_OPERATOR_ID and MONEY_COMPLIANCE_OPERATOR_KEY are required");
  }
  const path = "/operators/sessions";
  const body = "{}";
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signedHeaders(OPERATOR_ID, OPERATOR_KEY, { method: "POST", path, body }, "x-operator-id"),
    },
    body,
  });
  const result = await response.json() as {
    consolePath?: string;
    expiresAt?: number;
    error?: string;
    reason?: string;
  };
  if (!response.ok || !result.consolePath) {
    throw new Error(`operator session creation failed (${response.status}): ${JSON.stringify(result)}`);
  }
  console.log("Open the compliance desk:");
  console.log(`${API}${result.consolePath}`);
  console.log();
  console.log(`Session expires ${new Date(result.expiresAt!).toLocaleString()}. The signing key was not sent to the browser.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
