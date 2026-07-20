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
  if not exists (select 1 from pg_roles where rolname = 'money_key_rotation') then
    create role money_key_rotation nologin;
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
  money_private.prepare_external_payment(uuid, text, text, text, text, text, text, text, text, bigint, smallint, jsonb),
  money_private.activate_external_payment(text, uuid, bytea, bytea, text, timestamptz, timestamptz),
  money_private.resolve_external_approval_v2(text, uuid, text, text, bytea, bytea, text, timestamptz, timestamptz),
  money_private.confirm_external_payment(text, uuid, text),
  money_private.list_external_payments_for_requester(text, integer),
  money_private.get_external_payment_secret(text, uuid),
  money_private.get_external_payment_secret_by_key(text, text),
  money_private.get_external_payment_by_approval_for_owner(text, uuid),
  money_private.get_unresolved_external_payment_by_resource(text, text),
  money_private.is_external_approval(text, uuid),
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

grant usage on schema money, money_private to money_worker;
grant select, update on money.outbox_events to money_worker;
grant execute on function money_private.sweep_external_payments(integer) to money_worker;

-- Re-encryption is isolated from the application, treasury, and worker. This
-- role can replace ciphertext only when the caller supplies the unchanged
-- plaintext hash; it cannot read balances or move funds.
grant usage on schema money_private to money_key_rotation;
grant execute on function
  money_private.list_external_authorizations_for_rotation(text, integer),
  money_private.replace_external_authorization_ciphertext(uuid, bytea, bytea, text)
  to money_key_rotation;

grant usage on schema money, money_private to money_ops;
grant select on money.schema_migrations, money.accounts, money.assets,
  money.balances, money.transfers, money.ledger_entries, money.receipts,
  money.mandates, money.approvals, money.transfer_authorizations,
  money.services, money.challenges, money.external_payments,
  money.signed_request_nonces, money.owner_sessions
  to money_ops;
grant execute on function money_private.ledger_health() to money_ops;
