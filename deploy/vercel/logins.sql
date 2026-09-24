-- Vercel beta profile: the six passworded Supabase logins, one per database
-- identity. Supabase-only. Run as the MIGRATING identity — the login that ran
-- `npm run db:migrate` and `db/roles.sql`, so it owns `money`/`money_private`
-- and holds ADMIN on the authority roles (`postgres` on a fresh project;
-- `money_owner` on the live one, see README "Admin identity") — over the
-- SESSION pooler (port 5432) AFTER both, with every password supplied as a
-- psql variable read from a file — never a literal in this file, never pasted,
-- never through the Supabase MCP tools. The Supabase Data API hardening that
-- used to close this file is data-api.sql, run as `postgres`:
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
--     -v app_pw="$(cat "$SECRETS/app.pw")"         -v worker_pw="$(cat "$SECRETS/worker.pw")" \
--     -v ingress_pw="$(cat "$SECRETS/ingress.pw")" -v ops_pw="$(cat "$SECRETS/ops.pw")" \
--     -v metrics_pw="$(cat "$SECRETS/metrics.pw")" -v backup_pw="$(cat "$SECRETS/backup.pw")" \
--     -f deploy/vercel/logins.sql
--
-- No \echo anywhere: psql must never print an interpolated value. Idempotent
-- and re-runnable; re-running with fresh variables rotates every password.
--
-- Pooler username shape: Supavisor identifies the tenant from the username, so
-- every connection string names the user as `<login>.<project-ref>`, e.g.
--   postgresql://money_app_login.<ref>:<pw>@aws-0-us-east-1.pooler.supabase.com:6543/postgres
-- Runtime pools use the TRANSACTION pooler (6543); migrations, this file,
-- schedule.sql, verify.sql and backups use the SESSION pooler (5432). Supavisor
-- opens its backend connections AS the login, so the role-level guards below
-- apply to every pooled backend.

-- ---------------------------------------------------------------------------
-- 1. Logins exist (psql variables cannot be read inside a dollar-quoted block,
--    so creation and password assignment are separate statements).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'money_app_login') then
    create role money_app_login login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_worker_login') then
    create role money_worker_login login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_card_ingress_login') then
    create role money_card_ingress_login login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_ops_login') then
    create role money_ops_login login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_metrics_login') then
    create role money_metrics_login login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_backup_login') then
    create role money_backup_login login;
  end if;
end $$;

alter role money_app_login with login password :'app_pw';
alter role money_worker_login with login password :'worker_pw';
alter role money_card_ingress_login with login password :'ingress_pw';
alter role money_ops_login with login password :'ops_pw';
alter role money_metrics_login with login password :'metrics_pw';
alter role money_backup_login with login password :'backup_pw';

-- ---------------------------------------------------------------------------
-- 2. Each login inherits exactly one nologin authority role from db/roles.sql.
--    money_backup_login gets direct, schema-scoped SELECT grants below and no
--    authority role at all.
-- ---------------------------------------------------------------------------
grant money_app to money_app_login;
grant money_worker to money_worker_login;
grant money_card_ingress to money_card_ingress_login;
grant money_ops to money_ops_login;
grant money_metrics to money_metrics_login;

-- ---------------------------------------------------------------------------
-- 3. Role-level guards that survive transaction pooling. The pools set the
--    same statement timeouts per transaction; these cap them from the server
--    side, and the connection limits bound the pooler's backend count per
--    identity (six identities against max_connections = 60 on Free).
-- ---------------------------------------------------------------------------
alter role money_app_login set statement_timeout = '5s';
alter role money_app_login connection limit 20;
alter role money_worker_login set statement_timeout = '30s';
alter role money_worker_login connection limit 6;
alter role money_card_ingress_login set statement_timeout = '2s';
alter role money_card_ingress_login connection limit 6;
alter role money_ops_login set statement_timeout = '50s';
alter role money_ops_login connection limit 2;
alter role money_metrics_login set statement_timeout = '10s';
alter role money_metrics_login connection limit 4;
-- pg_dump of a growing journal must not be cut off: no statement timeout.
alter role money_backup_login connection limit 2;

-- ---------------------------------------------------------------------------
-- 4. Backup login: least privilege, schema-scoped, deliberately NOT a member
--    of the predefined read-everything role. It can read every table and
--    sequence in `money` (and whatever the migrating identity creates there
--    later — hence `for role current_user` below), the
--    function definitions in `money_private` via the catalogs, and nothing
--    else: never `cron.job`, `vault.*`, `auth.*`, or `net._http_response`.
-- ---------------------------------------------------------------------------
grant usage on schema money, money_private to money_backup_login;
grant select on all tables in schema money to money_backup_login;
grant select on all sequences in schema money to money_backup_login;
alter default privileges for role current_user in schema money
  grant select on tables to money_backup_login;
alter default privileges for role current_user in schema money
  grant select on sequences to money_backup_login;

-- money.beta_waitlist (migration 0014) has row-level security enabled with no
-- policies, so only its owner reads it. pg_dump sets row_security = off and
-- refuses such a table for any non-owner lacking the bypass-RLS attribute,
-- which only a real superuser can grant and Supabase's `postgres` is not. The backup
-- therefore runs `pg_dump --enable-row-security`, and this policy — the only
-- policy on the table, scoped to the backup login alone — makes every row
-- visible to it under row_security = on. anon/authenticated/service_role and
-- every money_* role hold no SELECT on the table, so the policy widens nothing
-- for them. The dump carries the policy: a restore target must create the
-- money_backup_login role (nologin is enough) BEFORE pg_restore, as the drill
-- does.
do $$
begin
  if to_regclass('money.beta_waitlist') is null then
    raise exception 'money.beta_waitlist is missing: run npm run db:migrate (0014) before logins.sql';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'money' and tablename = 'beta_waitlist'
      and policyname = 'beta_waitlist_backup_read'
  ) then
    create policy beta_waitlist_backup_read on money.beta_waitlist
      for select to money_backup_login using (true);
  end if;
end $$;
