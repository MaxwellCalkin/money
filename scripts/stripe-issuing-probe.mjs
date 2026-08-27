// Probe Stripe TEST-mode Issuing with the founder's local key and report
// sanitized results only. The key is read from deploy/local/stripe.env and is
// never printed; any value that looks secret-shaped is redacted from output.
// Usage:
//   node scripts/stripe-issuing-probe.mjs status      # can we list issuing cards?
//   node scripts/stripe-issuing-probe.mjs cardholder  # create the test cardholder, print ic id only
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ENV_PATH = new URL("../deploy/local/stripe.env", import.meta.url);
const raw = readFileSync(ENV_PATH, "utf8");
const match = raw.match(/STRIPE_TEST_SECRET_KEY="(sk_test_[A-Za-z0-9]+)"/);
if (!match) {
  console.error("deploy/local/stripe.env does not contain a pasted sk_test_ key yet.");
  process.exit(2);
}
const key = match[1];
if (!key.startsWith("sk_test_")) {
  console.error("Refusing: only TEST-mode secret keys (sk_test_) are accepted here.");
  process.exit(2);
}

const redact = (text) =>
  text.replace(/(sk|rk|pk|whsec)_(test|live)?_?[A-Za-z0-9]{8,}/g, "[redacted]")
      .replace(/[0-9]{13,19}/g, "[digits]");

async function stripe(method, path, form) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = { raw: body.slice(0, 500) }; }
  return { status: res.status, json };
}

const mode = process.argv[2] ?? "status";

if (mode === "status") {
  const cards = await stripe("GET", "/v1/issuing/cards?limit=1");
  const holders = await stripe("GET", "/v1/issuing/cardholders?limit=3");
  console.log("GET /v1/issuing/cards ->", cards.status);
  if (cards.json.error) console.log("  error:", redact(JSON.stringify(cards.json.error, null, 2)));
  console.log("GET /v1/issuing/cardholders ->", holders.status);
  if (holders.json.error) console.log("  error:", redact(JSON.stringify(holders.json.error, null, 2)));
  if (Array.isArray(holders.json.data)) {
    for (const h of holders.json.data) console.log("  cardholder:", h.id, h.name, h.status);
  }
} else if (mode === "cardholder") {
  const created = await stripe("POST", "/v1/issuing/cardholders", {
    type: "individual",
    name: "Maxwell Calkin",
    email: "mcalkinmusic@gmail.com",
    "individual[first_name]": "Maxwell",
    "individual[last_name]": "Calkin",
    "billing[address][line1]": "354 Oyster Point Blvd",
    "billing[address][city]": "South San Francisco",
    "billing[address][state]": "CA",
    "billing[address][postal_code]": "94080",
    "billing[address][country]": "US",
  });
  console.log("POST /v1/issuing/cardholders ->", created.status);
  if (created.json.error) {
    console.log("  error:", redact(JSON.stringify(created.json.error, null, 2)));
  } else {
    console.log("  cardholder id:", created.json.id, "status:", created.json.status);
  }
} else {
  console.error("unknown mode; use: status | cardholder");
  process.exit(2);
}
