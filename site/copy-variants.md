# Hero copy variants — agentmoney landing page

The shipped hero (for reference):

> **The neutral spend account for AI agents.**
> Give any MCP-capable agent a wallet. The owner's mandate — budget, per-payment
> cap, daily cap, an ask-me-above line, a new-payee throttle — is enforced by a
> deterministic policy engine outside the model, and every payment leaves a
> hash-chained, tamper-evident receipt.

Three alternatives, each leaning on a different leg of the wedge. All are
grounded in shipped behavior (policy.ts, wallet-mcp, receipts journal) — nothing
here claims traction, scale, or capabilities the repo doesn't have.

## Variant A — refusal-forward

**Headline:** The agent wallet that says no.

**Subhead:** Owner-signed mandates — budget, per-payment cap, daily cap, an
ask-me-above line, a new-payee throttle — enforced by a deterministic policy
engine no prompt can reach. Every other payments demo shows a payment
succeeding; ours shows one being refused.

*When to use:* if the refused-payment terminal is the very first thing on the
page. Pairs the headline directly with the vignette; strongest differentiation,
weakest at explaining what the product is to a cold visitor.

## Variant B — neutrality-forward

**Headline:** One wallet. Every runtime. Nobody's platform.

**Subhead:** agentmoney is the neutral spend account an agent carries across
Claude Code, Cursor, and anything MCP-capable — paying network sellers and
external x402 endpoints under one owner-signed mandate, with one hash-chained
receipt feed.

*When to use:* when the audience is builders already comparing platform-locked
options (Coinbase Payments MCP session caps, Stripe Link approvals). Leads with
the structural thing platforms can't copy: not being a platform.

## Variant C — evidence-forward

**Headline:** Agent payments you can prove are real.

**Subhead:** Deterministic spending policy outside the model, and a hash-chained
receipt journal — funding lineage, refund linkage, published chain roots — that
makes wash trading structurally visible. Honest numbers, even when they're
zeroes.

*When to use:* for audiences burned by inflated agent-economy metrics (sellers
deciding whether machine demand is real, investors, ecosystem analysts). Leads
with the evidence moat rather than the wallet.
