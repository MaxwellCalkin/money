-- Part 2 of deploy/vercel/setup.sql: pgcrypto compatibility shims.
--
-- On Supabase pgcrypto is preinstalled in the `extensions` schema, so the
-- migrations' `public.digest(...)` (42 call sites across 0001-0013) and
-- `public.gen_random_uuid()` (five table defaults in 0008) do not resolve.
-- PGlite in the test suite has pgcrypto in `public`, so the migrations stay
-- untouched and this file supplies the missing names as thin wrappers.
-- Guarded, idempotent, re-runnable.
--
-- Deliberately NOT relocating pgcrypto into `public` (`alter extension ... set schema`): Supabase's own
-- schemas reference `extensions.*`, and `postgres` does not own the extension.
--
-- The wrappers keep PostgreSQL's default EXECUTE for PUBLIC: they are pure
-- hash/uuid functions carrying no data, not every trigger function in
-- 0001/0005/0006/0012 is SECURITY DEFINER, and the Data API exposure of `public`
-- is closed elsewhere (deploy/vercel/logins.sql plus removing `public` from the
-- exposed schemas in the dashboard), not by locking these down.
--
-- The restore drill replays exactly this file after
-- `create extension pgcrypto with schema extensions` in a vanilla container.
do $$
begin
  if to_regprocedure('public.digest(bytea,text)') is null
     and to_regprocedure('extensions.digest(bytea,text)') is not null then
    create function public.digest(bytea, text) returns bytea
      language sql immutable strict parallel safe
      set search_path = ''
      as 'select extensions.digest($1, $2)';
  end if;
  if to_regprocedure('public.digest(text,text)') is null
     and to_regprocedure('extensions.digest(text,text)') is not null then
    create function public.digest(text, text) returns bytea
      language sql immutable strict parallel safe
      set search_path = ''
      as 'select extensions.digest($1, $2)';
  end if;
  if to_regprocedure('public.gen_random_uuid()') is null then
    create function public.gen_random_uuid() returns uuid
      language sql volatile parallel safe
      set search_path = ''
      as 'select pg_catalog.gen_random_uuid()';
  end if;
end $$;
