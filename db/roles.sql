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
grant select on money.schema_migrations, money.accounts, money.assets, money.services to money_app;
revoke execute on function money_private.register_account(text, text, text, text, text, text)
  from money_app;
grant execute on function money_private.post_owner_allocation(text, text, text, text, bigint, text, jsonb)
  to money_app;
grant execute on function money_private.register_public_identity(text, text, text, text, text, text, text),
  money_private.consume_signed_request(text, text, text, text, bigint, bytea),
  money_private.rotate_public_key(text, text, text),
  money_private.create_owner_session(text, bytea),
  money_private.resolve_owner_session(bytea),
  money_private.revoke_owner_session(text, bytea),
  money_private.resolve_public_account(text),
  money_private.account_state(text, text),
  money_private.list_services_for_requester(text),
  money_private.list_public_services(integer, timestamptz, uuid),
  money_private.get_public_service(text),
  money_private.register_service(text, text, text, text, text, text, bigint, text),
  money_private.set_service_active(text, uuid, boolean),
  money_private.create_service_challenge(text, uuid),
  money_private.request_challenge_payment(text, uuid),
  money_private.redeem_service_challenge(text, uuid, uuid, uuid),
  money_private.issue_refund(text, uuid, bigint, text, text),
  money_private.get_marketplace_challenges(text, uuid[]),
  money_private.payment_feed(text, integer),
  money_private.get_receipt(text, uuid)
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

grant usage on schema money, money_private to money_ops;
grant select on money.schema_migrations, money.accounts, money.assets,
  money.balances, money.transfers, money.ledger_entries, money.receipts,
  money.mandates, money.approvals, money.transfer_authorizations,
  money.services, money.challenges, money.external_payments,
  money.signed_request_nonces, money.owner_sessions
  to money_ops;
grant execute on function money_private.ledger_health() to money_ops;
