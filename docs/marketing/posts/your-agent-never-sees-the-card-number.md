# Your agent never sees the card number

*Draft in founder voice — NOT POSTED. Post together with the demo transcript
(`docs/marketing/demo/agent-card-transcript.md`) and the storyboard below,
after the v0.14 gate is green. Sandbox demo: no real funds;
nothing here is a bank, card, or deposit account.*

---

I put $100 behind my agent. It bought a $29 dataset at an ordinary online
checkout, got visibly DECLINED trying $400 at a gift-card merchant, then paid
another agent $5 for a summary — one feed, one receipt chain, and at no point
did the card number exist anywhere my agent could read it.

That's the new thing in agentmoney v0.14: a **reserved card**. Here's the
model, because the model is the product:

**1. The mandate is the boundary, not the model's judgment.** I signed one
spend mandate: up to $100, $40 per purchase, ask me above $60, unseen
merchants throttled to $15. It lives in Postgres, outside any model context.
Injected text can ask; it cannot widen anything.

**2. Issuing reserves, spending clears.** When the agent asks for a card for
`mock-shop.example` capped at $29, the full $29 is reserved from its funds
before the card works — the mandate's authority is consumed up front, so a
runaway card can never spend more than what was already set aside. Close the
card and the unspent remainder returns; the mandate authority does not. No
surprise bills, by arithmetic.

**3. Every swipe is answered by the policy engine, live.** The card network
asks us, synchronously, on every authorization. Our answer is a fixed decline
ladder: is the card active, is the mandate alive, right merchant category,
right merchant, single-use not yet used, first-time-merchant throttle, cap.
The $400 gift-card attempt died on the first-merchant throttle in under two
seconds — and the refusal is in the feed with a receipt, next to the
successes. Every other demo in this space shows the purchase working; the
product is the decline.

**4. The agent gets `last4`, never the PAN.** The MCP tools return enough to
recognize the card, nothing that can leak it. If a checkout form needs
filling, the host runtime — not the model — redeems a single-use, ten-minute
checkout token for exactly one reveal, outside the conversation. Default mode
ships with no reveal surface at all. If the issuer ever reported an approval
we didn't decide, a circuit breaker halts all card spend and parks the
evidence.

**5. The same mandate pays agents.** The $5 to @writer-agent didn't touch the
card rail — it's a ledger row, instant and fee-free, under the same mandate,
in the same receipt chain. Cards borrow every merchant on earth as supply;
the closed loop keeps machine-to-machine payments at machine economics.

The whole run is a deterministic script against a Stripe-shaped mock issuer —
`npm run demo:card` in the repo, transcript committed. Test-mode traffic
against the real issuer is next; the wire shapes are already pinned.

Two packages, Apache-2.0, on npm: `@agentmoney/wallet-mcp` (the agent side)
and `@agentmoney/seller-sdk` (the getting-paid side).

The claim I'll defend: agent spending needs standing mandates with policy at
the authorization hop — not approve-every-purchase dialogs, and not raw cards
in prompts. The card is table stakes. The policy plane is the product.

---

## 90-second video storyboard

| t | Shot | On screen |
|---|---|---|
| 0:00–0:10 | Phone, owner surface | The mandate being granted: "up to $100 · $40/purchase · ask me above $60 · new merchants $15". Voiceover: "I set the rules once." |
| 0:10–0:25 | Terminal, agent session | `money_card_create` for $29 at mock-shop.example → `status: active`, `last4` only. Callout: "the agent never sees the number". |
| 0:25–0:40 | Split: mock checkout + terminal | The $29 purchase authorizes in <2 s; clearing lands; receipt id in the feed. |
| 0:40–0:55 | Terminal, big and slow | The $400 gift-card attempt: `DECLINED new_payee_cap` in <2 s. Freeze frame. Voiceover: "this is the product". |
| 0:55–1:10 | Terminal | `money_pay` $5 to `@writer-agent` → instant ledger receipt. "Same mandate, no card rail, machine economics." |
| 1:10–1:30 | Terminal | `money_feed`: purchase, decline, agent payment in one hash-chained feed; `ledger_health: true`. End card: "Reserved cards for agents. Sandbox today. agentmoney." |

Sandbox label stays on screen for the full runtime.
