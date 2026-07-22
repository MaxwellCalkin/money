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
  if not exists (select 1 from pg_roles where rolname = 'money_treasury_worker') then
    create role money_treasury_worker nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_ops') then
    create role money_ops nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_key_rotation') then
    create role money_key_rotation nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_treasury_ingress') then
    create role money_treasury_ingress nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_payout_worker') then
    create role money_payout_worker nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_reconciler') then
    create role money_reconciler nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_compliance_admin') then
    create role money_compliance_admin nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_compliance_worker') then
    create role money_compliance_worker nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_compliance_ingress') then
    create role money_compliance_ingress nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_risk_worker') then
    create role money_risk_worker nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_compliance_ops') then
    create role money_compliance_ops nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_compliance_onboarding') then
    create role money_compliance_onboarding nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'money_compliance_console') then
    create role money_compliance_console nologin;
  end if;
end $$;

revoke all on schema public from public;
revoke all on schema money from public;
revoke all on schema money_private from public;
revoke all on all tables in schema money from public;
revoke all on all functions in schema money_private from public;

-- Converge privileges when this file is reapplied. Without these revokes, a
-- role split can leave an old login holding authority that no longer appears
-- in the current grant list.
revoke all on schema money, money_private from
  money_app, money_worker, money_treasury, money_treasury_worker, money_ops,
  money_key_rotation, money_treasury_ingress, money_payout_worker, money_reconciler,
  money_compliance_admin, money_compliance_worker, money_compliance_ingress,
  money_risk_worker, money_compliance_ops, money_compliance_onboarding,
  money_compliance_console;
revoke all on all tables in schema money from
  money_app, money_worker, money_treasury, money_treasury_worker, money_ops,
  money_key_rotation, money_treasury_ingress, money_payout_worker, money_reconciler,
  money_compliance_admin, money_compliance_worker, money_compliance_ingress,
  money_risk_worker, money_compliance_ops, money_compliance_onboarding,
  money_compliance_console;
revoke all on all functions in schema money_private from
  money_app, money_worker, money_treasury, money_treasury_worker, money_ops,
  money_key_rotation, money_treasury_ingress, money_payout_worker, money_reconciler,
  money_compliance_admin, money_compliance_worker, money_compliance_ingress,
  money_risk_worker, money_compliance_ops, money_compliance_onboarding,
  money_compliance_console;

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
  money_private.get_receipt(text, uuid),
  money_private.latest_ledger_health()
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
grant execute on function
  money_private.request_treasury_payout(text,text,uuid,text,bigint),
  money_private.cancel_treasury_payout(text,uuid),
  money_private.list_treasury_destinations(text),
  money_private.list_treasury_deposit_routes(text),
  money_private.list_treasury_payouts(text,integer),
  money_private.get_treasury_payout(text,uuid),
  money_private.list_treasury_fundings(text,integer),
  money_private.list_treasury_exposures(text,integer),
  money_private.treasury_control_state(),
  money_private.begin_compliance_verification(text,text,text,bigint,bigint),
  money_private.compliance_subject_state(text),
  money_private.request_compliance_verification_session(text,text,text),
  money_private.compliance_verification_session_state(text,uuid)
  to money_app;

-- Product traffic can submit a non-PII onboarding profile and read only its
-- own sanitized status. Approval, screening details, cases, and reasons are
-- deliberately absent from money_app.

grant usage on schema money_private to money_compliance_admin;
grant execute on function
  money_private.open_compliance_case(text,uuid,bigint,text,text,text,text,timestamptz,text,text),
  money_private.restrict_compliance_subject(text,uuid,text,text),
  money_private.register_compliance_counterparty(text,text,text,text,text),
  money_private.record_counterparty_screening(uuid,text,bytea,text,timestamptz,timestamptz),
  money_private.link_treasury_destination_compliance(uuid,uuid,text),
  money_private.register_compliance_operator(text,text,text,text,text,text,text),
  money_private.set_compliance_operator_status(text,text,text,text),
  money_private.compliance_subject_state(text)
  to money_compliance_admin;

