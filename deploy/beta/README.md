# Hosted beta profile ($0, single VM)

The invite-only, testnet-labeled pilot deployment from `docs/GOTOMARKET.md`
M1. This is deliberately NOT the production contract in `deploy/README.md`:
the production image refuses to run outside production posture (the baked
`/app/.money-production-image` marker), and production preflight demands
Persona/Column/HSM credentials that a testnet beta does not have. This
profile runs a reduced, honest topology in development posture with its own
image (no marker), invite-gated signup, and dev funding for play-dollars.

**Posture, stated plainly:** single free-tier VM, best-effort uptime, testnet
or hard-capped mainnet money only, no KYC (sandbox tier), invite-only.
Publish exactly this on the status page. Fail-closed still applies: treasury
and compliance routes 503, external x402 stays off until the bridge env is
configured, and every payment still clears the mandate kernel.

## Services (sized for Oracle Always Free: 2 OCPU / 12 GB ARM)

| Service | Why |
|---|---|
| postgres:18 | the money kernel's database (1-2 GB) |
| pgbouncer | transaction pooling on :6432 |
| api (`dist/server/postgres-api.js`) | the signed product API |
| external-worker | x402 sweep/reversal loop |
| database-ops | health probes, reconcile, ledger-health recorder |
| card-authorization (`dist/cards/authorization-server.js`) | issuer webhook ingress on `/webhooks/*` (sandbox: mock issuer, no real card network) |
| card-events (`dist/cards/event-worker.js`) | card event inbox worker + issuer close drain |
| roles (one-shot, postgres image) | applies `db/roles.sql` after migrate and binds `money_metrics_login` (`apply-roles.sh`) |
| public-metrics (`dist/server/metrics.js`) | public wash-proof metrics page + receipt inclusion verifier on `/metrics` and `/receipts`; connects as `money_metrics_login`, a role that can execute exactly two aggregate functions and select from no table — never the owner login, because this is the only internet-reachable service with zero request authentication |
| caddy | TLS on a free DuckDNS subdomain |

Treasury and compliance workers are intentionally absent; their routes fail
closed. Do not add them to this profile — going real-money is a different
milestone with its own gates.

## Reserved cards in the beta (sandbox, no real funds)

The beta runs the card rail with `MONEY_CARD_PROVIDER=mock` and
`MONEY_CARD_REVEAL_MODE=none`: agents can request reserved cards under a
spend mandate and owners see the approvals and receipts, but nothing here is
a bank, card, or deposit account, and no PAN surface exists. Known mock
limitation: the standalone `card-events` worker boots its own empty mock
issuer, so it shares no state with the API's mock issuer. Nothing in the
hosted beta enqueues card events (the mock purchase network lives only in
tests and `npm run demo:card`), so its inbox stays empty; if an event ever
does land there it will fail its issuer re-fetch and dead-letter, tripping
the treasury breaker — fail closed, by design. The full mock authorization
loop is demonstrated by `npm run demo:card` in one process. The services and
the `/webhooks/*` Caddy route exist so the hosted topology matches
production and the flip to Stripe Issuing test mode is an env-file edit, not
a topology change.

## One-time setup

1. **VM**: Oracle Always Free ARM (Ubuntu 24.04), 2 OCPU / 12 GB. Upgrade
   the tenancy to Pay-As-You-Go with a card on file while staying inside
   Always Free shapes — $0 actual spend, exempts you from idle reclamation.
   Open ingress 80/443 only.
2. **DNS**: free subdomain at duckdns.org (e.g. `agentmoney.duckdns.org`);
   put the token in `beta.env` so the refresh cron keeps it pointed here.
3. **Secrets**: `cp beta.env.example beta.env` and fill it. Mint invite codes
   with `openssl rand -base64 18` (one per recruited pilot). Generate the
   external header key per `docs/EXTERNAL_SETTLEMENT.md`.
4. **Provision**: run `./rebuild.sh` as root on the fresh VM. It installs
   Docker, clones the repo, restores the newest backup if one exists in R2,
   and starts the stack. The VM is cattle — rebuilding from scratch plus
   backup restore is the tested recovery path, not a last resort.
5. **Backups**: `backup.sh` does nightly `pg_dump | gzip | age-encrypt` to
   Cloudflare R2 (free 10 GB) via rclone. Install the cron line it prints.
   Run the restore drill once BEFORE inviting pilot #1 — M1's gate requires
   it. The backup cron doubles as legitimate CPU against idle reclamation.
6. **Monitoring**: UptimeRobot (free) on `https://<host>/health/ready` plus
   the database-ops `/health/ready` via the Caddy `/ops-health` route.

## Bridge posture

Start with Base Sepolia (`MONEY_EVM_RPC_URLS` pointing at the free public
RPC) to shake the loop out, then flip to mainnet-behind-hard-caps per
GOTOMARKET M1: fund the beta signer key with the founder's ~$15 USDC float,
keep `EXTERNAL_TX_CAP` at its $10/tx default, and never hold more float than
you are willing to lose. The beta signer key is `MONEY_EVM_PRIVATE_KEY`
(LocalEvmSigner, allowed outside production posture) — treat `beta.env` as
secret material, `chmod 600`, never in git.

## Day-2

- Logs: `docker compose -f compose.beta.yaml logs -f api`
- Reconcile: `curl -H "Authorization: Bearer $MONEY_OPS_TOKEN" https://<host>/ops-reconcile`
- New pilot: append an invite code to `MONEY_SIGNUP_INVITES` in `beta.env`,
  `docker compose -f compose.beta.yaml up -d api` to reload, DM the code.
- Rebuild from nothing: fresh VM → `rebuild.sh` → restore prompt → done.
