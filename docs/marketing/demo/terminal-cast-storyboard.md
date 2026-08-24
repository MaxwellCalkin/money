# README Terminal-Cast Storyboard (card rail, v0.14)

**Asset:** the README hero cast (docs/GOTOMARKET.md → "The long sequence",
move 2: "launch post and transcript posted in founder voice"). Target: ≤35 s
loop, readable at README width. Three deliverables:

- **Cast 0 (committed, done):** `agent-card-cast.svg` next to this file — a
  hand-authored animated SVG of the five key moments, already embedded in the
  root README's "Your agent never sees the card number" section. Zero tooling,
  zero recording, renders animated inside a GitHub `<img>`. Every line is
  drawn verbatim (trimmed to width) from `agent-card-transcript.md`, and the
  sandbox label is on screen for the full 18 s loop.
- **Cast A (hero GIF):** a real recording of `npm run demo:card`, for the
  launch post and asciinema.
- **Cast B (wallet):** the short cast for `packages/wallet-mcp/README.md`.

## Cast 0 — the committed animated SVG

Nothing to record. If the transcript ever changes (`npm run demo:card` is
byte-deterministic, pinned by `test/demo-card.test.ts`), re-edit the SVG's
`<text>` lines to match the new transcript verbatim — never the other way
around. Constraints the file already satisfies and any edit must keep: pure
`<text>` elements, no scripts, no external fonts (system monospace stack),
no line over 78 characters, well-formed XML, under 40 KB.

## Cast A (hero): `npm run demo:card` — the card story

`npm run demo:card` (`src/demo-card.ts`) is the ideal recording target: one
process, in-process Postgres (PGlite, dev-only), the mock issuer speaking the
Stripe Issuing wire shape — no ports to free, no data files to wipe, and the
output is byte-deterministic, so every take is identical to the committed
transcript in `agent-card-transcript.md`.

### Record

```bash
cd C:/Users/mcalk/code/money
npm ci
asciinema rec demo-card.cast --cols 100 --rows 30 --idle-time-limit 1 \
  --command "npm run demo:card"
```

(No asciinema? `npm i -g terminalizer`, then
`terminalizer record demo-card --command "npm run demo:card"`; set
`cols: 100`, `rows: 30`, `frameDelay: auto`, `maxIdleTime: 1000`, then
`terminalizer render demo-card -o demo-card.gif`.)

### Convert

```bash
agg demo-card.cast demo-card.gif --speed 1.4 --font-size 16 --theme monokai
# keep the GIF under ~4 MB for the README; raise --speed if over
```

### The five lines the GIF must land on (all verbatim in the committed
transcript; the run is deterministic, so they will appear byte-for-byte)

1. The mandate (section 1):
   `✓ spend mandate up to $100.00 signed by the owner:`
   with its sub-lines — `$40.00 per transaction · human approval above
   $60.00`, the $15.00 unseen-merchant cap, the payee allowlist.
2. The approval (section 3):
   `✓ APPROVED · $29.00 at MOCK SHOP EXAMPLE (MCC 5734)`
   plus the `<2 s` decision-latency line.
3. **THE DECLINE (freeze the loop's last second here):**
   `✗ DECLINED · $400.00 at GIFT CARD EMPORIUM (MCC 6051)`
   `✗ decline code: new_payee_cap — in plain words: this owner has never bought`
   through `✗   into $400.00 of gift cards.`
4. The agent-to-agent payment (section 5):
   `✓ @scout paid @writer-agent $5.00 — memo: "product summary: mock-shop.example findings"`
5. The books (section 7):
   `✓ ledger_health: zero-sum true · receipt evidence recomputed from the ledger: true`

The sandbox banner
(`SANDBOX — no real funds; nothing here is a bank, card, or deposit account.`)
prints at both the top and the bottom of the run — do not trim either
occurrence out of the cast.

If the full run is too long even at 1.4×, trim the cast between the section
headers (`━━ 2 ·` … `━━ 6 ·`), keeping sections 1, 3, 4, 5, and 7 whole and
the final frame on the section-4 decline or the section-7 `ledger_health`
line.

### Embed

```markdown
[![the card demo: a $29 purchase approved, $400 of gift cards declined](docs/demo-card.gif)](https://asciinema.org/a/<id>)
```

Upload the `.cast` to asciinema.org too (`asciinema upload demo-card.cast`)
so the GIF links to a play-at-your-own-speed version.

## Cast B (wallet): give an agent a wallet in 30 seconds

For `packages/wallet-mcp/README.md`. One terminal, three commands, no
speed-up:

```bash
asciinema rec wallet.cast --cols 100 --rows 28 --idle-time-limit 2
# inside the recording:
npm run api &          # money network listening on http://127.0.0.1:4021 ...
npm run onboard        # ends on the .mcp.json block with "npx -y @agentmoney/wallet-mcp"
exit
```

The two frames that matter (verified verbatim):

```
mandate $10.00 budget · $1/tx · $5/day · ask above $2 · new-payee 10¢
```

```
"args": ["-y", "@agentmoney/wallet-mcp"],
```

End card: 2 s of a comment line typed by hand (the seven tools, matching the
wallet README's table — note the card tools need the Postgres-backed network,
`npm run api:db`, not the JSONL showcase this cast records):

```bash
# your agent now has: money_balance · money_pay · money_fetch (402 auto-pay)
# money_card_create/status/close (last4 only, never the card number) · money_feed
```

## Rules

- Real runs only — never edit text into a `.cast` file; trim time, not
  content. (`demo:card` is deterministic, so there is nothing to patch.)
- Re-record rather than patch if a run shows an error frame.
- The GIF must show the decline. A cast that only shows purchases succeeding
  is the competitor's demo, not ours.
- The sandbox label stays in frame: sandbox, no real funds.