-- Provider credentials can append authenticated evidence and counterparty
-- screening decisions. They cannot approve a customer, release a hold, read
-- cases, change limits, or move money.
grant usage on schema money_private to money_compliance_worker;
grant execute on function
  money_private.record_compliance_event_evidence_set(text,bigint,jsonb),
  money_private.claim_compliance_events(text,integer),
  money_private.fail_compliance_event(text,bigint,text,integer,boolean),
  money_private.register_compliance_counterparty(text,text,text,text,text),
  money_private.record_counterparty_screening(uuid,text,bytea,text,timestamptz,timestamptz)
  to money_compliance_worker;

-- Public compliance webhook ingress can enqueue a signed reference and do
-- nothing else: no result reads, customer state, cases, or account changes.
grant usage on schema money_private to money_compliance_ingress;
grant execute on function money_private.enqueue_compliance_event(text,text,text,text,bytea)
  to money_compliance_ingress;

-- Hosted-onboarding provider credentials can claim a non-PII profile and
-- persist only an authenticated provider reference plus encrypted redirect.
-- They cannot read the redirect back, approve a customer, or inspect a case.
grant usage on schema money_private to money_compliance_onboarding;
grant execute on function
  money_private.claim_compliance_verification_sessions(text,integer),
  money_private.complete_compliance_verification_session(text,uuid,text,bytea,bytea,text,timestamptz),
  money_private.fail_compliance_verification_session(text,uuid,text,integer,boolean),
  money_private.expire_compliance_verification_sessions(integer)
  to money_compliance_onboarding;

-- The console login has no table grants. Every read and mutation must present
-- a live hashed operator session to a SECURITY DEFINER command. High-impact
-- commands enforce role and maker/checker separation inside the database.
grant usage on schema money_private to money_compliance_console;
grant execute on function
  money_private.compliance_operator_identity(text),
  money_private.consume_compliance_operator_request(text,text,text,bigint,bytea),
  money_private.create_compliance_operator_session(text,bytea),
  money_private.resolve_compliance_operator_session(bytea),
  money_private.revoke_compliance_operator_session(bytea),
  money_private.list_compliance_cases_for_operator(bytea,integer),
  money_private.list_compliance_subjects_for_operator(bytea,integer),
  money_private.list_compliance_restrictions_for_operator(bytea,integer),
  money_private.list_compliance_action_requests_for_operator(bytea,integer),
  money_private.list_compliance_case_actions_for_operator(bytea,uuid,integer),
  money_private.claim_compliance_case_as_operator(bytea,uuid,text,text,text),
  money_private.add_compliance_case_note_as_operator(bytea,uuid,text,text,text,bytea),
  money_private.restrict_compliance_subject_as_operator(bytea,text,uuid,text,text,text,text),
  money_private.request_compliance_action_as_operator(bytea,text,text,jsonb,text,text,text),
  money_private.approve_compliance_action_as_operator(bytea,uuid,text,text),
  money_private.reject_compliance_action_as_operator(bytea,uuid,text,text)
  to money_compliance_console;

-- Transaction monitoring may create a case and stop an account family but
-- cannot clear evidence, release the restriction, or close the case.
grant usage on schema money_private to money_risk_worker;
grant execute on function
  money_private.sweep_expired_compliance(integer),
  money_private.expire_compliance_verification_sessions(integer),
  money_private.open_compliance_case(text,uuid,bigint,text,text,text,text,timestamptz,text,text),
  money_private.restrict_compliance_subject(text,uuid,text,text)
  to money_risk_worker;

-- Treasury administration registers provider-owned references and controls
-- breakers. It has no provider-event settlement authority.
grant usage on schema money_private to money_treasury;
grant execute on function
  money_private.register_treasury_deposit_route(text,text,text,text),
  money_private.register_treasury_destination(text,text,text,text),
  money_private.set_treasury_destination_status(text,uuid,text),
  money_private.register_treasury_asset_account(text,text,text,text),
  money_private.resolve_treasury_event_review(bigint,text,text,text),
  money_private.resolve_treasury_payout_review(uuid,text,text,text,text),
  money_private.configure_treasury_controls(boolean,boolean,boolean,bigint,bigint,bigint,bigint,text),
  money_private.restore_treasury_controls(text),
  money_private.release_treasury_freeze(text,text),
  money_private.treasury_control_state(),
  money_private.treasury_health()
  to money_treasury;

