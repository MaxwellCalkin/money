-- Vercel beta profile: the periodic work, driven from inside the database.
-- pg_cron calls beta_cron.call_internal('sweep') every 5 minutes and
-- ('ledger-health') hourly; call_internal posts through pg_net to the main
-- Vercel project's /internal/* routes with the sweep key fetched from Supabase
-- Vault AT EXECUTION TIME, so cron.job never holds the key and
-- net._http_response holds only the counts JSON the routes answer with.
--
-- Supabase-only. Run as `postgres`, in the `postgres` database (where pg_cron
-- lives), over the SESSION pooler, after the main project is live:
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
--     -v sweep_key="$(cat "$SECRETS/sweep.key")" \
--     -v beta_origin="https://<beta host>" \
--     -f deploy/vercel/schedule.sql
--
-- The same key goes to Vercel as MONEY_SWEEP_KEY (stdin, Sensitive). No \echo
-- anywhere. Idempotent: the Vault insert is guarded, cron.schedule(name, ...)
-- upserts by name, and the settings row is upserted.

-- ---------------------------------------------------------------------------
-- 1. The key lives in Vault, once. Rotation (run with the new value, then
--    update MONEY_SWEEP_KEY on Vercel and redeploy):
--      select vault.update_secret(
--        (select id from vault.secrets where name = 'money_sweep_key'), :'sweep_key');
-- ---------------------------------------------------------------------------
select vault.create_secret(:'sweep_key', 'money_sweep_key')
  where not exists (select 1 from vault.secrets where name = 'money_sweep_key');

-- ---------------------------------------------------------------------------
-- 2. The caller. Its only per-deployment input is the origin, kept in a table
--    rather than in the job command so cron.job stays a constant string.
-- ---------------------------------------------------------------------------
create schema if not exists beta_cron;
revoke all on schema beta_cron from public;

create table if not exists beta_cron.settings (
  key text primary key,
  value text not null
);
revoke all on table beta_cron.settings from public;

insert into beta_cron.settings (key, value) values ('origin', :'beta_origin')
  on conflict (key) do update set value = excluded.value;

-- A bare https origin only: the routes are appended below, and the signed
-- product routes are never called from here.
do $$
declare
  v_origin text;
begin
  select s.value into v_origin from beta_cron.settings s where s.key = 'origin';
  if v_origin is null or v_origin !~ '^https://[a-z0-9.-]+$' then
    raise exception 'beta_origin must be a bare https:// origin: no path, no port, no trailing slash';
  end if;
end $$;

create or replace function beta_cron.call_internal(path text) returns bigint
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url := (select s.value from beta_cron.settings s where s.key = 'origin')
           || '/internal/' || path,
    body := '{}'::jsonb,
    headers := pg_catalog.jsonb_build_object(
      'content-type', 'application/json',
      'x-sweep-key', (select d.decrypted_secret
                        from vault.decrypted_secrets d
                       where d.name = 'money_sweep_key')),
    -- pg_net's 2000 ms default would record every cold-start sweep as a
    -- timeout; the function's maxDuration is 60 s.
    timeout_milliseconds := 55000)
$$;
revoke all on function beta_cron.call_internal(text) from public;

-- ---------------------------------------------------------------------------
-- 3. The schedule. Every 5 minutes is plenty: nothing enqueues card events
--    under the mock issuer and x402 is off, so a sweep mostly expires stale
--    reservations. /internal/ledger-health itself skips when a verdict is
--    younger than 30 minutes, so the hourly call appends at most one row.
--    cron.job_run_details is never cleaned automatically; keep a week.
-- ---------------------------------------------------------------------------
select cron.schedule('money-sweep', '*/5 * * * *',
  $$select beta_cron.call_internal('sweep')$$);
select cron.schedule('money-ledger-health', '7 * * * *',
  $$select beta_cron.call_internal('ledger-health')$$);
select cron.schedule('money-cron-gc', '23 4 * * 0',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);

-- Teardown (pausing the beta without dropping anything):
--   select cron.unschedule('money-sweep');
--   select cron.unschedule('money-ledger-health');
--   select cron.unschedule('money-cron-gc');

-- What was scheduled: names and cadences only.
select jobname, schedule, active from cron.job where jobname like 'money-%' order by jobname;
