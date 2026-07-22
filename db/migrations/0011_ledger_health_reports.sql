-- The owner dashboard must report ledger integrity it actually verified, but
-- the product role is deliberately denied money_private.ledger_health(): a
-- global journal probe is an information and denial-of-service channel the
-- role matrix refuses to the request path. Store each verdict instead. The
-- general operations role (which already holds ledger_health) records
-- verdicts on a schedule; the product role reads only the latest stored row —
-- two booleans and a timestamp, never the journal itself.

create table money.ledger_health_reports (
  seq bigint generated always as identity primary key,
  zero_sum boolean not null,
  receipts_ok boolean not null,
  verified_at timestamptz not null default clock_timestamp()
);

create trigger ledger_health_reports_append_only
before update or delete on money.ledger_health_reports
for each row execute function money_private.forbid_immutable_mutation();

create or replace function money_private.record_ledger_health()
returns table (zero_sum boolean, receipts_ok boolean, verified_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  insert into money.ledger_health_reports (zero_sum, receipts_ok)
  select h.zero_sum, h.receipts_ok from money_private.ledger_health() h
  returning zero_sum, receipts_ok, verified_at;
$$;

revoke all on function money_private.record_ledger_health() from public;

create or replace function money_private.latest_ledger_health()
returns table (zero_sum boolean, receipts_ok boolean, verified_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.zero_sum, r.receipts_ok, r.verified_at
  from money.ledger_health_reports r
  order by r.seq desc
  limit 1;
$$;

revoke all on function money_private.latest_ledger_health() from public;
