# Launch Copy (founder posts under his own name)

Honest-voice rules applied throughout: no invented traction, no "trusted by",
honest zeroes stated outright, refusal-first framing, every quoted output is a
real capture from the repo (see `verified-transcript.txt`).

## 280-character launch post (X / Bluesky / LinkedIn opener)

269 characters (verified by script, including the quote glyphs):

```
Every agent-payments demo shows the payment succeeding. Ours peaks when the agent is REFUSED:

“$1.50 exceeds the $1.00 per-transaction cap”

Owner-signed mandate, deterministic policy outside the model, hash-chained receipts. Apache-2.0.

npx -y @agentmoney/wallet-mcp
```

Attach: the 60-second video, thumbnail = the frozen refusal JSON frame.
Reply 1 (thread continuation, optional): the GitHub link + "local demo
network; the code, the tests, and the threat model are all public. Usage today
is zero — we shipped this week."

## Show HN

**Title** (77 chars):

```
Show HN: A wallet MCP for AI agents – the demo's climax is a refused payment
```

**Body:**

```
I built agentmoney: a spend account for AI agents, published this week as two
Apache-2.0 npm packages — @agentmoney/wallet-mcp (an MCP server that gives any
agent runtime money_balance / money_pay / money_fetch with automatic HTTP 402
payment / money_feed) and @agentmoney/seller-sdk (a Hono paywall middleware
with receipt redemption and refunds). The network behind them is an
open-source closed-loop ledger.

The 60-second demo deliberately peaks on a refusal. The agent auto-pays a
$0.05 402 challenge, pays a sibling agent $0.25, and then tries $1.50 and
gets:

    { "status": "denied",
      "code": "per_tx_cap",
      "reason": "$1.50 exceeds the $1.00 per-transaction cap" }

Every agent-payments demo I've seen shows the payment succeeding. But the
whole reason to give an agent money is the moments it must NOT move. So the
security boundary is a deterministic policy engine outside any model context:
owner-signed mandates carry a budget, a per-transaction cap, a daily cap, an
escalation line (above it, the request parks in the owner's inbox and
approving executes exactly the stored payee+amount+memo tuple, exactly once),
a first-touch throttle that caps any never-seen payee at cents (a
prompt-injected agent leaks pennies, not the envelope), optional allowlists,
and expiry. Approved spends mint single-use permits bound to (agent, payee,
amount) with a 60-second TTL. Injected text can ask for money; nothing in the
agent's context can sign or widen a mandate.

The second thing I care about: wash-proof receipts. Every payment appends to a
hash-chained receipts journal; tampering with one historic amount by a single
micro-dollar breaks the chain at that exact sequence number (the demo shows
this live). Public analyses have suggested a large share of x402 volume was
self-dealing wash traffic. I can't stop anyone else from washing, but I can
make my numbers provable — receipts chain to owner-signed mandates and funding
lineage, so real usage is distinguishable from an operator paying himself. The
flip side of that choice: I have to report honest zeroes, and today that's
what they are. Published this week, no users yet.

Try it locally in ~2 minutes (the repo wants Node 24+; the published wallet
package itself runs on Node 20+):

    git clone https://github.com/MaxwellCalkin/money && cd money
    npm ci
    npm run api        # local network on :4021
    npm run onboard    # prints the .mcp.json block for Claude Code/Cursor/any MCP runtime
    npm run demo       # or: the whole story non-interactively, including the refusals

Honest status, so nobody over-reads this: it's a development sandbox. The
ledger is real double-entry (JSONL event log for the local showcase, Postgres
kernel with a 239-test suite for the production path), and the bank/treasury/
compliance boundary (ACH via Column, KYC via Persona, x402 settlement on Base)
is implemented in software but NOT activated with customer funds — a real
money-transmission launch needs a sponsor bank, licensing work, and funded
reserves that code alone can't provide. The x402 bridge runs against testnet
today. Hosted beta will be invite-only, testnet-labeled, on a single
best-effort VM.

I'd genuinely like to hear from people building agents: what would your agent
actually buy, and what refusal would you need to see before you'd hand it a
budget?
```

**Submission notes:**
- Post the repo URL as the link; the body goes in the text field.
- First comment: the 60-second video link + the asciinema cast, so the
  refusal is one click away.
- Do not upvote-solicit; do not respond to traction questions with anything
  but real numbers ("zero users; published <date>").
- If someone reproduces the demo and posts output, that's the best possible
  thread — engage with their receipts, verify their chain.
