# README Terminal-Cast Storyboard (asciinema / terminalizer → GIF)

**Asset:** the README hero GIF (docs/GOTOMARKET.md → "Distribution blitz →
README terminal-cast GIF"). Target: ≤35 s loop, 80×24 terminal, readable at
README width. Two casts: the hero GIF for the root README, and a short wallet
cast for `packages/wallet-mcp/README.md`.

## Cast A (hero): `npm run demo` — the whole story, sped up

`npm run demo` (`src/demo.ts`) prints a 10-section narrated run with ✓/✗
lines — it is already a storyboard. Record it once, cut playback to the five
sections that carry the story, speed up the rest.

### Record

```bash
cd C:/Users/mcalk/code/money
npm ci
# ports 4021, 4022, 4023 must be free; the demo wipes data/demo-events.jsonl itself
asciinema rec demo.cast --cols 100 --rows 28 --idle-time-limit 1 \
  --command "npm run demo"
```

(No asciinema on the machine? `npm i -g terminalizer`, then
`terminalizer record demo --command "npm run demo"`; set `cols: 100`,
`rows: 28`, `frameDelay: auto`, `maxIdleTime: 1000` in the generated
`demo.yml`, then `terminalizer render demo -o demo.gif`.)

### Convert

```bash
# agg: the asciinema-official gif generator
agg demo.cast demo.gif --speed 1.6 --font-size 16 --theme monokai
# keep the GIF under ~4 MB for the README; raise --speed or cut rows if over
```

### The lines the GIF must land on (all format strings verified in src/demo.ts;
ids/hashes vary per run)

1. Setup — the mandate:
   `✓ mandates signed: scout "$10 budget, $1/tx, $5/day, ask above $2", writer "$5, $1/tx, $2/day"`
2. Section 3 — machine economy:
   `✓ call 1: 402 → paid $0.02 → 200 "The agentic economy settles in micros."`
   and the fail-closed counters:
   `✗ forged/reused receipt → 402 (challenges are single-use, receipts verified)`
   `✗ unsigned attempt to widen scout's mandate to $1000 → 401 (only the owner's key signs mandates)`
3. Section 4 — injection throttle:
   `✗ $0.50 to unseen payee denied: first payment to unseen payee prv_xxxxxxxx is capped at $0.10 (injection throttle)`
4. **Section 6 — THE REFUSAL (freeze the loop's last second here):**
   `✗ writer $1.50 → denied: $1.50 exceeds the $1.00 per-transaction cap`
5. Section 7 — the books:
   `✓ ledger zero-sum invariant: true`
   `✓ receipt chain (N receipts): intact`
   `✗ tamper one historic amount by a single micro → chain breaks at seq 0`

If the full run is too long even at 1.6×, trim the cast to sections 3–7 with
`asciinema-edit` or by cutting the `.cast` JSON between the section-header
lines (`━━ 3 · Machine economy` … `━━ 8 · Durability`), keeping the final
frame on the section-6 refusal or the section-7 tamper line.

### Embed

```markdown
[![the money demo: an agent pays, then is refused over-cap](docs/demo.gif)](https://asciinema.org/a/<id>)
```

Upload the `.cast` to asciinema.org too (`asciinema upload demo.cast`) so the
GIF links to a play-at-your-own-speed version.

## Cast B (wallet): give an agent a wallet in 30 seconds

For `packages/wallet-mcp/README.md`. One terminal, three commands, no
speed-up. Pre-arrange two terminals recorded as one cast (or comment lines):

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

End card: 2 s of a comment line typed by hand:

```bash
# your agent now has: money_balance · money_pay · money_fetch (402 auto-pay) · money_feed
```

## Rules

- Real runs only — never edit text into a `.cast` file; trim time, not content.
- Re-record rather than patch if a run shows an error frame.
- The GIF must show the refusal line; a cast that only shows successes is the
  competitor's demo, not ours.