-- Authenticated provider-event processing may settle exact evidence fetched
-- from Column, but cannot register a route, release a freeze, or reopen a
-- circuit breaker.
grant usage on schema money_private to money_treasury_worker;
grant execute on function
  money_private.enqueue_treasury_provider_event(text,text,text,bytea),
  money_private.claim_treasury_provider_events(text,integer),
  money_private.complete_treasury_provider_event(text,bigint,text),
  money_private.fail_treasury_provider_event(text,bigint,text,integer,boolean),
  money_private.get_treasury_poll_cursor(text),
  money_private.set_treasury_poll_cursor(text,timestamptz),
  money_private.settle_treasury_funding(text,text,text,text,text,text,bigint,timestamptz,bytea,jsonb),
  money_private.return_treasury_funding(text,text,text,text,text,bigint,text,timestamptz,bytea,jsonb),
  money_private.transition_treasury_payout(text,text,text,text,text,text,bigint,timestamptz,bytea,jsonb),
  money_private.trip_treasury_breaker(text)
  to money_treasury_worker;

-- Public webhook process: HMAC verification plus durable enqueue only. It
-- cannot read a destination, balance, provider payload, or move one micro.
grant usage on schema money_private to money_treasury_ingress;
grant execute on function money_private.enqueue_treasury_provider_event(text,text,text,bytea)
  to money_treasury_ingress;

-- Outbound provider credential is isolated from webhook/funding authority.
grant usage on schema money_private to money_payout_worker;
grant execute on function
  money_private.claim_treasury_payouts(text,integer),
  money_private.release_treasury_payout_claim(text,uuid,text,integer),
  money_private.fail_treasury_payout_submission(text,uuid,text),
  money_private.mark_treasury_payout_manual_review(text,uuid,text,text),
  money_private.record_treasury_payout_submission(text,uuid,text,text)
  to money_payout_worker;

-- Read-only provider balance polling can persist observations and trip, but
-- never reopen, a circuit breaker.
grant usage on schema money_private to money_reconciler;
grant execute on function
  money_private.record_treasury_asset_snapshot(text,text,text,bigint,bigint,bigint,bigint,bigint,text,timestamptz),
  money_private.treasury_health(),
  money_private.trip_treasury_breaker(text)
  to money_reconciler;

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
  money.signed_request_nonces, money.owner_sessions,
  money.treasury_controls, money.treasury_control_events, money.treasury_deposit_routes,
  money.treasury_destinations, money.treasury_event_inbox, money.treasury_event_reviews,
  money.treasury_provider_events, money.treasury_fundings,
  money.treasury_exposures, money.treasury_freezes,
  money.treasury_payouts, money.treasury_payout_reviews, money.treasury_asset_accounts,
  money.treasury_asset_snapshots, money.treasury_poll_cursors
  to money_ops;
grant execute on function money_private.ledger_health(), money_private.treasury_health() to money_ops;
-- Ops records ledger-health verdicts; the product role may only read the
-- latest stored verdict (money_private.latest_ledger_health, granted with the
-- other money_app function grants), never run the global probe itself.
grant execute on function money_private.record_ledger_health() to money_ops;

-- Compliance case data is segregated from ordinary financial operations.
-- In particular, product and general ops roles cannot infer regulatory-report
-- status or disclose it to the subject.
grant usage on schema money, money_private to money_compliance_ops;
grant select on money.compliance_subjects, money.compliance_evidence,
  money.compliance_event_inbox, money.compliance_event_evidence,
  money.compliance_counterparties, money.compliance_cases,
  money.compliance_case_actions, money.compliance_restrictions,
  money.compliance_subject_events, money.risk_limits, money.risk_limit_events,
  money.risk_velocity_buckets, money.risk_decisions, money.risk_transfer_links
  to money_compliance_ops;
grant select (id, subject_account_id, provider, state, attempts, requested_at,
  expires_at, updated_at) on money.compliance_verification_sessions to money_compliance_ops;
grant select on money.compliance_operators, money.compliance_operator_events,
  money.compliance_action_requests to money_compliance_ops;
grant execute on function money_private.compliance_subject_state(text)
  to money_compliance_ops;
