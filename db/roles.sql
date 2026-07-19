-- Run once as a database administrator, substituting a managed secret or IAM
-- identity for the login. The application never receives table-write grants;
-- all money movement goes through reviewed SECURITY DEFINER functions.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'money_app') then
    create role money_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_worker') then
    create role money_worker nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_treasury') then
    create role money_treasury nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_ops') then
    create role money_ops nologin;
  end if;
end $$;

revoke all on schema public from public;
revoke all on schema money from public;
revoke all on schema money_private from public;
revoke all on all tables in schema money from public;
revoke all on all functions in schema money_private from public;

grant usage on schema money, money_private to money_app;
grant select on money.accounts, money.assets, money.services to money_app;
grant execute on function money_private.post_owner_allocation(text, text, text, text, bigint, text, jsonb)
  to money_app;
grant execute on function money_private.register_account(text, text, text, text, text, text)
  to money_app;
grant execute on function money_private.grant_mandate(text, text, text, bigint, bigint, bigint, bigint, bigint, text[], timestamptz, text)
  to money_app;
grant execute on function money_private.revoke_mandate(text, uuid)
  to money_app;
grant execute on function money_private.request_agent_payment(text, text, text, text, bigint, text)
  to money_app;
grant execute on function money_private.resolve_approval(text, uuid, text, text)
  to money_app;
grant execute on function money_private.get_mandate(text, uuid),
  money_private.get_approval(text, uuid),
  money_private.list_approvals(text, text, integer),
  money_private.list_mandates(text, integer)
  to money_app;

grant usage on schema money, money_private to money_treasury;
grant select on money.accounts, money.assets, money.balances to money_treasury;
grant execute on function money_private.post_confirmed_funding(text, text, text, bigint, jsonb)
  to money_treasury;

grant usage on schema money to money_worker;
grant select, update on money.outbox_events to money_worker;

grant usage on schema money to money_ops;
grant select on money.schema_migrations, money.accounts, money.assets,
  money.balances, money.transfers, money.ledger_entries, money.receipts,
  money.mandates, money.approvals, money.transfer_authorizations
  to money_ops;
