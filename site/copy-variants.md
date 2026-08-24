# Hero copy variants — agentmoney landing page

The shipped hero (v0.14, card-rail-first):

> **Put $100 behind your agent.**
> It shops at ordinary websites with a reserved virtual card, pays other agents
> for services, and the one thing it can never do is exceed your mandate. The
> spend mandate — per-purchase cap, an ask-me-above line, a throttle on unseen
> merchants — is enforced by a deterministic policy engine outside every model
> context, live at the card network's authorization hop.

## v0.14 card-story variants

Three alternatives for the card-rail-first page. All are grounded in shipped
behavior (`npm run demo:card`, `decide_card_authorization`, the pinned
transcript in `docs/marketing/demo/agent-card-transcript.md`) — nothing here
claims traction, live cards, or a live Stripe program. Any surface that shows
the demo carries the label "sandbox, no real funds".

### Variant D — decline-forward

**Headline:** $400 of gift cards. Declined in under two seconds.

**Subhead:** Your agent shops at ordinary websites with a reserved virtual
card under your spend mandate. The one purchase that matters is the one it
can't make: an unseen gift-card merchant, refused live at the card network's
authorization hop, with a receipt. Every competitor demo shows a success —
the decline is the product.

*When to use:* if the Act 1 terminal sits directly under the hero (it does).
Strongest differentiation and the most quotable; assumes the visitor will
scroll one screen to learn what the product is.

### Variant E — founder-sentence-forward (shipped)

**Headline:** Put $100 behind your agent.

**Subhead:** It shops at ordinary websites with a reserved virtual card, pays
other agents for services, and the one thing it can never do is exceed your
mandate — a deterministic policy engine answers every card authorization
outside the model, inside the issuer's two-second window.

*When to use:* the default. Concrete dollar amount, plain verbs, and the
guarantee in the same breath; matches the README's "Your agent never sees the
card number" section and the founder draft post.

### Variant F — no-card-number-forward

**Headline:** Your agent never sees the card number.

**Subhead:** A reserved card is a single-merchant virtual card under an
owner-signed spend mandate. The agent gets the last4 and nothing PAN-shaped —
the pinned demo test proves it — while the policy engine approves the $29
purchase and declines the $400 gift-card lure at the network, live.

*When to use:* for the security-literate audience (MCP builders who have read
a prompt-injection postmortem). Leads with the containment claim; pairs best
with the blog post of the same name.

## v0.13 variants (archive — pre-card-rail)

Kept for reference; these led with the x402 refusal vignette, now Act 2 on the
page. Grounded in policy.ts, wallet-mcp, and the receipts journal.

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
