-- x402 v2, rotatable authorization encryption, and sign-after-policy activation.
-- Unsigned intents may wait for a human without consuming a short-lived EIP-3009
-- authorization. A signer runs only immediately before the atomic ledger debit.

drop trigger if exists external_payments_protect_transition on money.external_payments;

alter table money.external_payments
  drop constraint if exists external_payments_lifecycle_check,
  drop constraint if exists external_payments_state_check,
  drop constraint if exists external_payments_ciphertext_check,
  drop constraint if exists external_payments_authorization_hash_check,
  drop constraint if exists external_payments_authorization_window_check;

alter table money.external_payments
  alter column payment_header_ciphertext drop not null,
  alter column authorization_hash drop not null,
  alter column authorization_expires_at drop not null,
  alter column reverse_after drop not null,
  add column protocol_version smallint not null default 1,
  add column signing_context jsonb not null default '{}'::jsonb,
  add column authorization_key_id text,
  add column mandate_id uuid references money.mandates(id);

update money.external_payments e set mandate_id = coalesce(
  (select a.mandate_id from money.approvals a where a.id = e.approval_id),
  (select ta.mandate_id from money.transfer_authorizations ta where ta.transfer_seq = e.transfer_seq),
  (select t.mandate_id from money.transfers t where t.seq = e.transfer_seq)
);

-- Old approval secrets may already be too short-lived. Discard them; a fresh
-- signature will be created at approval time under the new command.
update money.external_payments set
  payment_header_ciphertext = null,
  authorization_hash = null,
  authorization_expires_at = null,
  reverse_after = null,
  authorization_key_id = null
where state in ('approval_required', 'cancelled');

update money.external_payments set authorization_key_id = 'legacy'
where state in ('pending', 'confirmed', 'reversed') and authorization_key_id is null;

