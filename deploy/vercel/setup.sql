-- Vercel beta profile: one-time Supabase preparation. Run as `postgres` over the
-- SESSION pooler (port 5432) BEFORE `npm run db:migrate`:
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f deploy/vercel/setup.sql
--
-- Supabase-only and never part of db/migrations: PGlite (the test suite) must
-- never see pg_cron, pg_net, or the `extensions` schema. Split into two files
-- because the restore drill (.github/workflows/beta-restore-drill.yml) replays
-- only the pgcrypto shims against a vanilla postgres:17 container, which has
-- neither pg_cron nor pg_net. Both parts are idempotent and re-runnable.
--
-- Smoke check afterwards, before migrating (a 64-hex hash, not an error):
--   select encode(public.digest('x', 'sha256'), 'hex');
\ir setup-extensions.sql
\ir setup-shim.sql
