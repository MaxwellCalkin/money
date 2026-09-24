# Hosted beta profile: Vercel + Supabase (serverless, $0)

The live hosted beta from `docs/GOTOMARKET.md` M1 (status paragraph dated
2026-09-11). It supersedes the single-VM profile in `deploy/beta/` (kept as a
pointer) and is deliberately NOT the production contract in `deploy/README.md`:
no production preflight, no treasury or compliance processes (their routes fail
closed), no real rail, no real card program, no chain.

**Posture, stated plainly** — verbatim here, in `README.md` ("Hosted beta"),
and on the landing page:

> Single serverless beta (Vercel + Supabase), best-effort uptime, sandbox money only: play dollars via dev funding, mock card issuer, invite-only, no KYC, x402 bridge off (routes fail closed). Owner-app one-tap writes are session-authenticated for play dollars only. Nothing here is a bank, card, or deposit account.

Every reserved-card surface stays sandbox-labeled ("sandbox, no real funds");
`npm run lint:vocabulary` scans this file with the rest of the owner-facing
copy.

Files in this directory:

| File | Runs as | Purpose |
|---|---|---|
| `setup.sql` (`\ir setup-extensions.sql` + `\ir setup-shim.sql`) | `postgres`, before `npm run db:migrate` | pg_cron + pg_net, and the `public.digest`/`public.gen_random_uuid` shims over pgcrypto in `extensions` (the restore drill replays only `setup-shim.sql`) |
| `logins.sql` | the migrating identity (`postgres`; `money_owner` on the live project), after `db/roles.sql` | the six passworded logins (psql variables `app_pw`, `worker_pw`, `ingress_pw`, `ops_pw`, `metrics_pw`, `backup_pw`), role-level statement timeouts and connection limits, backup grants |
| `data-api.sql` | `postgres`, after `logins.sql` (no secrets: the Supabase MCP `execute_sql` is fine) | Supabase Data API hardening: `postgres`'s default grants in `public` closed for anon/authenticated/service_role, existing ones stripped, the API roles kept out of `money`/`money_private` |
| `schedule.sql` | `postgres`, in the `postgres` database | the sweep key into Vault (`sweep_key`), the beta origin (`beta_origin`), `beta_cron.call_internal`, three `cron.schedule` jobs |
| `verify.sql` | `postgres`, read-only | 27 labelled boolean checks: shims, `anon` isolation, backup-login isolation, role matrix, head `0014`, cron jobs, Vault key, `ledger_health()` |

## Topology

| Piece | What it is |
|---|---|
| Vercel project `agentmoney` (main) | `static/index.html` (the landing page) plus ONE Node function `api` built from `src/deploy/vercel-entry.ts` → `src/deploy/vercel-beta.ts`: `POST /waitlist`, the card webhook ingress on `/webhooks/*`, the pg_cron-driven `POST /internal/sweep` and `POST /internal/ledger-health`, an authority-checked `GET /health/ready`, and the signed product API (`/health/live`, `/dashboard`, `/users`, ...) for everything else |
| Vercel project `agentmoney-metrics` | ONE Node function `api` from `src/deploy/vercel-metrics-entry.ts` → `src/deploy/vercel-metrics.ts`: `/`, `/metrics`, `/metrics.json`, `/receipts/:id/verify`, `/health/live`. It holds only the `money_metrics` login and the TLS/posture variables; the main project's `config.json` rewrites `/metrics(.*)` and `/receipts/(.*)` to it, so the public origin is unchanged while the zero-auth code shares no `process.env` with any money-moving identity (`docs/METRICS.md`, "Deployment contract") |
| Supabase project (Postgres 17, `us-east-1`, Free) | one database; six passworded logins, each inheriting one nologin authority role from `db/roles.sql` (`logins.sql`). Runtime pools use the Supavisor TRANSACTION pooler (port 6543) as `<login>.<project-ref>@aws-0-us-east-1.pooler.supabase.com`; migrations, roles, logins, schedule, verify and backups use the SESSION pooler (port 5432; the direct host is IPv6-only on Free) |
| pg_cron → pg_net → `/internal/*` | `schedule.sql`: `beta_cron.call_internal('sweep')` every 5 minutes and `('ledger-health')` at minute 7 of every hour, posted through pg_net with the key read from Supabase Vault (`money_sweep_key`) at execution time — never stored in `cron.job`; a weekly `cron.job_run_details` cleanup |
| GitHub Actions | `.github/workflows/beta-backup.yml`: nightly schema-scoped (`money`, `money_private`), age-encrypted `pg_dump` kept 30 days as the artifact `beta-backup`. `.github/workflows/beta-restore-drill.yml`: monthly restore of the newest backup into a digest-pinned `postgres:17` container with `db/roles.sql` replay, `npm run db:reconcile`, `ledger_health()`, head-migration and counts-only checks — its passing run is the M1 restore-drill evidence |

Build: `vercel.json` (`framework: null`, `npm ci --no-audit --no-fund`,
`node scripts/build-vercel.mjs`, an `ignoreCommand` that cancels every
non-production build, `git.deploymentEnabled` `{main:true,"*":false,"**":false}`)
and the Build Output API — one `nodejs24.x` function in `iad1`, `maxDuration`
60 s, `shouldAddHelpers: false` so raw bodies reach the webhook HMAC and the
signed-body hash untouched. Previews never build; every env value is
Production-only, so even a stray preview boots fail-closed (503 `boot_failed`).

