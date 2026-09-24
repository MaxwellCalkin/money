-- Vercel beta profile: Supabase Data API hardening. Supabase-only. Run as
-- `postgres` over the SESSION pooler AFTER logins.sql. It alters `postgres`'s
-- OWN default privileges, which only `postgres` (or a member of it) may do —
-- so it cannot live in logins.sql, which runs as the migrating identity
-- (`money_owner` on the live project). No variables and no secrets: psql or
-- the Supabase MCP `execute_sql` both work.
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f deploy/vercel/data-api.sql
--
-- Idempotent and re-runnable. A REVOKE of a grant `postgres` did not make is a
-- warning, not an error (grants held from supabase_admin stay; the dashboard
-- step below is the lock for those).
--
-- Supabase's default privileges hand anon, authenticated and service_role full
-- access to anything `postgres` creates in `public`; the pgcrypto shims live
-- there. Close the defaults, strip what already exists, and make sure the API
-- roles cannot even enter the money schemas. Guarded so the file also runs on a
-- database without those roles. The dashboard step "remove `public` from the
-- exposed schemas" (deploy/vercel/README.md) is the second lock.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    alter default privileges for role postgres in schema public
      revoke all on tables from anon, authenticated, service_role;
    alter default privileges for role postgres in schema public
      revoke execute on functions from anon, authenticated, service_role;
    alter default privileges for role postgres in schema public
      revoke all on sequences from anon, authenticated, service_role;
    revoke all on all tables in schema public from anon, authenticated, service_role;
    revoke all on all functions in schema public from anon, authenticated, service_role;
    revoke all on all sequences in schema public from anon, authenticated, service_role;
    revoke usage on schema money, money_private from anon, authenticated, service_role;
  end if;
end $$;