alter table money.external_payments
  add constraint external_payments_protocol_version_check
    check (protocol_version in (1, 2)),
  add constraint external_payments_signing_context_check check (
    jsonb_typeof(signing_context) = 'object' and pg_column_size(signing_context) <= 8192 and (
      (protocol_version = 1 and signing_context = '{}'::jsonb) or
      (protocol_version = 2 and signing_context ? 'maxTimeoutSeconds' and signing_context ? 'resource')
    )
  ),
  add constraint external_payments_authorization_key_id_check
    check (authorization_key_id is null or authorization_key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  add constraint external_payments_ciphertext_check
    check (payment_header_ciphertext is null or octet_length(payment_header_ciphertext) between 30 and 65536),
  add constraint external_payments_authorization_hash_check
    check (authorization_hash is null or octet_length(authorization_hash) = 32),
  add constraint external_payments_authorization_window_check
    check (
      (authorization_expires_at is null and reverse_after is null) or
      (authorization_expires_at is not null and reverse_after is not null and
       authorization_expires_at <= reverse_after and
       reverse_after <= authorization_expires_at + interval '5 minutes')
    ),
  add constraint external_payments_state_check check (state in (
    'prepared', 'approval_required', 'cancelled', 'pending', 'confirmed', 'reversed'
  )),
  add constraint external_payments_lifecycle_check check (
    (state = 'prepared' and mandate_id is not null and approval_id is null and transfer_seq is null and receipt_id is null and
      payment_header_ciphertext is null and authorization_hash is null and authorization_key_id is null and
      authorization_expires_at is null and reverse_after is null and
      reversal_transfer_seq is null and settled_tx is null) or
    (state in ('approval_required', 'cancelled') and
      (state <> 'approval_required' or mandate_id is not null) and transfer_seq is null and receipt_id is null and
      payment_header_ciphertext is null and authorization_hash is null and authorization_key_id is null and
      authorization_expires_at is null and reverse_after is null and
      reversal_transfer_seq is null and settled_tx is null and
      (state <> 'approval_required' or approval_id is not null)) or
    (state = 'pending' and transfer_seq is not null and receipt_id is not null and
      payment_header_ciphertext is not null and authorization_hash is not null and authorization_key_id is not null and
      authorization_expires_at is not null and reverse_after is not null and
      reversal_transfer_seq is null and settled_tx is null) or
    (state = 'confirmed' and transfer_seq is not null and receipt_id is not null and
      payment_header_ciphertext is not null and authorization_hash is not null and authorization_key_id is not null and
      authorization_expires_at is not null and reverse_after is not null and
      reversal_transfer_seq is null and settled_tx is not null) or
    (state = 'reversed' and transfer_seq is not null and receipt_id is not null and
      payment_header_ciphertext is not null and authorization_hash is not null and authorization_key_id is not null and
      authorization_expires_at is not null and reverse_after is not null and
      reversal_transfer_seq is not null and settled_tx is null)
  );

-- The mandate foreign key is queried by revocation propagation. Keep this
-- partial because only live, activatable intents participate in that path;
-- historical v0.7/v0.8 settlement rows may legitimately have no mandate id.
create index external_payments_live_mandate_idx
  on money.external_payments(mandate_id, state)
  where mandate_id is not null and state in ('prepared', 'approval_required');

create index external_payments_unresolved_resource_idx
  on money.external_payments(agent_id, resource, created_at desc)
  where state in ('prepared', 'approval_required', 'pending');

create or replace function money_private.assert_external_authorization(
  p_ciphertext bytea,
  p_authorization_hash bytea,
  p_key_id text,
  p_authorization_expires_at timestamptz,
  p_reverse_after timestamptz
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_ciphertext is null or octet_length(p_ciphertext) not between 30 and 65536 or
     p_authorization_hash is null or octet_length(p_authorization_hash) <> 32 or
     p_key_id is null or p_key_id !~ '^[A-Za-z0-9._-]{1,64}$' then
    raise exception 'invalid encrypted external authorization' using errcode = '22023';
  end if;
  if p_authorization_expires_at is null or p_authorization_expires_at <= clock_timestamp() or
     p_authorization_expires_at > clock_timestamp() + interval '10 minutes' or
     p_reverse_after < p_authorization_expires_at or
     p_reverse_after > p_authorization_expires_at + interval '5 minutes' then
    raise exception 'invalid external authorization window' using errcode = '22023';
  end if;
end;
$$;

revoke all on function money_private.assert_external_authorization(bytea, bytea, text, timestamptz, timestamptz) from public;

create or replace function money_private.render_external_command(
  p_command_id bigint,
  p_replayed boolean
)
returns table (
  status text,
  replayed boolean,
  external_id uuid,
  external_state text,
  transfer_id uuid,
  receipt_id uuid,
  approval_id uuid,
  denial_code text,
  reason text,
  from_balance_micros bigint,
  to_balance_micros bigint,
  payment_header_ciphertext bytea,
  authorization_hash bytea
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command money.idempotency_keys%rowtype;
  v_external money.external_payments%rowtype;
  v_approval money.approvals%rowtype;
begin
  select k.* into v_command from money.idempotency_keys k where k.id = p_command_id;
  if v_command.id is null or v_command.state <> 'completed' then
    raise exception 'external command is missing or incomplete' using errcode = '40001';
  end if;
  if v_command.result_kind = 'denied' then
    return query select
      'denied', p_replayed, null::uuid, null::text, null::uuid, null::uuid, null::uuid,
      v_command.result->>'denialCode', v_command.result->>'reason',
      nullif(v_command.result->>'fromBalanceMicros', '')::bigint,
      nullif(v_command.result->>'toBalanceMicros', '')::bigint,
      null::bytea, null::bytea;
    return;
  end if;
  if v_command.result_kind <> 'external' then
    raise exception 'external command has unknown result kind %', v_command.result_kind using errcode = 'XX000';
  end if;
  select e.* into v_external from money.external_payments e where e.id::text = v_command.result_id;
  if v_external.id is null then raise exception 'external command references a missing payment' using errcode = 'XX000'; end if;

  if v_external.state = 'prepared' then
    return query select
      'prepared', p_replayed, v_external.id, v_external.state,
      null::uuid, null::uuid, null::uuid, null::text, null::text,
      null::bigint, null::bigint, null::bytea, null::bytea;
    return;
  end if;

  if v_external.state in ('approval_required', 'cancelled') and v_external.approval_id is not null then
    update money.approvals a set
      status = 'expired', resolved_at = clock_timestamp(), reason = 'external payment approval expired'
    where a.id = v_external.approval_id and a.status = 'pending' and a.expires_at <= clock_timestamp();
    select a.* into v_approval from money.approvals a where a.id = v_external.approval_id;
    if v_approval.id is null then raise exception 'external payment approval is missing' using errcode = 'XX000'; end if;
    if v_external.state = 'approval_required' and v_approval.status = 'pending' then
      return query select
        'approval_required', p_replayed, v_external.id, v_external.state,
        null::uuid, null::uuid, v_approval.id, null::text, null::text,
        null::bigint, null::bigint, null::bytea, null::bytea;
      return;
    end if;
    if v_external.state = 'approval_required' then
      update money.external_payments e set state = 'cancelled', updated_at = clock_timestamp()
      where e.id = v_external.id;
      v_external.state := 'cancelled';
    end if;
    return query select
      'denied', p_replayed, v_external.id, v_external.state,
      null::uuid, null::uuid, v_approval.id,
      case v_approval.status when 'expired' then 'approval_expired'
        when 'failed' then 'approval_failed' else 'approval_rejected' end,
      coalesce(v_approval.reason, 'approval ' || v_approval.status),
      null::bigint, null::bigint, null::bytea, null::bytea;
    return;
  end if;

  if v_external.state = 'cancelled' then
    return query select
      'denied', p_replayed, v_external.id, v_external.state,
      null::uuid, null::uuid, null::uuid,
      'permit_invalid', 'external payment intent is no longer activatable',
      null::bigint, null::bigint, null::bytea, null::bytea;
    return;
  end if;
  if v_external.state = 'reversed' then
    return query select
      'denied', p_replayed, v_external.id, v_external.state,
      null::uuid, v_external.receipt_id, v_external.approval_id,
      'permit_invalid', 'external payment was reversed after its confirmation deadline',
      null::bigint, null::bigint, null::bytea, v_external.authorization_hash;
    return;
  end if;

  return query
    select 'posted', p_replayed, v_external.id, v_external.state,
      t.id, r.id, v_external.approval_id, null::text, null::text,
      fb.available_micros, tb.available_micros,
      v_external.payment_header_ciphertext, v_external.authorization_hash
    from money.transfers t
    join money.receipts r on r.transfer_seq = t.seq
    join money.balances fb on fb.account_id = t.from_account_id and fb.asset_code = t.asset_code
    join money.balances tb on tb.account_id = t.to_account_id and tb.asset_code = t.asset_code
    where t.seq = v_external.transfer_seq and r.id = v_external.receipt_id;
end;
$$;

revoke all on function money_private.render_external_command(bigint, boolean) from public;

create function money_private.prepare_external_payment(
  p_external_id uuid,
  p_agent_id text,
  p_idempotency_key text,
  p_host text,
  p_pay_to text,
  p_settlement_asset text,
  p_settlement_network text,
  p_resource text,
  p_policy_payee text,
  p_amount_micros bigint,
  p_protocol_version smallint,
  p_signing_context jsonb
)
returns table (
  status text, replayed boolean, external_id uuid, external_state text,
  transfer_id uuid, receipt_id uuid, approval_id uuid, denial_code text, reason text,
  from_balance_micros bigint, to_balance_micros bigint,
  payment_header_ciphertext bytea, authorization_hash bytea
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash bytea;
  v_key_id bigint;
  v_prior money.idempotency_keys%rowtype;
  v_agent money.accounts%rowtype;
  v_boundary money.accounts%rowtype;
  v_mandate money.mandates%rowtype;
  v_today date := (clock_timestamp() at time zone 'utc')::date;
  v_spent_today bigint;
  v_seen boolean;
  v_pending_count integer;
  v_recent money.approvals%rowtype;
  v_approval money.approvals%rowtype;
  v_result jsonb;
  v_memo text;
  v_approval_key text;
begin
  if p_external_id is null then raise exception 'external id is required' using errcode = '22023'; end if;
  if p_protocol_version not in (1, 2) then raise exception 'unsupported x402 version' using errcode = '22023'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key must contain 1-128 characters' using errcode = '22023';
  end if;
  if p_host is null or p_host <> lower(p_host) or char_length(p_host) not between 1 and 253 or
     p_pay_to is null or char_length(p_pay_to) not between 1 and 256 or
     p_settlement_asset is null or char_length(p_settlement_asset) not between 1 and 256 or
     p_settlement_network is null or char_length(p_settlement_network) not between 1 and 128 or
     p_resource is null or char_length(p_resource) not between 1 and 2048 then
    raise exception 'invalid external payment identity or resource' using errcode = '22023';
  end if;
  if p_policy_payee <> 'x402:' || p_host || ':' || lower(p_pay_to) or char_length(p_policy_payee) > 800 then
    raise exception 'external policy payee does not match host and destination' using errcode = '22023';
  end if;
  if p_amount_micros is null or p_amount_micros <= 0 or p_amount_micros > 10000000 then
    raise exception 'external amount must be between one micro and the hard cap' using errcode = '22023';
  end if;
  if p_signing_context is null or jsonb_typeof(p_signing_context) <> 'object' or
     pg_column_size(p_signing_context) > 8192 or
     p_signing_context - 'maxTimeoutSeconds' - 'resource' - 'extensions' <> '{}'::jsonb then
    raise exception 'invalid external signing context' using errcode = '22023';
  end if;
  if p_protocol_version = 1 and p_signing_context <> '{}'::jsonb then
    raise exception 'x402 v1 signing context must be empty' using errcode = '22023';
  end if;
  if p_protocol_version = 2 and (
    not (p_signing_context ? 'maxTimeoutSeconds') or
    coalesce(p_signing_context->>'maxTimeoutSeconds', '') !~ '^[0-9]{1,3}$' or
    (p_signing_context->>'maxTimeoutSeconds')::integer not between 10 and 600 or
    jsonb_typeof(p_signing_context->'resource') <> 'object' or
    (p_signing_context->'resource') - 'description' - 'mimeType' <> '{}'::jsonb or
    (p_signing_context->'resource' ? 'description' and
      (jsonb_typeof(p_signing_context->'resource'->'description') <> 'string' or
       char_length(p_signing_context#>>'{resource,description}') > 2000)) or
    (p_signing_context->'resource' ? 'mimeType' and
      (jsonb_typeof(p_signing_context->'resource'->'mimeType') <> 'string' or
       char_length(p_signing_context#>>'{resource,mimeType}') > 200)) or
    (p_signing_context ? 'extensions' and jsonb_typeof(p_signing_context->'extensions') <> 'object')
  ) then
    raise exception 'invalid x402 v2 signing context' using errcode = '22023';
  end if;

  -- Preserve the exact v0.8 hash for v1 so already-completed commands remain
  -- replayable after this live migration. v2 includes its protocol version so
  -- a key cannot silently cross wire formats.
  if p_protocol_version = 1 then
    v_hash := public.digest(jsonb_build_object(
      'agentId', p_agent_id, 'host', p_host, 'payTo', lower(p_pay_to),
      'settlementAsset', lower(p_settlement_asset), 'settlementNetwork', p_settlement_network,
      'resource', p_resource, 'policyPayee', p_policy_payee,
      'amountMicros', p_amount_micros
    )::text, 'sha256');
  else
    v_hash := public.digest(jsonb_build_object(
      'agentId', p_agent_id, 'host', p_host, 'payTo', lower(p_pay_to),
      'settlementAsset', lower(p_settlement_asset), 'settlementNetwork', p_settlement_network,
      'resource', p_resource, 'policyPayee', p_policy_payee,
      'amountMicros', p_amount_micros, 'protocolVersion', p_protocol_version,
      'signingContext', p_signing_context
    )::text, 'sha256');
  end if;
  insert into money.idempotency_keys(actor_id, operation, idempotency_key, request_hash)
  values (p_agent_id, 'request_external_payment', p_idempotency_key, v_hash)
  on conflict (actor_id, operation, idempotency_key) do nothing
  returning id into v_key_id;
  if v_key_id is null then
    select k.* into v_prior from money.idempotency_keys k
    where k.actor_id = p_agent_id and k.operation = 'request_external_payment'
      and k.idempotency_key = p_idempotency_key for update;
    if v_prior.request_hash <> v_hash then
      return query select 'denied', true, null::uuid, null::text, null::uuid, null::uuid, null::uuid,
        'idempotency_conflict', 'idempotency key was reused with different external terms',
        null::bigint, null::bigint, null::bytea, null::bytea;
      return;
    end if;
    return query select * from money_private.render_external_command(v_prior.id, true);
    return;
  end if;

  perform 1 from money.accounts a where a.id in (p_agent_id, 'external:x402') order by a.id for update;
  select a.* into v_agent from money.accounts a where a.id = p_agent_id;
  select a.* into v_boundary from money.accounts a where a.id = 'external:x402';
  if v_agent.id is null or v_agent.kind <> 'agent' or v_agent.status <> 'active' then
    raise exception 'paying agent is unknown or inactive' using errcode = '42501';
  end if;
  if v_boundary.id is null or v_boundary.kind <> 'external' or v_boundary.status <> 'active' then
    raise exception 'x402 boundary is unavailable' using errcode = '55000';
  end if;
  update money.approvals a set status = 'expired', resolved_at = clock_timestamp(), reason = 'approval request expired'
  where a.agent_id = p_agent_id and a.status = 'pending' and a.expires_at <= clock_timestamp();
  select m.* into v_mandate from money.mandates m
  where m.agent_id = p_agent_id and m.asset_code = 'USD' and m.revoked_at is null
  order by m.created_at desc limit 1 for update;

  if v_mandate.id is null then
    v_result := jsonb_build_object('denialCode', 'no_mandate', 'reason', 'agent has no active USD mandate');
  elsif clock_timestamp() > v_mandate.expires_at then
    v_result := jsonb_build_object('denialCode', 'expired', 'reason', 'mandate has expired');
  elsif v_mandate.payee_allowlist is not null and not (p_policy_payee = any(v_mandate.payee_allowlist)) then
    v_result := jsonb_build_object('denialCode', 'payee_not_allowed', 'reason', 'external payee is not on the mandate allowlist');
  elsif v_mandate.spent_micros + p_amount_micros > v_mandate.budget_micros then
    v_result := jsonb_build_object('denialCode', 'budget', 'reason', 'payment would exceed the total mandate budget');
  else
    v_spent_today := case when v_today > v_mandate.spend_day then 0 else v_mandate.spent_today_micros end;
    if v_spent_today + p_amount_micros > v_mandate.daily_cap_micros then
      v_result := jsonb_build_object('denialCode', 'daily_cap', 'reason', 'payment would exceed the mandate daily cap');
    end if;
  end if;
  if v_result is not null then
    update money.idempotency_keys set state = 'completed', result_kind = 'denied', result = v_result,
      completed_at = clock_timestamp() where id = v_key_id;
    return query select * from money_private.render_external_command(v_key_id, false);
    return;
  end if;

  v_memo := left('x402:' || p_resource || ' -> ' || p_pay_to, 500);
  if p_amount_micros > v_mandate.escalate_above_micros then
    select a.* into v_recent from money.external_payments e
    join money.approvals a on a.id = e.approval_id
    where e.agent_id = p_agent_id and e.policy_payee = p_policy_payee
      and e.amount_micros = p_amount_micros and e.resource = p_resource
      and a.status in ('rejected', 'failed', 'expired')
      and a.resolved_at > clock_timestamp() - interval '5 minutes'
    order by a.resolved_at desc limit 1;
    if v_recent.id is not null then
      v_result := jsonb_build_object(
        'denialCode', case when v_recent.status = 'expired' then 'approval_expired' else 'approval_rejected' end,
        'reason', coalesce(v_recent.reason, 'matching external approval was recently resolved') || ' (5 minute cooldown)'
      );
      update money.idempotency_keys set state = 'completed', result_kind = 'denied', result = v_result,
        completed_at = clock_timestamp() where id = v_key_id;
      return query select * from money_private.render_external_command(v_key_id, false);
      return;
    end if;
    select count(*) into v_pending_count from money.approvals a
    where a.agent_id = p_agent_id and a.status = 'pending';
    if v_pending_count >= 20 then
      v_result := jsonb_build_object('denialCode', 'approval_limit', 'reason', 'agent already has 20 pending approvals');
      update money.idempotency_keys set state = 'completed', result_kind = 'denied', result = v_result,
        completed_at = clock_timestamp() where id = v_key_id;
      return query select * from money_private.render_external_command(v_key_id, false);
      return;
    end if;
    v_approval_key := 'ext_' || encode(public.digest((p_agent_id || ':' || p_idempotency_key)::text, 'sha256'), 'hex');
    insert into money.approvals(
      user_id, mandate_id, agent_id, to_account_id, asset_code,
      amount_micros, memo, idempotency_key, expires_at
    ) values (
      v_mandate.user_id, v_mandate.id, p_agent_id, 'external:x402', 'USD',
      p_amount_micros, v_memo, v_approval_key,
      least(clock_timestamp() + interval '24 hours', v_mandate.expires_at)
    ) returning * into v_approval;
    insert into money.external_payments(
      id, agent_id, host, pay_to, settlement_asset, settlement_network, resource,
      state, idempotency_key, policy_payee, amount_micros, approval_id,
      protocol_version, signing_context, mandate_id
    ) values (
      p_external_id, p_agent_id, p_host, p_pay_to, p_settlement_asset, p_settlement_network, p_resource,
      'approval_required', p_idempotency_key, p_policy_payee, p_amount_micros, v_approval.id,
      p_protocol_version, p_signing_context, v_mandate.id
    );
    update money.idempotency_keys set state = 'completed', result_kind = 'external',
      result_id = p_external_id::text,
      result = jsonb_build_object('externalId', p_external_id, 'approvalId', v_approval.id),
      completed_at = clock_timestamp() where id = v_key_id;
    insert into money.outbox_events(topic, aggregate_id, payload)
    values ('external.approval_requested', p_external_id::text, jsonb_build_object(
      'externalId', p_external_id, 'approvalId', v_approval.id, 'agentId', p_agent_id,
      'policyPayee', p_policy_payee, 'amountMicros', p_amount_micros::text,
      'protocolVersion', p_protocol_version
    ));
    return query select * from money_private.render_external_command(v_key_id, false);
    return;
  end if;

  if p_amount_micros > v_mandate.per_tx_cap_micros then
    v_result := jsonb_build_object('denialCode', 'per_tx_cap', 'reason', 'payment exceeds the mandate per-transaction cap');
  else
    select exists(select 1 from money.mandate_seen_payees s
      where s.mandate_id = v_mandate.id and s.payee_id = p_policy_payee) into v_seen;
    if not v_seen and p_amount_micros > v_mandate.new_payee_cap_micros then
      v_result := jsonb_build_object('denialCode', 'new_payee_cap', 'reason', 'first payment to this external destination exceeds the new-payee cap');
    end if;
  end if;
  if v_result is not null then
    update money.idempotency_keys set state = 'completed', result_kind = 'denied', result = v_result,
      completed_at = clock_timestamp() where id = v_key_id;
    return query select * from money_private.render_external_command(v_key_id, false);
    return;
  end if;

  insert into money.external_payments(
    id, agent_id, host, pay_to, settlement_asset, settlement_network, resource,
    state, idempotency_key, policy_payee, amount_micros, protocol_version, signing_context, mandate_id
  ) values (
    p_external_id, p_agent_id, p_host, p_pay_to, p_settlement_asset, p_settlement_network, p_resource,
    'prepared', p_idempotency_key, p_policy_payee, p_amount_micros, p_protocol_version, p_signing_context, v_mandate.id
  );
  update money.idempotency_keys set state = 'completed', result_kind = 'external',
    result_id = p_external_id::text, result = jsonb_build_object('externalId', p_external_id),
    completed_at = clock_timestamp() where id = v_key_id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('external.prepared', p_external_id::text, jsonb_build_object(
    'externalId', p_external_id, 'agentId', p_agent_id, 'policyPayee', p_policy_payee,
    'amountMicros', p_amount_micros::text, 'protocolVersion', p_protocol_version
  ));
  return query select * from money_private.render_external_command(v_key_id, false);
end;
$$;

revoke all on function money_private.prepare_external_payment(
  uuid, text, text, text, text, text, text, text, text, bigint, smallint, jsonb
) from public;

create function money_private.activate_external_payment(
  p_agent_id text,
  p_external_id uuid,
  p_payment_header_ciphertext bytea,
  p_authorization_hash bytea,
  p_authorization_key_id text,
  p_authorization_expires_at timestamptz,
  p_reverse_after timestamptz
)
returns table (
  status text, replayed boolean, external_id uuid, external_state text,
  transfer_id uuid, receipt_id uuid, approval_id uuid, denial_code text, reason text,
  from_balance_micros bigint, to_balance_micros bigint,
  payment_header_ciphertext bytea, authorization_hash bytea
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_external money.external_payments%rowtype;
  v_mandate money.mandates%rowtype;
  v_command_id bigint;
  v_today date := (clock_timestamp() at time zone 'utc')::date;
  v_spent_today bigint;
  v_seen boolean;
  v_reason text;
  v_post record;
  v_post_key text;
  v_transfer_seq bigint;
begin
  perform money_private.assert_external_authorization(
    p_payment_header_ciphertext, p_authorization_hash, p_authorization_key_id,
    p_authorization_expires_at, p_reverse_after
  );
  select k.id into v_command_id from money.idempotency_keys k
  join money.external_payments e on e.id::text = k.result_id
  where e.id = p_external_id and k.actor_id = p_agent_id
    and k.operation = 'request_external_payment' for update;
  if v_command_id is null then raise exception 'external activation command not found' using errcode = 'P0002'; end if;
  perform 1 from money.accounts a where a.id in (p_agent_id, 'external:x402') order by a.id for update;
  select e.* into v_external from money.external_payments e where e.id = p_external_id for update;
  if v_external.agent_id <> p_agent_id then raise exception 'external intent belongs to another agent' using errcode = '42501'; end if;
  if v_external.state <> 'prepared' then
    return query select * from money_private.render_external_command(v_command_id, true);
    return;
  end if;
  select m.* into v_mandate from money.mandates m where m.id = v_external.mandate_id for update;
  if v_mandate.id is null or v_mandate.agent_id <> p_agent_id or v_mandate.revoked_at is not null then
    v_reason := 'mandate was revoked or replaced before external activation';
  elsif clock_timestamp() > v_mandate.expires_at then
    v_reason := 'mandate expired before external activation';
  elsif v_mandate.payee_allowlist is not null and not (v_external.policy_payee = any(v_mandate.payee_allowlist)) then
    v_reason := 'external destination is no longer allowed by the mandate';
  elsif v_external.amount_micros > v_mandate.escalate_above_micros then
    v_reason := 'external payment now requires owner approval';
  elsif v_external.amount_micros > v_mandate.per_tx_cap_micros then
    v_reason := 'external payment exceeds the per-transaction cap';
  elsif v_mandate.spent_micros + v_external.amount_micros > v_mandate.budget_micros then
    v_reason := 'external payment exceeds the remaining mandate budget';
  else
    v_spent_today := case when v_today > v_mandate.spend_day then 0 else v_mandate.spent_today_micros end;
    if v_spent_today + v_external.amount_micros > v_mandate.daily_cap_micros then
      v_reason := 'external payment exceeds the remaining daily cap';
    else
      select exists(select 1 from money.mandate_seen_payees s
        where s.mandate_id = v_mandate.id and s.payee_id = v_external.policy_payee) into v_seen;
      if not v_seen and v_external.amount_micros > v_mandate.new_payee_cap_micros then
        v_reason := 'external payment exceeds the first-payment cap';
      end if;
    end if;
  end if;
  if v_reason is not null then
    update money.external_payments set state = 'cancelled', updated_at = clock_timestamp() where id = v_external.id;
    update money.idempotency_keys set result_kind = 'denied', result_id = null,
      result = jsonb_build_object('denialCode', 'permit_invalid', 'reason', v_reason),
      completed_at = clock_timestamp() where id = v_command_id;
    return query select * from money_private.render_external_command(v_command_id, false);
    return;
  end if;

  v_post_key := encode(public.digest(('external:' || v_external.agent_id || ':' || v_external.idempotency_key)::text, 'sha256'), 'hex');
  select * into v_post from money_private.post_transfer_kernel(
    v_external.agent_id, 'external_debit', v_post_key,
    v_external.agent_id, 'external:x402', 'USD', v_external.amount_micros,
    left('x402:' || v_external.resource || ' -> ' || v_external.pay_to, 500),
    jsonb_build_object(
      'mandateId', v_mandate.id, 'clientIdempotencyKey', v_external.idempotency_key,
      'externalId', v_external.id, 'externalPayee', v_external.policy_payee,
      'protocolVersion', v_external.protocol_version
    ), null
  );
  if v_post.status = 'denied' then
    update money.external_payments set state = 'cancelled', updated_at = clock_timestamp() where id = v_external.id;
    update money.idempotency_keys set result_kind = 'denied', result_id = null,
      result = jsonb_build_object(
        'denialCode', v_post.denial_code, 'reason', v_post.reason,
        'fromBalanceMicros', v_post.from_balance_micros, 'toBalanceMicros', v_post.to_balance_micros
      ), completed_at = clock_timestamp() where id = v_command_id;
    return query select * from money_private.render_external_command(v_command_id, false);
    return;
  end if;
  perform money_private.commit_transfer_authorization(
    v_post.transfer_id, v_mandate.id, v_external.policy_payee, v_external.amount_micros, 'autonomous', null
  );
  select t.seq into v_transfer_seq from money.transfers t where t.id = v_post.transfer_id;
  update money.external_payments set
    transfer_seq = v_transfer_seq, receipt_id = v_post.receipt_id,
    payment_header_ciphertext = p_payment_header_ciphertext,
    authorization_hash = p_authorization_hash, authorization_key_id = p_authorization_key_id,
    authorization_expires_at = p_authorization_expires_at, reverse_after = p_reverse_after,
    state = 'pending', updated_at = clock_timestamp()
  where id = v_external.id;
  update money.idempotency_keys set result = jsonb_build_object(
    'externalId', v_external.id, 'transferId', v_post.transfer_id, 'receiptId', v_post.receipt_id
  ) where id = v_command_id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('external.pending', v_external.id::text, jsonb_build_object(
    'externalId', v_external.id, 'agentId', v_external.agent_id,
    'transferId', v_post.transfer_id, 'receiptId', v_post.receipt_id,
    'policyPayee', v_external.policy_payee, 'amountMicros', v_external.amount_micros::text,
    'reverseAfter', p_reverse_after, 'protocolVersion', v_external.protocol_version
  ));
  return query select * from money_private.render_external_command(v_command_id, false);
end;
$$;

revoke all on function money_private.activate_external_payment(
  text, uuid, bytea, bytea, text, timestamptz, timestamptz
) from public;

create function money_private.resolve_external_approval_v2(
  p_user_id text,
  p_approval_id uuid,
  p_action text,
  p_reason text default null,
  p_payment_header_ciphertext bytea default null,
  p_authorization_hash bytea default null,
  p_authorization_key_id text default null,
  p_authorization_expires_at timestamptz default null,
  p_reverse_after timestamptz default null
)
returns table (
  status text, replayed boolean, external_id uuid, external_state text,
  transfer_id uuid, receipt_id uuid, approval_id uuid, denial_code text, reason text,
  from_balance_micros bigint, to_balance_micros bigint,
  payment_header_ciphertext bytea, authorization_hash bytea
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hint money.external_payments%rowtype;
  v_external money.external_payments%rowtype;
  v_approval money.approvals%rowtype;
  v_mandate money.mandates%rowtype;
  v_command_id bigint;
  v_today date := (clock_timestamp() at time zone 'utc')::date;
  v_spent_today bigint;
  v_failure text;
  v_post record;
  v_post_key text;
  v_transfer_seq bigint;
begin
  if p_action not in ('approve', 'reject') then raise exception 'action must be approve or reject' using errcode = '22023'; end if;
  if p_reason is not null and char_length(p_reason) > 500 then raise exception 'reason is too long' using errcode = '22023'; end if;
  if p_action = 'reject' and (p_payment_header_ciphertext is not null or p_authorization_hash is not null or
        p_authorization_key_id is not null or p_authorization_expires_at is not null or p_reverse_after is not null) then
    raise exception 'rejection must not carry payment authorization material' using errcode = '22023';
  end if;
  select e.* into v_hint from money.external_payments e where e.approval_id = p_approval_id;
  if v_hint.id is null then raise exception 'external approval not found' using errcode = 'P0002'; end if;
  select k.id into v_command_id from money.idempotency_keys k
  where k.actor_id = v_hint.agent_id and k.operation = 'request_external_payment'
    and k.idempotency_key = v_hint.idempotency_key for update;
  if v_command_id is null then raise exception 'external approval command is missing' using errcode = 'XX000'; end if;
  perform 1 from money.accounts a where a.id in (v_hint.agent_id, 'external:x402') order by a.id for update;
  select e.* into v_external from money.external_payments e where e.id = v_hint.id for update;
  select a.* into v_approval from money.approvals a where a.id = p_approval_id for update;
  if v_approval.id is null or v_approval.user_id <> p_user_id then
    raise exception 'external approval belongs to another owner' using errcode = '42501';
  end if;
  if v_approval.status = 'pending' and v_approval.expires_at <= clock_timestamp() then
    update money.approvals set status = 'expired', resolved_at = clock_timestamp(),
      reason = 'external payment approval expired' where id = p_approval_id;
    update money.external_payments set state = 'cancelled', updated_at = clock_timestamp() where id = v_external.id;
    return query select * from money_private.render_external_command(v_command_id, true);
    return;
  end if;
  if v_approval.status <> 'pending' then
    return query select * from money_private.render_external_command(v_command_id, true);
    return;
  end if;
  if p_action = 'reject' then
    update money.approvals set status = 'rejected', resolved_at = clock_timestamp(),
      reason = coalesce(nullif(p_reason, ''), 'rejected by owner') where id = p_approval_id;
    update money.external_payments set state = 'cancelled', updated_at = clock_timestamp() where id = v_external.id;
    return query select * from money_private.render_external_command(v_command_id, false);
    return;
  end if;

  -- Only a still-pending approval needs a fresh short-lived signature. Exact
  -- retries of an already resolved/expired approval above do not re-sign.
  perform money_private.assert_external_authorization(
    p_payment_header_ciphertext, p_authorization_hash, p_authorization_key_id,
    p_authorization_expires_at, p_reverse_after
  );

  select m.* into v_mandate from money.mandates m where m.id = v_external.mandate_id for update;
  if v_external.state <> 'approval_required' then
    v_failure := 'external payment is no longer awaiting approval';
  elsif v_mandate.id is null or v_mandate.user_id <> p_user_id or v_mandate.agent_id <> v_approval.agent_id then
    v_failure := 'approval mandate is missing or mismatched';
  elsif v_mandate.revoked_at is not null then
    v_failure := 'mandate was revoked before approval';
  elsif clock_timestamp() > v_mandate.expires_at then
    v_failure := 'mandate expired before approval';
  elsif v_mandate.payee_allowlist is not null and not (v_external.policy_payee = any(v_mandate.payee_allowlist)) then
    v_failure := 'external destination is no longer allowed by the mandate';
  elsif v_mandate.spent_micros + v_external.amount_micros > v_mandate.budget_micros then
    v_failure := 'approval would exceed the remaining mandate budget';
  else
    v_spent_today := case when v_today > v_mandate.spend_day then 0 else v_mandate.spent_today_micros end;
    if v_spent_today + v_external.amount_micros > v_mandate.daily_cap_micros then
      v_failure := 'approval would exceed the remaining daily cap';
    end if;
  end if;
  if v_failure is not null then
    update money.approvals set status = 'failed', resolved_at = clock_timestamp(), reason = left(v_failure, 500)
    where id = p_approval_id;
    update money.external_payments set state = 'cancelled', updated_at = clock_timestamp() where id = v_external.id;
    return query select * from money_private.render_external_command(v_command_id, false);
    return;
  end if;

  v_post_key := encode(public.digest(('external:' || v_external.agent_id || ':' || v_external.idempotency_key)::text, 'sha256'), 'hex');
  select * into v_post from money_private.post_transfer_kernel(
    v_external.agent_id, 'external_debit', v_post_key,
    v_external.agent_id, 'external:x402', 'USD', v_external.amount_micros, v_approval.memo,
    jsonb_build_object(
      'mandateId', v_mandate.id, 'approvalId', v_approval.id,
      'clientIdempotencyKey', v_external.idempotency_key, 'externalId', v_external.id,
      'externalPayee', v_external.policy_payee, 'protocolVersion', v_external.protocol_version
    ), null
  );
  if v_post.status = 'denied' then
    update money.approvals set status = 'failed', resolved_at = clock_timestamp(),
      reason = left(coalesce(v_post.reason, 'external payment failed'), 500) where id = p_approval_id;
    update money.external_payments set state = 'cancelled', updated_at = clock_timestamp() where id = v_external.id;
    return query select * from money_private.render_external_command(v_command_id, false);
    return;
  end if;
  perform money_private.commit_transfer_authorization(
    v_post.transfer_id, v_mandate.id, v_external.policy_payee,
    v_external.amount_micros, 'human_approved', v_approval.id
  );
  select t.seq into v_transfer_seq from money.transfers t where t.id = v_post.transfer_id;
  update money.external_payments set
    transfer_seq = v_transfer_seq, receipt_id = v_post.receipt_id,
    payment_header_ciphertext = p_payment_header_ciphertext,
    authorization_hash = p_authorization_hash, authorization_key_id = p_authorization_key_id,
    authorization_expires_at = p_authorization_expires_at, reverse_after = p_reverse_after,
    state = 'pending', updated_at = clock_timestamp()
  where id = v_external.id;
  update money.approvals set status = 'approved', resolved_at = clock_timestamp(),
    receipt_id = v_post.receipt_id, reason = null where id = p_approval_id;
  update money.idempotency_keys set result = jsonb_build_object(
    'externalId', v_external.id, 'transferId', v_post.transfer_id,
    'receiptId', v_post.receipt_id, 'approvalId', v_approval.id
  ) where id = v_command_id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('external.pending', v_external.id::text, jsonb_build_object(
    'externalId', v_external.id, 'agentId', v_external.agent_id,
    'transferId', v_post.transfer_id, 'receiptId', v_post.receipt_id,
    'approvalId', v_approval.id, 'policyPayee', v_external.policy_payee,
    'amountMicros', v_external.amount_micros::text,
    'reverseAfter', p_reverse_after, 'protocolVersion', v_external.protocol_version
  ));
  return query select * from money_private.render_external_command(v_command_id, false);
end;
$$;

revoke all on function money_private.resolve_external_approval_v2(
  text, uuid, text, text, bytea, bytea, text, timestamptz, timestamptz
) from public;

create function money_private.get_external_payment_by_approval_for_owner(p_user_id text, p_approval_id uuid)
returns setof money.external_payments
language sql
stable
security definer
set search_path = ''
as $$
  select e.* from money.external_payments e
  join money.approvals a on a.id = e.approval_id
  where e.approval_id = p_approval_id and a.user_id = p_user_id
$$;

revoke all on function money_private.get_external_payment_by_approval_for_owner(text, uuid) from public;

create function money_private.get_unresolved_external_payment_by_resource(
  p_agent_id text,
  p_resource text
)
returns table (external_id uuid, external_state text)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, e.state from money.external_payments e
  where e.agent_id = p_agent_id and e.resource = p_resource
    and e.state in ('prepared', 'approval_required', 'pending')
  order by e.created_at desc, e.id desc
  limit 1
$$;

revoke all on function money_private.get_unresolved_external_payment_by_resource(text, text) from public;

create function money_private.list_external_authorizations_for_rotation(
  p_active_key_id text,
  p_limit integer
)
returns table (
  external_id uuid,
  agent_id text,
  idempotency_key text,
  host text,
  pay_to text,
  settlement_asset text,
  settlement_network text,
  resource text,
  policy_payee text,
  amount_micros bigint,
  payment_header_ciphertext bytea,
  authorization_hash bytea,
  authorization_key_id text,
  authorization_expires_at timestamptz,
  reverse_after timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_active_key_id is null or p_active_key_id !~ '^[A-Za-z0-9._-]{1,64}$' then
    raise exception 'invalid active authorization key id' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'rotation batch limit must be between 1 and 1000' using errcode = '22023';
  end if;
  return query
    select e.id, e.agent_id, e.idempotency_key, e.host, e.pay_to,
      e.settlement_asset, e.settlement_network, e.resource, e.policy_payee,
      e.amount_micros, e.payment_header_ciphertext, e.authorization_hash,
      e.authorization_key_id, e.authorization_expires_at, e.reverse_after
    from money.external_payments e
    where e.state in ('pending', 'confirmed')
      and e.authorization_key_id is distinct from p_active_key_id
    order by e.created_at, e.id
    limit p_limit;
end;
$$;

revoke all on function money_private.list_external_authorizations_for_rotation(text, integer) from public;

create function money_private.replace_external_authorization_ciphertext(
  p_external_id uuid,
  p_expected_hash bytea,
  p_ciphertext bytea,
  p_key_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_expected_hash is null or octet_length(p_expected_hash) <> 32 or
     p_ciphertext is null or octet_length(p_ciphertext) not between 30 and 65536 or
     p_key_id is null or p_key_id !~ '^[A-Za-z0-9._-]{1,64}$' then
    raise exception 'invalid authorization rotation input' using errcode = '22023';
  end if;
  update money.external_payments set
    payment_header_ciphertext = p_ciphertext,
    authorization_key_id = p_key_id,
    updated_at = clock_timestamp()
  where id = p_external_id and authorization_hash = p_expected_hash
    and state in ('pending', 'confirmed');
  return found;
end;
$$;

revoke all on function money_private.replace_external_authorization_ciphertext(uuid, bytea, bytea, text) from public;

create or replace function money_private.protect_external_payment_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_activating boolean := old.state in ('prepared', 'approval_required') and new.state = 'pending';
  v_rotating boolean := old.state = new.state and old.state in ('pending', 'confirmed') and
    new.payment_header_ciphertext is distinct from old.payment_header_ciphertext;
begin
  if new.id <> old.id or new.agent_id <> old.agent_id or new.host <> old.host or
     new.pay_to <> old.pay_to or new.settlement_asset <> old.settlement_asset or
     new.settlement_network <> old.settlement_network or new.resource <> old.resource or
     new.idempotency_key <> old.idempotency_key or new.policy_payee <> old.policy_payee or
     new.amount_micros <> old.amount_micros or new.approval_id is distinct from old.approval_id or
     new.protocol_version <> old.protocol_version or new.mandate_id is distinct from old.mandate_id or
     new.signing_context <> old.signing_context or
     new.created_at <> old.created_at then
    raise exception 'external payment economic terms are immutable' using errcode = '55000';
  end if;
  if old.transfer_seq is not null and new.transfer_seq is distinct from old.transfer_seq then
    raise exception 'external debit transfer is immutable' using errcode = '55000';
  end if;
  if old.receipt_id is not null and new.receipt_id is distinct from old.receipt_id then
    raise exception 'external debit receipt is immutable' using errcode = '55000';
  end if;
  if old.reversal_transfer_seq is not null and new.reversal_transfer_seq is distinct from old.reversal_transfer_seq then
    raise exception 'external reversal transfer is immutable' using errcode = '55000';
  end if;
  if not (new.state = old.state or
    (old.state in ('prepared', 'approval_required') and new.state in ('cancelled', 'pending')) or
    (old.state = 'pending' and new.state in ('confirmed', 'reversed'))) then
    raise exception 'invalid external payment state transition % -> %', old.state, new.state using errcode = '55000';
  end if;
  if not v_activating and (
    new.authorization_hash is distinct from old.authorization_hash or
    new.authorization_expires_at is distinct from old.authorization_expires_at or
    new.reverse_after is distinct from old.reverse_after
  ) then
    raise exception 'external authorization terms are immutable after activation' using errcode = '55000';
  end if;
  if not (v_activating or v_rotating) and (
    new.payment_header_ciphertext is distinct from old.payment_header_ciphertext or
    new.authorization_key_id is distinct from old.authorization_key_id
  ) then
    raise exception 'external authorization ciphertext may change only on activation or rotation' using errcode = '55000';
  end if;
  if v_rotating and (
    new.authorization_hash is distinct from old.authorization_hash or
    new.authorization_expires_at is distinct from old.authorization_expires_at or
    new.reverse_after is distinct from old.reverse_after or
    new.state <> old.state
  ) then
    raise exception 'key rotation may not change authorization meaning or lifecycle' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger external_payments_protect_transition
before update on money.external_payments
for each row execute function money_private.protect_external_payment_transition();

create or replace function money_private.cancel_prepared_external_for_mandate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    update money.external_payments set state = 'cancelled', updated_at = clock_timestamp()
    where mandate_id = new.id and state = 'prepared';
  end if;
  return new;
end;
$$;

create trigger mandates_cancel_prepared_external
after update of revoked_at on money.mandates
for each row execute function money_private.cancel_prepared_external_for_mandate();

-- The v0.8 commands accepted already-signed authorizations and are intentionally
-- removed so an old application role cannot bypass sign-after-policy activation.
drop function money_private.request_external_payment(
  uuid, text, text, text, text, text, text, text, text,
  bigint, bytea, bytea, timestamptz, timestamptz
);
drop function money_private.resolve_external_approval(text, uuid, text, text);