**Per-instance vs database-resident state.** Per-instance state is limited to
the waitlist token bucket, the `/health/ready` authority-probe cache, and the
mock card issuer inside the product API. Nonces
(`money_private.consume_signed_request`, a 2-minute window on the database
clock), idempotency keys, owner sessions, approvals, and the ledger are
database-resident, so replay protection and exactly-once hold across instances
and through the transaction pooler (the code uses transaction-local settings,
transaction-level advisory locks, no `LISTEN/NOTIFY`, no named prepared
statements — keep it so). The pool count is bounded by the role-level
connection limits in `logins.sql`.

**Drift guard.** Both functions refuse to boot unless `MONEY_POSTURE=sandbox-beta`,
`NODE_ENV` is unset or `development`, `MONEY_DB_SSL=verify-full` with a CA in
`MONEY_DB_SSL_CA`, and no forbidden name is present (list under the env table).
The main function additionally requires `MONEY_CARD_PROVIDER=mock`, a reveal
mode of `none`, `MONEY_ALLOW_DEV_FUNDING=true`, at least one invite code, the
webhook secrets and endpoint id; the metrics function refuses
`MONEY_METRICS_SANDBOX_LABEL=false`. A refused boot answers 503 `boot_failed`
on every request and logs the reason once — the reason names a variable, never
a value. An env edit therefore cannot nudge this beta toward real-money
configuration; a real issuer or a real rail is a new spec, not an env change.

**Admin identity on the live project.** The 2026-09-11 project was set up
without the `postgres` password. `postgres` (the Supabase MCP connection)
created one login, `money_owner` (CREATEROLE), and everything else ran as
`money_owner`: migrations, `db/roles.sql`, `logins.sql`. So `money_owner` owns
`money`/`money_private` and holds ADMIN on every authority role; read its
session-pooler URL wherever the steps below say `$ADMIN_URL` for migrate,
roles, logins, reconcile or dev:approve. `postgres` holds an INHERIT
membership in `money_owner` (granted 2026-09-24), so the no-secret,
postgres-only files (`data-api.sql`, `verify.sql`, and `schedule.sql` minus
its Vault insert) run through the MCP. That day the sweep key reached Vault
without transiting the transcript: a temporary SECURITY DEFINER function,
executable only by `money_owner`, took it as a SELECT argument (not logged
under `log_statement = ddl`), then was dropped. Login passwords went in as
SCRAM verifiers computed client-side, so no plaintext reached the server
log. pgcrypto was relocated into `public` that day, which makes
`setup-shim.sql` a no-op there.

