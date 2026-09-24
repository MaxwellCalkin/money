-- Hosted-beta waitlist. The landing page collects one email (plus an optional
-- note) from people who want an invite. The table lives in `money` and is
-- reachable only through money_private.join_waitlist: the product role holds
-- EXECUTE on the function and nothing on the table, so a compromised web
-- process can append a validated address but can never enumerate the list.
-- Validation happens inside the function BEFORE the insert so no constraint
-- can ever fire on user input (constraint errors echo the offending value).
-- A shared database-side cap bounds the table whatever the HTTP layer does;
-- it is a silent no-op so the caller cannot distinguish "capped" from "new"
-- from "already listed" (no enumeration, no oracle).

create table money.beta_waitlist (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  email text not null,
  email_normalized text not null unique,
  note text,
  source text not null default 'landing',
  created_at timestamptz not null default pg_catalog.now(),
  constraint beta_waitlist_email_length check (pg_catalog.char_length(email) <= 254),
  constraint beta_waitlist_note_length check (note is null or pg_catalog.char_length(note) <= 500)
);

create index beta_waitlist_created_at_idx on money.beta_waitlist (created_at);

-- No policies: the owner (the migration role) bypasses RLS, every other role
-- sees nothing even if a table grant ever leaks.
alter table money.beta_waitlist enable row level security;
revoke all on table money.beta_waitlist from public;

create or replace function money_private.join_waitlist(p_email text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := pg_catalog.btrim(p_email);
  v_note text;
begin
  -- validate BEFORE the insert so no constraint can ever fire on user input
  if v_email is null
     or pg_catalog.char_length(v_email) not between 1 and 254
     or v_email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$' then
    raise exception 'invalid email' using errcode = '22023';
  end if;
  v_note := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  if v_note is not null and pg_catalog.char_length(v_note) > 500 then
    raise exception 'invalid note' using errcode = '22023';
  end if;
  -- shared, database-side cap (the HTTP bucket is per instance): a silent
  -- no-op keeps the 202/no-enumeration contract intact
  if (select pg_catalog.count(*) from money.beta_waitlist
        where created_at > pg_catalog.now() - interval '1 hour') >= 300
     or (select pg_catalog.count(*) from money.beta_waitlist) >= 20000 then
    return;
  end if;
  insert into money.beta_waitlist (email, email_normalized, note)
  values (v_email, pg_catalog.lower(v_email), v_note)
  on conflict (email_normalized) do nothing;
end
$$;

revoke all on function money_private.join_waitlist(text, text) from public;