**Live deployment (2026-09-24).** Main project `agentmoney-beta`
(https://agentmoney-beta.vercel.app), metrics project `agentmoney-metrics`
(https://agentmoney-metrics.vercel.app), Supabase ref `wakgyyistxfxolymijco`.
Neither Vercel project is connected to Git yet, so step 12's "merge to `main`"
does not deploy. Deploys are prebuilt from a clean checkout of `main` with the
CLI (`.vercel/project.json` pointing at the project):
`MONEY_VERCEL_ENTRY=metrics node scripts/build-vercel.mjs` (metrics) or
`MONEY_METRICS_ORIGIN=https://agentmoney-metrics.vercel.app node scripts/build-vercel.mjs`
(main), then `vercel deploy --prebuilt --prod`. First verify pass: 25 of 27
`t`, rows 7 and 10 report-only. The first manual sweep and ledger-health
calls answered 200.

## One-time setup

Founder-side steps are marked **(founder)**; the agent runs everything else
from Git Bash on Windows (PowerShell works for the CLI calls too). Three rules
throughout: never run password-bearing SQL through the Supabase MCP
`execute_sql`/`apply_migration` tools (arguments and results are transcript
content), never `vercel env pull`, never paste a URL with credentials into
chat.

1. **(founder) Supabase project.** Organization → New project: region
   `us-east-1`, Postgres 17, Free plan. Check the free-project slot first —
   one project in the account is already INACTIVE/paused; restore or delete it
   if the org refuses a second. Note the project ref (`<ref>` below). Save the
   database password ONLY into the secrets directory of step 4
   (`$SECRETS/postgres.pw`); it is used from that file for the admin steps,
   then reset in step 21.
2. **(founder) Vercel projects.** Team "Max Calkin's projects", Hobby. Two
   projects from this repository through the Git integration: `agentmoney` and
   `agentmoney-metrics`. For each: Framework Preset "Other" (`vercel.json`
   pins `framework: null`), Root Directory `.`, Node.js 24.x, Production
   Branch `main`, Deployment Protection ON (Standard Protection: previews and
   generated URLs require Vercel authentication; the production domain stays
   public), Function Region `iad1`. Do not enable Cron Jobs, Web Analytics, or
   Speed Insights — the landing page promises no external requests, and the
   page's CSP forbids them.
3. **(founder) GitHub environment `beta-backup`.** Settings → Environments →
   New environment `beta-backup` → Deployment branches and tags: *Selected
   branches* → `main` only. A workflow file edited on any other branch then
   cannot read its secrets. Also protect `main` (require one review, or use
   Vercel production promotion) before the first stranger onboards:
   production deploys are now `git push origin main` (`docs/THREAT_MODEL.md`,
   "Production deploy triggered without review").
4. **Secrets custody (no-echo).** Generate into files, never to stdout:

   ```bash
   SECRETS="$(cygpath -m "$LOCALAPPDATA")/money-beta-secrets"   # forward slashes (Git Bash); ~/.money-beta-secrets + chmod 700 elsewhere
   mkdir -p "$SECRETS"
   icacls "$(cygpath -w "$SECRETS")" /inheritance:r /grant:r "$USERNAME:F"
   for n in app worker ingress ops metrics backup; do openssl rand -hex 24 > "$SECRETS/$n.pw"; done
   openssl rand -hex 32 > "$SECRETS/sweep.key"
   age-keygen -o "$SECRETS/backup.age"                       # the identity: drill only, never on Vercel
   age-keygen -y "$SECRETS/backup.age" > "$SECRETS/backup.pub"
   printf '["%s"]' "$(openssl rand -base64 24)" > "$SECRETS/webhook-secrets.json"   # 1-4 secrets, 24+ chars each
   printf '["%s"]' "$(openssl rand -base64 18)" > "$SECRETS/invites.json"           # one code per recruited pilot
   ```

   Download the project CA (Supabase → Project Settings → Database → SSL
   configuration → Download certificate) to `$SECRETS/supabase-ca.pem`, and
   put the database password from step 1 into `$SECRETS/postgres.pw`. From
   here on every value is consumed by expansion or stdin only.
5. **Admin URL** (session pooler, the `postgres` login, TLS pinned in the URL):

   ```bash
   REF=<ref>
   ADMIN_URL="postgresql://postgres.$REF:$(cat "$SECRETS/postgres.pw")@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=$SECRETS/supabase-ca.pem"
   ```

   psql, `npm run db:migrate`, `npm run db:reconcile`, and `npm run dev:approve`
   all take this one string. The runtime pools pin TLS through
   `MONEY_DB_SSL=verify-full` + `MONEY_DB_SSL_CA` instead, and the adapter
   strips `sslmode`/`sslrootcert` from THEIR URLs; the CLI tools do not read
   those two variables (only the Vercel composers do), so for admin work the
   pin travels in the URL query, which pg and libpq both honour. Never
   `echo "$ADMIN_URL"`.
6. **`setup.sql` + digest smoke check** (extensions and the pgcrypto shims;
   before migrating):

   ```bash
   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f deploy/vercel/setup.sql
   psql "$ADMIN_URL" -At -c "select encode(public.digest('x','sha256'),'hex')"   # a 64-hex hash, not an error
   ```

7. **Migrate** (from Windows too; the head must come out as `0014`):

   ```bash
   DATABASE_URL="$ADMIN_URL" npm run db:migrate
   ```

8. **Roles, then logins, then the Data API lock.** `db/roles.sql` creates the
   nologin authority roles and the convergent grants; `logins.sql` binds the
   six passworded logins, the role-level statement timeouts and connection
   limits, and the backup grants; `data-api.sql` (as `postgres`) closes the
   Supabase Data API defaults:

   ```bash
   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f db/roles.sql
   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
     -v app_pw="$(cat "$SECRETS/app.pw")"         -v worker_pw="$(cat "$SECRETS/worker.pw")" \
     -v ingress_pw="$(cat "$SECRETS/ingress.pw")" -v ops_pw="$(cat "$SECRETS/ops.pw")" \
     -v metrics_pw="$(cat "$SECRETS/metrics.pw")" -v backup_pw="$(cat "$SECRETS/backup.pw")" \
     -f deploy/vercel/logins.sql
   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f deploy/vercel/data-api.sql   # as postgres
   ```

9. **First `verify.sql` pass** — every `ok` must read `t` except rows 7 and 10 (report
   only) and, until step 15 has run, rows 23-25 (cron jobs, Vault key,
   origin):

   ```bash
   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f deploy/vercel/verify.sql
   ```

10. **(founder) Dashboard settings.** Project Settings → Data API: remove
    `public` from *Exposed schemas* (or disable the Data API entirely); row 7
    of `verify.sql` then reads `f`. Database → SSL configuration: enable
    *Enforce SSL on incoming connections*. Database → Connection pooling:
    Pool Size `6`, transaction mode (six login roles each get their own
    backend pool against Free's `max_connections = 60`).
11. **Vercel environment variables** — the table below: every value
    Production-only, Sensitive, from stdin. Link the CLI to the main project
    first (`.vercel/` is gitignored):

    ```bash
    vercel link --yes --project agentmoney
    POOL="aws-0-us-east-1.pooler.supabase.com:6543/postgres"
    printf '%s' "postgresql://money_app_login.$REF:$(cat "$SECRETS/app.pw")@$POOL"              | vercel env add DATABASE_URL production --sensitive
    printf '%s' "postgresql://money_worker_login.$REF:$(cat "$SECRETS/worker.pw")@$POOL"        | vercel env add MONEY_WORKER_DATABASE_URL production --sensitive
    printf '%s' "postgresql://money_card_ingress_login.$REF:$(cat "$SECRETS/ingress.pw")@$POOL" | vercel env add MONEY_CARD_INGRESS_DATABASE_URL production --sensitive
    printf '%s' "postgresql://money_ops_login.$REF:$(cat "$SECRETS/ops.pw")@$POOL"              | vercel env add MONEY_OPS_DATABASE_URL production --sensitive
    vercel env add MONEY_DB_SSL_CA production --sensitive < "$SECRETS/supabase-ca.pem"
    vercel env add MONEY_SWEEP_KEY production --sensitive < "$SECRETS/sweep.key"
    vercel env add MONEY_CARD_WEBHOOK_SECRETS production --sensitive < "$SECRETS/webhook-secrets.json"
    vercel env add MONEY_SIGNUP_INVITES production --sensitive < "$SECRETS/invites.json"
    for kv in MONEY_POSTURE=sandbox-beta NODE_ENV=development MONEY_DB_SSL=verify-full PG_POOL_MAX=2 \
              MONEY_ALLOW_DEV_FUNDING=true MONEY_ALLOW_SESSION_OWNER_WRITES=true \
              MONEY_CARD_PROVIDER=mock MONEY_CARD_REVEAL_MODE=none MONEY_CARD_WEBHOOK_ENDPOINT_ID=beta-mock-card-endpoint; do
      printf '%s' "${kv#*=}" | vercel env add "${kv%%=*}" production --sensitive
    done
    ```

    Then the metrics project (relinking the same checkout is fine):

    ```bash
    vercel link --yes --project agentmoney-metrics
    printf '%s' "postgresql://money_metrics_login.$REF:$(cat "$SECRETS/metrics.pw")@$POOL" | vercel env add MONEY_METRICS_DATABASE_URL production --sensitive
    vercel env add MONEY_DB_SSL_CA production --sensitive < "$SECRETS/supabase-ca.pem"
    for kv in MONEY_POSTURE=sandbox-beta NODE_ENV=development MONEY_DB_SSL=verify-full PG_POOL_MAX=2 MONEY_METRICS_SANDBOX_LABEL=true; do
      printf '%s' "${kv#*=}" | vercel env add "${kv%%=*}" production --sensitive
    done
    for e in production preview development; do printf '%s' metrics | vercel env add MONEY_VERCEL_ENTRY "$e"; done   # build-time switch, all environments
    ```

    `MONEY_VERCEL_ENTRY` is the only variable that belongs to all
    environments (it selects the entry at build time; previews never build
    anyway). Leave `MONEY_METRICS_ORIGIN` for step 13. `NODE_ENV=development`
    is set explicitly even though the composers also accept it unset: it is
    what keeps `npm ci` installing the devDependencies (esbuild) at build.
12. **Deploy: merge to `main`.** The Git integration builds both projects
    (`node scripts/build-vercel.mjs`; the metrics project's build sees
    `MONEY_VERCEL_ENTRY=metrics`). A 503 `boot_failed` from either function
    means a variable is missing or forbidden — the function log names it.
13. **Wire the rewrites.** Once `agentmoney-metrics` has its production URL
    (`https://agentmoney-metrics.vercel.app`), on the MAIN project:

    ```bash
    vercel link --yes --project agentmoney
    printf '%s' https://agentmoney-metrics.vercel.app | vercel env add MONEY_METRICS_ORIGIN production --sensitive
    ```

    then redeploy the main project (Deployments → latest Production →
    Redeploy). Until then the build warns and `/metrics*` and `/receipts/*`
    answer 404 from the main function. The value must be a bare `https://`
    origin — no path, no trailing slash — or the build fails.
14. **(founder) Custom domain, optional.** Add it to the MAIN project only;
    every `https://<beta host>` below is that domain or the project's
    `.vercel.app` URL. The metrics project keeps its own `.vercel.app` URL and
    is only ever reached through the rewrite.
15. **`schedule.sql`** (in the `postgres` database over the session pooler:
    the key into Vault, the origin, the three jobs; the same key as
    `MONEY_SWEEP_KEY`):

    ```bash
    psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
      -v sweep_key="$(cat "$SECRETS/sweep.key")" \
      -v beta_origin="https://<beta host>" \
      -f deploy/vercel/schedule.sql
    ```

16. **Second `verify.sql` pass** — now every row except 7 and 10 (report only) must read `t`.
17. **GitHub secrets** (environment `beta-backup`). The backup login uses the
    SESSION pooler and carries no `sslmode`; the workflow supplies
    `PGSSLMODE=verify-full` and `PGSSLROOTCERT` from `BETA_BACKUP_SSL_CA`:

    ```bash
    printf '%s' "postgresql://money_backup_login.$REF:$(cat "$SECRETS/backup.pw")@aws-0-us-east-1.pooler.supabase.com:5432/postgres" > "$SECRETS/backup_url"
    gh secret set BETA_BACKUP_DATABASE_URL  --env beta-backup < "$SECRETS/backup_url"
    gh secret set BETA_BACKUP_SSL_CA        --env beta-backup < "$SECRETS/supabase-ca.pem"
    gh secret set BETA_BACKUP_AGE_RECIPIENT --env beta-backup < "$SECRETS/backup.pub"
    gh secret set BETA_BACKUP_AGE_IDENTITY  --env beta-backup < "$SECRETS/backup.age"
    ```

18. **First backup, then the drill.** Schedules run only from `main`, so the
    first run after merge is manual:

    ```bash
    gh workflow run beta-backup.yml && gh run watch
    gh workflow run beta-restore-drill.yml && gh run watch
    ```

    The drill refuses a backup older than 48 h, so it doubles as the monitor
    that the nightly job keeps running. Its passing run link goes into
    `docs/GOTOMARKET.md` as the M1 restore-drill evidence.
19. **UptimeRobot** (free, 5-minute interval) on
    `https://<beta host>/health/ready`. It is the only independent alert AND
    the activity that keeps the Free database from pausing (Known limits).
20. **Post-deploy smoke tests** — the section below.
21. **(founder) Reset the `postgres` password** in the dashboard; keep it only
    in the founder's password manager and rebuild `ADMIN_URL` from there for
    Day-2 admin work.
22. **Delete the secrets directory** — `rm -rf "$SECRETS"` — once the Vercel
    and GitHub values are confirmed working. Rotate immediately if any value
    was ever visible in a transcript.
23. **Supabase MCP connector**: switch it to read-only / project-scoped or
    disconnect it. It is a standing admin credential whose only audit trail
    is the transcript.

## Environment variables (the ONE canonical table)

Every name below is exact. "Scope" is the Vercel environment the variable is created in; every Vercel value is created Production-only and marked Sensitive, from stdin (see Secrets custody). DB URLs never carry `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, or `ssl` (the adapter strips them anyway; see TLS).

| Name | Where | Value / shape | Notes |
|---|---|---|---|
| `MONEY_POSTURE` | main + metrics (Production) | `sandbox-beta` | Required; composers refuse to boot without it |
| `NODE_ENV` | main + metrics (Production) | `development` | Explicit. Composers throw on `production`. Also keeps `npm ci` installing devDependencies (esbuild) at build |
| `MONEY_VERCEL_ENTRY` | metrics project only (All environments) | `metrics` | Build-time switch read by `scripts/build-vercel.mjs`; unset = main entry |
| `MONEY_METRICS_ORIGIN` | main (Production, build-time) | `https://agentmoney-metrics.vercel.app` | Build-time; `build-vercel.mjs` emits the `/metrics*` and `/receipts/*` rewrites only when set (else it warns and those paths 404 from the main function) |
| `DATABASE_URL` | main | `postgresql://money_app_login.<ref>:<pw>@aws-0-us-east-1.pooler.supabase.com:6543/postgres` | money_app |
| `MONEY_WORKER_DATABASE_URL` | main | same shape, `money_worker_login` | money_worker (sweeps only) |
| `MONEY_CARD_INGRESS_DATABASE_URL` | main | same shape, `money_card_ingress_login` | money_card_ingress (`/webhooks/*`) |
| `MONEY_OPS_DATABASE_URL` | main | same shape, `money_ops_login` | money_ops (`/internal/ledger-health`); new name, this profile only |
| `MONEY_METRICS_DATABASE_URL` | metrics | same shape, `money_metrics_login` | money_metrics |
| `MONEY_DB_SSL` | main + metrics | `verify-full` | Required to be exactly this in both composers; `require` is refused (MITM-tolerant), `off` refused |
| `MONEY_DB_SSL_CA` | main + metrics | PEM of the Supabase project CA (Database settings → SSL configuration → download) | Multiline value; the pooler wildcard `*.pooler.supabase.com` matches `aws-0-us-east-1.pooler.supabase.com`; pg sets SNI/servername from the host automatically |
| `PG_POOL_MAX` | main + metrics | `2` | Passed explicitly per pool too (`PostgresDatabase` only reads the env when the option is undefined) |
| `MONEY_ALLOW_DEV_FUNDING` | main | `true` | Play dollars; required `true` by the composer |
| `MONEY_ALLOW_SESSION_OWNER_WRITES` | main | `true` | Decision: on, so the owner app (allocate/mandates/fund) works in the pilot; stated in the posture line; identity-root routes stay signed |
| `MONEY_SIGNUP_INVITES` | main | JSON array, >= 1 code, one per recruited pilot (`openssl rand -base64 18`) | Composer refuses an empty list (otherwise signup would be open) |
| `MONEY_CARD_PROVIDER` | main | `mock` | Required exactly `mock`; any other value is a different profile |
| `MONEY_CARD_REVEAL_MODE` | main | `none` (or unset) | `token` refused |
| `MONEY_CARD_WEBHOOK_SECRETS` | main | JSON array of 1-4 secrets, 24+ chars | Same contract as deploy/beta |
| `MONEY_CARD_WEBHOOK_ENDPOINT_ID` | main | `beta-mock-card-endpoint` | |
| `MONEY_SWEEP_KEY` | main + Vault | >= 32 chars (`openssl rand -hex 32`) | Shared by `/internal/sweep` and `/internal/ledger-health`; stored once in Supabase Vault as `money_sweep_key` |
| `MONEY_METRICS_SANDBOX_LABEL` | metrics | `true` | The metrics composer forces `sandbox = true` regardless and refuses `false` |
| `MONEY_CARD_AUTH_TTL_SECONDS`, `MONEY_CARD_WEBHOOK_TOLERANCE_SECONDS` | main (optional) | defaults | Existing readers; not required |
| `BETA_BACKUP_DATABASE_URL` | GitHub env `beta-backup` | `postgresql://money_backup_login.<ref>:<pw>@aws-0-us-east-1.pooler.supabase.com:5432/postgres` | Session pooler; no sslmode in the URL (libpq env vars supply TLS) |
| `BETA_BACKUP_SSL_CA` | GitHub env `beta-backup` | same PEM as `MONEY_DB_SSL_CA` | Written to a `umask 077` temp file → `PGSSLROOTCERT`, with `PGSSLMODE=verify-full` |
| `BETA_BACKUP_AGE_RECIPIENT` | GitHub env `beta-backup` | age public key | |
| `BETA_BACKUP_AGE_IDENTITY` | GitHub env `beta-backup` | age private key (drill only) | Generated with `age-keygen -o file`, never echoed |

**Forbidden in the main project** (the composer refuses to boot if any is
present): every segregated-authority name from `src/deploy/preflight.ts`
except `DATABASE_URL`, `MONEY_WORKER_DATABASE_URL`,
`MONEY_CARD_INGRESS_DATABASE_URL`, and `MONEY_CARD_WEBHOOK_SECRETS` — that is
`MONEY_KEY_ROTATION_DATABASE_URL`, `MONEY_TREASURY_ADMIN_DATABASE_URL`,
`MONEY_TREASURY_INGRESS_DATABASE_URL`, `MONEY_TREASURY_WORKER_DATABASE_URL`,
`MONEY_PAYOUT_DATABASE_URL`, `MONEY_RECONCILER_DATABASE_URL`,
`MONEY_COMPLIANCE_ADMIN_DATABASE_URL`, `MONEY_COMPLIANCE_INGRESS_DATABASE_URL`,
`MONEY_COMPLIANCE_WORKER_DATABASE_URL`, `MONEY_COMPLIANCE_ONBOARDING_DATABASE_URL`,
`MONEY_RISK_WORKER_DATABASE_URL`, `MONEY_COMPLIANCE_OPS_DATABASE_URL`,
`MONEY_COMPLIANCE_CONSOLE_DATABASE_URL`, `MONEY_EXTERNAL_HEADER_KEYS`,
`MONEY_EXTERNAL_HEADER_KEY`, `MONEY_COMPLIANCE_SESSION_KEYS`,
`MONEY_COMPLIANCE_PROVIDER_API_KEY`, `MONEY_COMPLIANCE_WEBHOOK_SECRET`,
`MONEY_COMPLIANCE_WEBHOOK_SECRETS`, `MONEY_COLUMN_EVENT_API_KEY`,
`MONEY_COLUMN_PAYOUT_API_KEY`, `MONEY_COLUMN_RECONCILER_API_KEY`,
`MONEY_COLUMN_WEBHOOK_SECRET`, `MONEY_EVM_PRIVATE_KEY`, `MONEY_EVM_RPC_URLS`,
`MONEY_EVM_SIGNER_TOKEN`, `MONEY_TREASURY_EVM_ASSETS`,
`MONEY_CARD_WORKER_DATABASE_URL`, `MONEY_METRICS_DATABASE_URL`,
`MONEY_CARD_ISSUER_API_KEY`, `MONEY_CARD_EVENT_API_KEY`,
`MONEY_CARD_REVEAL_TOKEN_KEY`, `MONEY_OPS_TOKEN`, `MONEY_COMPLIANCE_OPS_TOKEN`,
`MONEY_COMPLIANCE_OPERATOR_KEY`, `MONEY_OWNER_KEY`, `MONEY_OWNER_KEY_FILE`,
`MONEY_AGENT_KEY`, `MONEY_AGENT_KEY_FILE` — plus `MONEY_EXTERNAL_MOCK` and
`MONEY_AUTO_MIGRATE`. **Forbidden in the metrics project:** every
segregated-authority name except `MONEY_METRICS_DATABASE_URL`, plus
`DATABASE_URL`. This is the drift guard: the beta cannot be nudged toward
real-money configuration by an env edit.

Notes on names, so the table and the code never drift:

- Names the code reads that are NOT deployment variables: `MONEY_VERCEL_OUTPUT_DIR`
  (a build-time override of the `.vercel/output` directory that only
  `test/vercel-build.test.ts` sets) and `PG_STATEMENT_TIMEOUT_MS` (a fallback
  in `src/db/postgres.ts` that this profile never reaches — every pool passes
  its statement timeout explicitly: app 5 s, worker 30 s, card ingress 2 s,
  ops 50 s, metrics 10 s, mirrored by the role-level timeouts in `logins.sql`).
- The composers' guard covers the names above; newer names outside that list
  (`MONEY_OPS_DATABASE_URL`, `MONEY_SWEEP_KEY`, `MONEY_SIGNUP_INVITES`,
  `MONEY_CARD_WEBHOOK_ENDPOINT_ID`, `MONEY_ALLOW_DEV_FUNDING`,
  `MONEY_ALLOW_SESSION_OWNER_WRITES`) are simply never created in the metrics
  project — keep it to the five names its column of the table lists plus
  `MONEY_VERCEL_ENTRY` and `MONEY_DB_SSL_CA`.
- The product API's optional readers for rails this profile does not run
  (`MONEY_EVM_SIGNER_URL`, `MONEY_EVM_SIGNER_ADDRESS`,
  `MONEY_EXTERNAL_HEADER_ACTIVE_KEY_ID`, `MONEY_COMPLIANCE_PROVIDER`,
  `MONEY_COMPLIANCE_SESSION_ACTIVE_KEY_ID`) stay unset: their companions are
  forbidden, so setting one alone only produces a boot error.
- The workflow-internal names (`PG_IMAGE`, `PGPASSWORD`, `DRILL_DATABASE_URL`,
  `GH_TOKEN`, `RUN_ID`, `CREATED_AT`, `SCHEMA_HEAD`) are step-scoped plain
  values inside the two workflows, not configuration; the drill hands the
  restored container to `npm run db:reconcile` as `DATABASE_URL`, the same
  name the CLI reads everywhere.

## Day-2

- **New invite / new pilot.** Mint a code (`openssl rand -base64 18 > "$SECRETS/invite-N"`),
  add it to the JSON array, replace the variable
  (`vercel env rm MONEY_SIGNUP_INVITES production` then
  `vercel env add MONEY_SIGNUP_INVITES production --sensitive < file`), and
  redeploy (Deployments → latest Production → Redeploy). Codes are reusable
  and do not expire: keep the list short, one code per pilot, and drop a code
  once its pilot is onboarded. DM the code with the wallet steps from
  `README.md` ("Hosted beta"). The pilot's first
  `npm run onboard -- --invite <code>` registers their owner key and stops at
  the compliance gate with their account id: the kernel refuses funding —
  play dollars included — for an owner without reviewed evidence. Approve
  them with the sandbox-only development approval, run by the founder from
  the admin URL, never from an agent transcript:
  `DATABASE_URL="$ADMIN_URL" npm run dev:approve -- --user usr_…` (refuses
  `NODE_ENV=production`; writes the same deterministic non-PII evidence the
  integration tests use). They resume with
  `npm run onboard -- --user usr_…`, which funds play dollars, allocates,
  signs the mandate, and prints the MCP config. This founder step is inside
  the "stranger onboards in under 10 minutes" loop; measure it.
- **Sweep-key rotation.** New key into a file (`openssl rand -hex 32`), then
  in Vault (`select vault.update_secret((select id from vault.secrets where name = 'money_sweep_key'), :'sweep_key');`
  — the commented rotation line in `schedule.sql`, run with
  `-v sweep_key="$(cat file)"`), then `vercel env rm MONEY_SWEEP_KEY production`,
  `vercel env add MONEY_SWEEP_KEY production --sensitive < file`, redeploy.
  Between the two updates `/internal/*` answers 401 and the next cron tick
  retries; nothing is lost.
- **Reading the sweeps.** `cron.job_run_details` (kept 7 days by the
  `money-cron-gc` job) shows every tick:
  `select jobid, status, return_message, start_time from cron.job_run_details order by start_time desc limit 20;`
  and pg_net keeps the counts JSON the routes answer with for about 6 hours:
  `select id, status_code, content::text from net._http_response order by id desc limit 10;`.
  `money.ledger_health_reports` is the only durable record
  (`select * from money.ledger_health_reports order by verified_at desc limit 5;`):
  Hobby runtime logs live one hour and there is no log drain, so a verdict
  of `false` must be read from the table, not the logs. The function logs
  one JSON line per call with counts only.
- **Pausing / unpausing.** Supabase pauses a Free project after 7 days
  without activity and needs a manual restore from the dashboard; while
  paused every route answers 503 (`database_unavailable` on `/health/ready`)
  and UptimeRobot alerts. Vercel Hobby projects do not pause. To pause the
  beta on purpose: `cron.unschedule` the three jobs (the teardown comment in
  `schedule.sql`) and pause the Supabase project; nothing needs dropping.
- **"Intermittent first-request errors after idle."** Fluid compute pauses
  idle instances, the pooler drops their idle client sessions, and pg's idle
  timers do not fire while paused. Every database call on the sweep and
  ledger-health paths therefore gets exactly one retry on `ECONNRESET`,
  `EPIPE`, SQLSTATE `57P01`, or "Connection terminated unexpectedly", and
  pools close idle clients after 5 s. A second consecutive failure is a real
  outage.

## Known limits, honestly

- **Hobby fair use.** Vercel Hobby is for non-commercial personal use, and
  Vercel may deem a company beta commercial regardless of GMV. The Pro
  trigger is the first dollar of real GMV or a Vercel notice, whichever comes
  first. Fluid compute caps a function at 300 s (this profile uses 60), with
  2 GB / 1 vCPU fixed.
- **Per-instance rate limits are per instance.** The waitlist bucket
  (10/min per `x-real-ip`) protects one instance's connection; the
  database-side cap in `join_waitlist` (300/hour, 20,000 total, silent
  no-op) is the real limit.
- **Cold start 1-2 s** on the first request to a new instance (the bundle
  includes viem). Moot for card authorizations: the issuer is the mock, so no
  external network is ever on the decision path.
- **Free Supabase pauses after 7 days without activity.** The cron loop is
  self-referential — if the function breaks, the database goes quiet and
  pauses a week later. UptimeRobot on `/health/ready` is the independent
  activity and the only alert. No PITR, 500 MB database, 5 GB egress,
  1-day logs.
- **Connection math.** Each main instance can hold up to 8 backend
  connections (4 pools × `PG_POOL_MAX=2`) and each metrics instance 2, opened
  lazily and closed after 5 s idle; the pooler allows 200 client connections
  on Free (about 25 busy main instances before clients queue) and Pool Size 6
  backends per login. The role-level connection limits in `logins.sql` (app
  20, worker 6, card ingress 6, ops 2, metrics 4, backup 2 — 40 of the 60
  `max_connections`) are the hard ceiling; hitting one surfaces as 503s under
  a burst, never as lost data.
- **The mock issuer is per instance.** A card issued on one instance is
  unknown to every other, so the card-event batch and issuer-close drain
  never run here (`/internal/sweep` reports them `skipped`) and only
  `npm run demo:card` exercises the full authorization loop. Reserved cards on
  the hosted beta are a sandbox of the policy path, not of a card network.
- **Sandbox counts on the metrics page are invite-gated, not sybil-proof.**
  One pilot with one code can create many agents; the funding-lineage split
  still labels all of it dev/sandbox.

## Backups and the manual restore path

The nightly `beta-backup` workflow dumps `money` and `money_private` only
(custom format, `--no-owner --no-privileges --enable-row-security`; no
`public` schema — the shims are recreated by `setup.sql`; no extensions), as
`money_backup_login` (schema-scoped SELECT grants, never `pg_read_all_data`;
it cannot read `cron.job`, `vault.*`, `auth.*`, or `net._http_response`),
age-encrypts it, shreds the plaintext, and keeps the artifact `beta-backup`
for 30 days. Anyone can download a public repository's artifacts, hence the
mandatory encryption. The artifact retains waitlist emails and the hashed
session/nonce tables for those 30 days. Public-repo schedules auto-disable
after 60 days without commits.

To restore by hand (what the drill automates):

1. `gh run list -w beta-backup.yml -s success -b main -L 5` and
   `gh run download <run-id> -n beta-backup -D restore/`.
2. `age -d -i <identity file from the founder's password manager> -o restore/beta-backup.dump restore/beta-backup.dump.age`.
3. An empty Postgres 17 target (the drill's digest-pinned `postgres:17.11-bookworm`
   image is the reference client too; a client of a different major cannot
   read the archive). On it, before `pg_restore`:
   `create schema extensions; create extension pgcrypto with schema extensions; create role money_backup_login nologin;`
   then `psql -v ON_ERROR_STOP=1 -f deploy/vercel/setup-shim.sql`. The role must
   exist first because the dump carries the `beta_waitlist_backup_read`
   policy granted to it.
4. `pg_restore -l restore/beta-backup.dump > all.list`,
   `grep -v -E ' (EXTENSION|COMMENT - EXTENSION) ' all.list > filtered.list`,
   `pg_restore --exit-on-error --no-owner --no-privileges -L filtered.list -d "$URL" restore/beta-backup.dump`.
5. `psql -v ON_ERROR_STOP=1 -f db/roles.sql`; `DATABASE_URL="$URL" npm run db:reconcile`
   (exits 1 on any balance mismatch);
   `select zero_sum, receipts_ok from money_private.ledger_health();` must be
   `t, t`; `select max(version) from money.schema_migrations;` must equal
   `ls db/migrations | tail -1 | cut -c1-4`; then `count(*)` per table in
   `money` — counts only, never rows.
6. Restoring INTO a fresh Supabase project (a real disaster): steps 1-2, then
   `setup.sql` (extensions + shims), `create role money_backup_login nologin`,
   `pg_restore` as in step 4 with `$ADMIN_URL`, `db/roles.sql`, `logins.sql`
   with fresh passwords (it turns the backup role into a login), new Vercel
   URLs for every login, `schedule.sql`, `verify.sql`, and the smoke tests.
   Every secret is rotated by construction.

## Rotation note

Every beta login, the sweep key, the webhook secrets, the invite codes, and
the backup age keypair were created by the agent under the custody procedure
above. Rotate all of them — and the Supabase `postgres` password — before any
real-money posture, and immediately if any value was ever visible in a
transcript. Rotation is the procedure in Day-2 for the key, `logins.sql` with
fresh variables for the logins (then new Vercel and GitHub values), and a new
`age-keygen` pair for backups (old artifacts stay readable only with the old
identity until they age out).

## Post-deploy smoke tests

1. Readiness, including the authority probe that proves each pool logged in
   as its own identity (a `42501` after a deploy shows up here within one
   monitor interval):

   ```bash
   curl -sS https://<beta host>/health/ready      # {"ok":true,...}; 503 authority_mismatch names the pool in the function log
   ```

2. Ledger health from the database side:

   ```bash
   psql "$ADMIN_URL" -c "select * from money_private.ledger_health()"   # zero_sum t, receipts_ok t
   ```

3. Signed-GET path fidelity. The signature binds `pathname + search` exactly
   as the client sent them, so any router normalisation (a decoded `%2F`, a
   dropped query string) shows up as 401. With the agent from the onboarding
   run, save this as `.money/smoke-signed-get.ts` (the directory is
   gitignored) and run it:

   ```ts
   import { readFileSync } from "node:fs";
   import { signedHeaders } from "../src/core/identity.ts";
   const api = process.env.MONEY_API!, agent = process.env.MONEY_AGENT_ID!;
   const key = readFileSync(process.env.MONEY_AGENT_KEY_FILE!, "utf8").trim();
   for (const path of ["/agent/state?limit=1", "/agent/approvals/smoke%2Fcheck?x=1"]) {
     const res = await fetch(api + path, { headers: signedHeaders(agent, key, { method: "GET", path, body: "" }, "x-agent-id") });
     console.log(res.status, path);   // 200 for the first; anything but 401 for the second
   }
   ```

   ```bash
   MONEY_API=https://<beta host> MONEY_AGENT_ID=agt_… MONEY_AGENT_KEY_FILE=.money/agent-agt_….key npx tsx .money/smoke-signed-get.ts
   ```

4. The public metrics surface, through the rewrite, sandbox-labelled and
   CDN-cacheable:

   ```bash
   curl -sSD - https://<beta host>/metrics.json | grep -iE '^cache-control|"sandbox"'   # cache-control: public, max-age=60, s-maxage=60 … "sandbox":true
   ```

5. The waitlist, JSON and form paths (the row can be deleted afterwards with
   `delete from money.beta_waitlist where email_normalized = 'smoke@example.com'`):

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' -H 'content-type: application/json' -d '{"email":"smoke@example.com"}' https://<beta host>/waitlist   # 202
   curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' -d 'email=smoke@example.com' https://<beta host>/waitlist                          # 303 …/?waitlist=ok#invite
   ```

## Waitlist data statement

The waitlist stores an email address and an optional note — nothing else, no
source IP, no cookie. Validation runs in TypeScript before any database call
and again inside `money_private.join_waitlist`; a database-side cap
(300/hour, 20,000 total) silently no-ops beyond it; duplicates answer 202
exactly like first joins, so the list cannot be enumerated; the address is
never logged (the only log line is a SQLSTATE code, and the regression test
proves a leaking `detail` never reaches the log). Rows are retained in the
encrypted backup artifact for 30 days. Deletion requests are honoured in the
live table (`delete from money.beta_waitlist where email_normalized = lower('<address>')`)
and age out of backups on the next cycle.
