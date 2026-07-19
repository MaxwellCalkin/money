-- Durable external x402 settlement boundary.
--
-- An external request first passes the same mandate policy as an internal
-- payment, using host + destination as the policy payee. It then becomes
-- either a durable approval intent or an atomically debited pending payment.
-- Only a verified settlement claim may confirm it. Expired pending payments
-- are reversed by SKIP LOCKED workers without restoring mandate authority.

alter table money.external_payments
  alter column transfer_seq drop not null,
  alter column receipt_id drop not null,
  add column idempotency_key text,
  add column policy_payee text,
  add column amount_micros bigint,
  add column authorization_hash bytea,
  add column authorization_expires_at timestamptz,
  add column approval_id uuid references money.approvals(id);

-- Upgrade any externally inserted rows from the original schema. The product
-- API did not write these before v0.8, but preserving them makes the migration
-- safe for operators who exercised the table directly.
update money.external_payments e set
  idempotency_key = coalesce(t.metadata->>'clientIdempotencyKey', t.idempotency_key),
  policy_payee = coalesce(t.external_payee, 'x402:' || lower(e.host) || ':' || lower(e.pay_to)),
  amount_micros = t.amount_micros,
  authorization_hash = public.digest(e.payment_header_ciphertext, 'sha256'),
  authorization_expires_at = e.reverse_after - interval '1 minute',
  settled_tx = case
    when e.state = 'confirmed' then coalesce(e.settled_tx, 'legacy:unknown:' || e.id::text)
    else e.settled_tx
  end
from money.transfers t
where t.seq = e.transfer_seq;

alter table money.external_payments
  alter column idempotency_key set not null,
  alter column policy_payee set not null,
  alter column amount_micros set not null,
  alter column authorization_hash set not null,
  alter column authorization_expires_at set not null,
  add constraint external_payments_idempotency_length_check
    check (char_length(idempotency_key) between 1 and 128),
  add constraint external_payments_policy_payee_length_check
    check (char_length(policy_payee) between 1 and 800),
  add constraint external_payments_amount_check
    check (amount_micros > 0),
  add constraint external_payments_authorization_hash_check
    check (octet_length(authorization_hash) = 32),
  add constraint external_payments_authorization_window_check
    check (authorization_expires_at <= reverse_after),
  add constraint external_payments_host_check
    check (char_length(host) between 1 and 253 and host = lower(host)),
  add constraint external_payments_destination_check
    check (char_length(pay_to) between 1 and 256),
  add constraint external_payments_settlement_asset_check
    check (char_length(settlement_asset) between 1 and 256),
  add constraint external_payments_settlement_network_check
    check (char_length(settlement_network) between 1 and 128),
  add constraint external_payments_resource_check
    check (char_length(resource) between 1 and 2048),
  add constraint external_payments_ciphertext_check
    check (octet_length(payment_header_ciphertext) between 30 and 65536),
  add constraint external_payments_settled_tx_check
    check (settled_tx is null or char_length(settled_tx) between 1 and 256);

alter table money.external_payments
  drop constraint external_payments_state_check;

alter table money.external_payments
  add constraint external_payments_state_check check (state in (
    'approval_required', 'cancelled', 'pending', 'confirmed', 'reversed'
  )),
  add constraint external_payments_lifecycle_check check (
    (state in ('approval_required', 'cancelled') and approval_id is not null and
      transfer_seq is null and receipt_id is null and reversal_transfer_seq is null and settled_tx is null) or
    (state = 'pending' and transfer_seq is not null and receipt_id is not null and
      reversal_transfer_seq is null and settled_tx is null) or
    (state = 'confirmed' and transfer_seq is not null and receipt_id is not null and
      reversal_transfer_seq is null and settled_tx is not null) or
    (state = 'reversed' and transfer_seq is not null and receipt_id is not null and
      reversal_transfer_seq is not null and settled_tx is null)
  ),
  add constraint external_payments_policy_identity_check check (
    policy_payee = 'x402:' || lower(host) || ':' || lower(pay_to)
  ),
  add constraint external_payments_agent_idempotency_unique
    unique (agent_id, idempotency_key);

create unique index external_payments_approval_idx
  on money.external_payments(approval_id)
  where approval_id is not null;
create index external_payments_agent_state_created_idx
  on money.external_payments(agent_id, state, created_at desc);
create index external_payments_policy_payee_created_idx
  on money.external_payments(policy_payee, created_at desc);
create unique index external_payments_settlement_tx_unique
  on money.external_payments(settlement_network, settled_tx)
  where settled_tx is not null;

-- Extend the single journal kernel with two tightly authorized boundary
-- operations. The external policy identity travels in metadata for signature
-- compatibility, is copied into the immutable transfer column, and is part of
-- the independently recomputable receipt evidence.
create or replace function money_private.post_transfer_kernel(
  p_actor_id text,
  p_operation text,
  p_idempotency_key text,
  p_from_account_id text,
  p_to_account_id text,
  p_asset_code text,
  p_amount_micros bigint,
  p_memo text default '',
  p_metadata jsonb default '{}'::jsonb,
  p_refund_of uuid default null
)
returns table (
  status text,
  replayed boolean,
  transfer_id uuid,
  receipt_id uuid,
  denial_code text,
  reason text,
  from_balance_micros bigint,
  to_balance_micros bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash bytea;
  v_key_id bigint;
  v_prior money.idempotency_keys%rowtype;
  v_from money.accounts%rowtype;
  v_to money.accounts%rowtype;
  v_original money.transfers%rowtype;
  v_from_balance bigint;
  v_to_balance bigint;
  v_refunded bigint;
  v_transfer_seq bigint;
  v_transfer_id uuid;
  v_receipt_id uuid;
  v_result jsonb;
  v_external_payee text := nullif(p_metadata->>'externalPayee', '');
begin
  if p_actor_id is null or p_operation is null or p_operation !~ '^[a-z][a-z0-9_.:-]{1,63}$' then
    raise exception 'invalid actor or operation' using errcode = '22023';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key must contain 1-128 characters' using errcode = '22023';
  end if;
  if p_from_account_id is null or p_to_account_id is null or p_from_account_id = p_to_account_id then
    raise exception 'transfer endpoints must be distinct' using errcode = '22023';
  end if;
  if p_amount_micros is null or p_amount_micros <= 0 then
    raise exception 'amount must be positive integer micros' using errcode = '22023';
  end if;
  if p_memo is null or char_length(p_memo) > 500 or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'invalid memo or metadata' using errcode = '22023';
  end if;
  if p_operation <> 'refund' and p_refund_of is not null then
    raise exception 'refund evidence is only valid for refund transfers' using errcode = '22023';
  end if;
  if p_operation not in ('external_debit', 'external_reversal') and v_external_payee is not null then
    raise exception 'external payee evidence is only valid for external transfers' using errcode = '22023';
  end if;
  if p_operation in ('external_debit', 'external_reversal') and
     (v_external_payee is null or char_length(v_external_payee) > 800) then
    raise exception 'external transfers require a canonical policy payee' using errcode = '22023';
  end if;

  -- Non-refund, non-external commands retain their historical hash shape, so
  -- exact retries survive both v0.7 and v0.8 upgrades.
  v_hash := public.digest((case when p_refund_of is null then
    jsonb_build_object(
      'actor', p_actor_id,
      'operation', p_operation,
      'from', p_from_account_id,
      'to', p_to_account_id,
      'asset', p_asset_code,
      'amount', p_amount_micros,
      'memo', p_memo,
      'metadata', p_metadata
    )
  else
    jsonb_build_object(
      'actor', p_actor_id,
      'operation', p_operation,
      'from', p_from_account_id,
      'to', p_to_account_id,
      'asset', p_asset_code,
      'amount', p_amount_micros,
      'memo', p_memo,
      'metadata', p_metadata,
      'refundOf', p_refund_of
    )
  end)::text, 'sha256');

  insert into money.idempotency_keys(actor_id, operation, idempotency_key, request_hash)
  values (p_actor_id, p_operation, p_idempotency_key, v_hash)
  on conflict (actor_id, operation, idempotency_key) do nothing
  returning id into v_key_id;

  if v_key_id is null then
    select * into v_prior from money.idempotency_keys
    where actor_id = p_actor_id and operation = p_operation and idempotency_key = p_idempotency_key
    for update;
    if v_prior.request_hash <> v_hash then
      return query select 'denied', true, null::uuid, null::uuid,
        'idempotency_conflict', 'idempotency key was reused with different transfer terms',
        null::bigint, null::bigint;
      return;
    end if;
    if v_prior.state <> 'completed' then
      raise exception 'idempotency reservation is unexpectedly incomplete' using errcode = '40001';
    end if;
    if v_prior.result_kind = 'denied' then
      return query select 'denied', true, null::uuid, null::uuid,
        v_prior.result->>'denialCode', v_prior.result->>'reason',
        nullif(v_prior.result->>'fromBalanceMicros', '')::bigint,
        nullif(v_prior.result->>'toBalanceMicros', '')::bigint;
      return;
    end if;
    return query
      select 'posted', true, t.id, r.id, null::text, null::text,
        fb.available_micros, tb.available_micros
      from money.transfers t
      join money.receipts r on r.transfer_seq = t.seq
      join money.balances fb on fb.account_id = t.from_account_id and fb.asset_code = t.asset_code
      join money.balances tb on tb.account_id = t.to_account_id and tb.asset_code = t.asset_code
      where t.id::text = v_prior.result_id;
    return;
  end if;

  perform 1 from money.accounts
  where id in (p_from_account_id, p_to_account_id)
  order by id for update;
  select * into v_from from money.accounts where id = p_from_account_id;
  select * into v_to from money.accounts where id = p_to_account_id;
  if v_from.id is null or v_to.id is null then
    raise exception 'unknown transfer account' using errcode = '23503';
  end if;
  if v_from.status <> 'active' or v_to.status <> 'active' then
    v_result := jsonb_build_object('denialCode', 'account_frozen', 'reason', 'one or both accounts are not active');
    update money.idempotency_keys set
      state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
    where id = v_key_id;
    return query select 'denied', false, null::uuid, null::uuid,
      'account_frozen', 'one or both accounts are not active', null::bigint, null::bigint;
    return;
  end if;

  if p_operation = 'pay' and (
    p_actor_id <> p_from_account_id or v_from.kind <> 'agent' or v_to.kind = 'external'
  ) then
    raise exception 'pay requires the actor agent to be the sender and an internal recipient' using errcode = '42501';
  elsif p_operation = 'allocate' and (
    p_actor_id <> p_from_account_id or v_from.kind <> 'user' or
    v_to.kind <> 'agent' or v_to.owner_id <> p_actor_id
  ) then
    raise exception 'allocate requires an owner sending to its own agent' using errcode = '42501';
  elsif p_operation = 'fund' and (
    p_from_account_id <> 'external:funding' or p_actor_id <> p_to_account_id or v_to.kind <> 'user'
  ) then
    raise exception 'fund requires the external funding boundary to credit the actor user' using errcode = '42501';
  elsif p_operation = 'refund' and (
    p_actor_id <> p_from_account_id or v_from.kind <> 'provider' or
    v_to.kind <> 'agent' or p_refund_of is null
  ) then
    raise exception 'refund requires the provider actor to return value to the original agent' using errcode = '42501';
  elsif p_operation = 'external_debit' and (
    p_actor_id <> p_from_account_id or v_from.kind <> 'agent' or
    p_to_account_id <> 'external:x402' or v_to.kind <> 'external'
  ) then
    raise exception 'external debit requires the actor agent to pay the x402 boundary' using errcode = '42501';
  elsif p_operation = 'external_reversal' and (
    p_actor_id <> 'external:x402' or p_from_account_id <> 'external:x402' or
    v_from.kind <> 'external' or v_to.kind <> 'agent'
  ) then
    raise exception 'external reversal requires the x402 boundary to return value to an agent' using errcode = '42501';
  elsif p_operation not in ('pay', 'allocate', 'fund', 'refund', 'external_debit', 'external_reversal') then
    raise exception 'unsupported transfer operation' using errcode = '22023';
  end if;

  if p_operation = 'refund' then
    perform 1 from money.receipts r where r.id = p_refund_of for update;
    select t.* into v_original
    from money.receipts r join money.transfers t on t.seq = r.transfer_seq
    where r.id = p_refund_of;
    if v_original.id is null or v_original.operation <> 'pay' or
       v_original.refund_of is not null or
       v_original.to_account_id <> p_from_account_id or
       v_original.from_account_id <> p_to_account_id or
       v_original.asset_code <> p_asset_code then
      v_result := jsonb_build_object(
        'denialCode', 'refund_invalid',
        'reason', 'receipt is not an eligible purchase by this agent from this provider'
      );
      update money.idempotency_keys set
        state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
      where id = v_key_id;
      return query select 'denied', false, null::uuid, null::uuid,
        'refund_invalid', v_result->>'reason', null::bigint, null::bigint;
      return;
    end if;
    select coalesce(sum(t.amount_micros), 0)::bigint into v_refunded
    from money.transfers t where t.refund_of = p_refund_of;
    if v_refunded + p_amount_micros > v_original.amount_micros then
      v_result := jsonb_build_object(
        'denialCode', 'refund_invalid',
        'reason', 'refund exceeds the remaining refundable amount'
      );
      update money.idempotency_keys set
        state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
      where id = v_key_id;
      return query select 'denied', false, null::uuid, null::uuid,
        'refund_invalid', v_result->>'reason', null::bigint, null::bigint;
      return;
    end if;
  end if;

  insert into money.balances(account_id, asset_code)
  select account_id, p_asset_code
  from unnest(array[p_from_account_id, p_to_account_id]) as pending(account_id)
  order by account_id
  on conflict (account_id, asset_code) do nothing;
  perform 1 from money.balances
  where asset_code = p_asset_code and account_id in (p_from_account_id, p_to_account_id)
  order by account_id for update;
  select available_micros into v_from_balance
  from money.balances where account_id = p_from_account_id and asset_code = p_asset_code;
  select available_micros into v_to_balance
  from money.balances where account_id = p_to_account_id and asset_code = p_asset_code;

  -- external:funding is the sole issuance source. The x402 boundary holds
  -- actual agent debits and must never be driven negative by a reversal.
  if p_operation <> 'fund' and v_from_balance < p_amount_micros then
    v_result := jsonb_build_object(
      'denialCode', 'insufficient_funds', 'reason', 'insufficient available balance',
      'fromBalanceMicros', v_from_balance, 'toBalanceMicros', v_to_balance
    );
    update money.idempotency_keys set
      state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
    where id = v_key_id;
    return query select 'denied', false, null::uuid, null::uuid,
      'insufficient_funds', 'insufficient available balance', v_from_balance, v_to_balance;
    return;
  end if;

  insert into money.transfers(
    actor_id, operation, idempotency_key, request_hash,
    from_account_id, to_account_id, asset_code, amount_micros,
    memo, external_payee, refund_of, metadata
  ) values (
    p_actor_id, p_operation, p_idempotency_key, v_hash,
    p_from_account_id, p_to_account_id, p_asset_code, p_amount_micros,
    p_memo, v_external_payee, p_refund_of, p_metadata
  ) returning seq, id into v_transfer_seq, v_transfer_id;

  insert into money.ledger_entries(transfer_seq, account_id, asset_code, amount_micros)
  values
    (v_transfer_seq, p_from_account_id, p_asset_code, -p_amount_micros),
    (v_transfer_seq, p_to_account_id, p_asset_code, p_amount_micros);
  update money.balances set
    available_micros = available_micros + case
      when account_id = p_from_account_id then -p_amount_micros
      else p_amount_micros
    end,
    version = version + 1,
    updated_at = clock_timestamp()
  where asset_code = p_asset_code and account_id in (p_from_account_id, p_to_account_id);

  insert into money.receipts(transfer_seq, evidence_hash)
  values (
    v_transfer_seq,
    public.digest((case
      when v_external_payee is not null then jsonb_build_object(
        'transferId', v_transfer_id,
        'actor', p_actor_id,
        'operation', p_operation,
        'from', p_from_account_id,
        'to', p_to_account_id,
        'asset', p_asset_code,
        'amount', p_amount_micros,
        'memo', p_memo,
        'externalPayee', v_external_payee,
        'requestHash', encode(v_hash, 'hex')
      )
      when p_refund_of is not null then jsonb_build_object(
        'transferId', v_transfer_id,
        'actor', p_actor_id,
        'operation', p_operation,
        'from', p_from_account_id,
        'to', p_to_account_id,
        'asset', p_asset_code,
        'amount', p_amount_micros,
        'memo', p_memo,
        'refundOf', p_refund_of,
        'requestHash', encode(v_hash, 'hex')
      )
      else jsonb_build_object(
        'transferId', v_transfer_id,
        'actor', p_actor_id,
        'operation', p_operation,
        'from', p_from_account_id,
        'to', p_to_account_id,
        'asset', p_asset_code,
        'amount', p_amount_micros,
        'memo', p_memo,
        'requestHash', encode(v_hash, 'hex')
      )
    end)::text, 'sha256')
  ) returning id into v_receipt_id;

  insert into money.outbox_events(topic, aggregate_id, payload)
  values (
    case
      when p_operation = 'refund' then 'refund.posted'
      when p_operation = 'external_debit' then 'external.debited'
      when p_operation = 'external_reversal' then 'external.reversal_posted'
      else 'transfer.posted'
    end,
    v_transfer_id::text,
    jsonb_build_object(
      'transferId', v_transfer_id,
      'receiptId', v_receipt_id,
      'actorId', p_actor_id,
      'operation', p_operation,
      'from', p_from_account_id,
      'to', p_to_account_id,
      'asset', p_asset_code,
      'amountMicros', p_amount_micros::text,
      'externalPayee', v_external_payee,
      'refundOf', p_refund_of
    )
  );
  update money.idempotency_keys set
    state = 'completed', result_kind = 'transfer', result_id = v_transfer_id::text,
    result = jsonb_build_object('transferId', v_transfer_id, 'receiptId', v_receipt_id),
    completed_at = clock_timestamp()
  where id = v_key_id;
  select available_micros into v_from_balance
  from money.balances where account_id = p_from_account_id and asset_code = p_asset_code;
  select available_micros into v_to_balance
  from money.balances where account_id = p_to_account_id and asset_code = p_asset_code;
  return query select 'posted', false, v_transfer_id, v_receipt_id,
    null::text, null::text, v_from_balance, v_to_balance;
end;
$$;

revoke all on function money_private.post_transfer_kernel(
  text, text, text, text, text, text, bigint, text, jsonb, uuid
) from public;

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
  if v_external.id is null then
    raise exception 'external command references a missing payment' using errcode = 'XX000';
  end if;

  if v_external.state in ('approval_required', 'cancelled') then
    update money.approvals a set
      status = 'expired', resolved_at = clock_timestamp(), reason = 'external payment approval expired'
    where a.id = v_external.approval_id and a.status = 'pending' and a.expires_at <= clock_timestamp();
    select a.* into v_approval from money.approvals a where a.id = v_external.approval_id;
    if v_approval.id is null then
      raise exception 'external payment approval is missing' using errcode = 'XX000';
    end if;
    if v_external.state = 'approval_required' and v_approval.status = 'pending' then
      return query select
        'approval_required', p_replayed, v_external.id, v_external.state,
        null::uuid, null::uuid, v_approval.id, null::text, null::text,
        null::bigint, null::bigint,
        v_external.payment_header_ciphertext, v_external.authorization_hash;
      return;
    end if;
    if v_approval.status = 'approved' then
      raise exception 'approved external intent was not moved to pending' using errcode = 'XX000';
    end if;
    if v_external.state = 'approval_required' then
      update money.external_payments e set state = 'cancelled', updated_at = clock_timestamp()
      where e.id = v_external.id;
      v_external.state := 'cancelled';
    end if;
    return query select
      'denied', p_replayed, v_external.id, v_external.state,
      null::uuid, null::uuid, v_approval.id,
      case v_approval.status
        when 'expired' then 'approval_expired'
        when 'failed' then 'approval_failed'
        else 'approval_rejected'
      end,
      coalesce(v_approval.reason, 'approval ' || v_approval.status),
      null::bigint, null::bigint,
      null::bytea, v_external.authorization_hash;
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

create or replace function money_private.request_external_payment(
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
  p_payment_header_ciphertext bytea,
  p_authorization_hash bytea,
  p_authorization_expires_at timestamptz,
  p_reverse_after timestamptz
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
  v_post record;
  v_post_key text;
  v_transfer_seq bigint;
  v_result jsonb;
  v_memo text;
  v_approval_key text;
begin
  if p_external_id is null then raise exception 'external id is required' using errcode = '22023'; end if;
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
  if p_payment_header_ciphertext is null or octet_length(p_payment_header_ciphertext) not between 30 and 65536 or
     p_authorization_hash is null or octet_length(p_authorization_hash) <> 32 then
    raise exception 'invalid encrypted payment authorization' using errcode = '22023';
  end if;
  if p_authorization_expires_at <= clock_timestamp() or p_reverse_after < p_authorization_expires_at or
     p_reverse_after > p_authorization_expires_at + interval '5 minutes' then
    raise exception 'invalid external authorization window' using errcode = '22023';
  end if;

  v_hash := public.digest(jsonb_build_object(
    'agentId', p_agent_id,
    'host', p_host,
    'payTo', lower(p_pay_to),
    'settlementAsset', lower(p_settlement_asset),
    'settlementNetwork', p_settlement_network,
    'resource', p_resource,
    'policyPayee', p_policy_payee,
    'amountMicros', p_amount_micros
  )::text, 'sha256');
  insert into money.idempotency_keys(actor_id, operation, idempotency_key, request_hash)
  values (p_agent_id, 'request_external_payment', p_idempotency_key, v_hash)
  on conflict (actor_id, operation, idempotency_key) do nothing
  returning id into v_key_id;
  if v_key_id is null then
    select k.* into v_prior from money.idempotency_keys k
    where k.actor_id = p_agent_id and k.operation = 'request_external_payment'
      and k.idempotency_key = p_idempotency_key
    for update;
    if v_prior.request_hash <> v_hash then
      return query select
        'denied', true, null::uuid, null::text, null::uuid, null::uuid, null::uuid,
        'idempotency_conflict', 'idempotency key was reused with different external terms',
        null::bigint, null::bigint, null::bytea, null::bytea;
      return;
    end if;
    return query select * from money_private.render_external_command(v_prior.id, true);
    return;
  end if;

  perform 1 from money.accounts a
  where a.id in (p_agent_id, 'external:x402')
  order by a.id for update;
  select a.* into v_agent from money.accounts a where a.id = p_agent_id;
  select a.* into v_boundary from money.accounts a where a.id = 'external:x402';
  if v_agent.id is null or v_agent.kind <> 'agent' or v_agent.status <> 'active' then
    raise exception 'paying agent is unknown or inactive' using errcode = '42501';
  end if;
  if v_boundary.id is null or v_boundary.kind <> 'external' or v_boundary.status <> 'active' then
    raise exception 'x402 boundary is unavailable' using errcode = '55000';
  end if;

  update money.approvals a set
    status = 'expired', resolved_at = clock_timestamp(), reason = 'approval request expired'
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
    update money.idempotency_keys k set
      state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
    where k.id = v_key_id;
    return query select * from money_private.render_external_command(v_key_id, false);
    return;
  end if;

  v_memo := left('x402:' || p_resource || ' -> ' || p_pay_to, 500);
  if p_amount_micros > v_mandate.escalate_above_micros then
    select a.* into v_recent
    from money.external_payments e
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
      update money.idempotency_keys k set
        state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
      where k.id = v_key_id;
      return query select * from money_private.render_external_command(v_key_id, false);
      return;
    end if;
    select count(*) into v_pending_count from money.approvals a
    where a.agent_id = p_agent_id and a.status = 'pending';
    if v_pending_count >= 20 then
      v_result := jsonb_build_object('denialCode', 'approval_limit', 'reason', 'agent already has 20 pending approvals');
      update money.idempotency_keys k set
        state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
      where k.id = v_key_id;
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
      least(clock_timestamp() + interval '24 hours', v_mandate.expires_at, p_authorization_expires_at)
    ) returning * into v_approval;
    insert into money.external_payments(
      id, agent_id, host, pay_to, settlement_asset, settlement_network,
      resource, payment_header_ciphertext, state, reverse_after,
      idempotency_key, policy_payee, amount_micros, authorization_hash,
      authorization_expires_at, approval_id
    ) values (
      p_external_id, p_agent_id, p_host, p_pay_to, p_settlement_asset, p_settlement_network,
      p_resource, p_payment_header_ciphertext, 'approval_required', p_reverse_after,
      p_idempotency_key, p_policy_payee, p_amount_micros, p_authorization_hash,
      p_authorization_expires_at, v_approval.id
    );
    update money.idempotency_keys k set
      state = 'completed', result_kind = 'external', result_id = p_external_id::text,
      result = jsonb_build_object('externalId', p_external_id, 'approvalId', v_approval.id),
      completed_at = clock_timestamp()
    where k.id = v_key_id;
    insert into money.outbox_events(topic, aggregate_id, payload)
    values ('external.approval_requested', p_external_id::text, jsonb_build_object(
      'externalId', p_external_id, 'approvalId', v_approval.id,
      'agentId', p_agent_id, 'policyPayee', p_policy_payee,
      'amountMicros', p_amount_micros::text
    ));
    return query select * from money_private.render_external_command(v_key_id, false);
    return;
  end if;

  if p_amount_micros > v_mandate.per_tx_cap_micros then
    v_result := jsonb_build_object('denialCode', 'per_tx_cap', 'reason', 'payment exceeds the mandate per-transaction cap');
  else
    select exists(
      select 1 from money.mandate_seen_payees s
      where s.mandate_id = v_mandate.id and s.payee_id = p_policy_payee
    ) into v_seen;
    if not v_seen and p_amount_micros > v_mandate.new_payee_cap_micros then
      v_result := jsonb_build_object('denialCode', 'new_payee_cap', 'reason', 'first payment to this external destination exceeds the new-payee cap');
    end if;
  end if;
  if v_result is not null then
    update money.idempotency_keys k set
      state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
    where k.id = v_key_id;
    return query select * from money_private.render_external_command(v_key_id, false);
    return;
  end if;

  v_post_key := encode(public.digest(('external:' || p_agent_id || ':' || p_idempotency_key)::text, 'sha256'), 'hex');
  select * into v_post from money_private.post_transfer_kernel(
    p_agent_id, 'external_debit', v_post_key,
    p_agent_id, 'external:x402', 'USD', p_amount_micros, v_memo,
    jsonb_build_object(
      'mandateId', v_mandate.id,
      'clientIdempotencyKey', p_idempotency_key,
      'externalId', p_external_id,
      'externalPayee', p_policy_payee
    ),
    null
  );
  if v_post.status = 'denied' then
    v_result := jsonb_build_object(
      'denialCode', v_post.denial_code, 'reason', v_post.reason,
      'fromBalanceMicros', v_post.from_balance_micros,
      'toBalanceMicros', v_post.to_balance_micros
    );
    update money.idempotency_keys k set
      state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
    where k.id = v_key_id;
    return query select * from money_private.render_external_command(v_key_id, false);
    return;
  end if;
  perform money_private.commit_transfer_authorization(
    v_post.transfer_id, v_mandate.id, p_policy_payee, p_amount_micros, 'autonomous', null
  );
  select t.seq into v_transfer_seq from money.transfers t where t.id = v_post.transfer_id;
  insert into money.external_payments(
    id, agent_id, transfer_seq, receipt_id, host, pay_to,
    settlement_asset, settlement_network, resource, payment_header_ciphertext,
    state, reverse_after, idempotency_key, policy_payee, amount_micros,
    authorization_hash, authorization_expires_at
  ) values (
    p_external_id, p_agent_id, v_transfer_seq, v_post.receipt_id, p_host, p_pay_to,
    p_settlement_asset, p_settlement_network, p_resource, p_payment_header_ciphertext,
    'pending', p_reverse_after, p_idempotency_key, p_policy_payee, p_amount_micros,
    p_authorization_hash, p_authorization_expires_at
  );
  update money.idempotency_keys k set
    state = 'completed', result_kind = 'external', result_id = p_external_id::text,
    result = jsonb_build_object(
      'externalId', p_external_id, 'transferId', v_post.transfer_id, 'receiptId', v_post.receipt_id
    ),
    completed_at = clock_timestamp()
  where k.id = v_key_id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('external.pending', p_external_id::text, jsonb_build_object(
    'externalId', p_external_id, 'agentId', p_agent_id,
    'transferId', v_post.transfer_id, 'receiptId', v_post.receipt_id,
    'policyPayee', p_policy_payee, 'amountMicros', p_amount_micros::text,
    'reverseAfter', p_reverse_after
  ));
  return query select * from money_private.render_external_command(v_key_id, false);
end;
$$;

revoke all on function money_private.request_external_payment(
  uuid, text, text, text, text, text, text, text, text,
  bigint, bytea, bytea, timestamptz, timestamptz
) from public;

create or replace function money_private.resolve_external_approval(
  p_user_id text,
  p_approval_id uuid,
  p_action text,
  p_reason text default null
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
  v_hint money.external_payments%rowtype;
  v_external money.external_payments%rowtype;
  v_approval money.approvals%rowtype;
  v_mandate money.mandates%rowtype;
  v_command_id bigint;
  v_today date := (clock_timestamp() at time zone 'utc')::date;
  v_spent_today bigint;
  v_post record;
  v_post_key text;
  v_transfer_seq bigint;
begin
  if p_action not in ('approve', 'reject') then
    raise exception 'action must be approve or reject' using errcode = '22023';
  end if;
  if p_reason is not null and char_length(p_reason) > 500 then
    raise exception 'reason is too long' using errcode = '22023';
  end if;
  select e.* into v_hint from money.external_payments e where e.approval_id = p_approval_id;
  if v_hint.id is null then raise exception 'external approval not found' using errcode = 'P0002'; end if;
  select k.id into v_command_id from money.idempotency_keys k
  where k.actor_id = v_hint.agent_id and k.operation = 'request_external_payment'
    and k.idempotency_key = v_hint.idempotency_key
  for update;
  if v_command_id is null then raise exception 'external approval command is missing' using errcode = 'XX000'; end if;

  perform 1 from money.accounts a
  where a.id in (v_hint.agent_id, 'external:x402')
  order by a.id for update;
  select e.* into v_external from money.external_payments e where e.id = v_hint.id for update;
  select a.* into v_approval from money.approvals a where a.id = p_approval_id for update;
  if v_approval.id is null or v_approval.user_id <> p_user_id then
    raise exception 'external approval belongs to another owner' using errcode = '42501';
  end if;
  if v_approval.status = 'pending' and v_approval.expires_at <= clock_timestamp() then
    update money.approvals a set
      status = 'expired', resolved_at = clock_timestamp(), reason = 'external payment approval expired'
    where a.id = p_approval_id;
    update money.external_payments e set state = 'cancelled', updated_at = clock_timestamp()
    where e.id = v_external.id;
    return query select * from money_private.render_external_command(v_command_id, true);
    return;
  end if;
  if v_approval.status <> 'pending' then
    return query select * from money_private.render_external_command(v_command_id, true);
    return;
  end if;
  if p_action = 'reject' then
    update money.approvals a set
      status = 'rejected', resolved_at = clock_timestamp(),
      reason = coalesce(nullif(p_reason, ''), 'rejected by owner')
    where a.id = p_approval_id;
    update money.external_payments e set state = 'cancelled', updated_at = clock_timestamp()
    where e.id = v_external.id;
    return query select * from money_private.render_external_command(v_command_id, false);
    return;
  end if;

  select m.* into v_mandate from money.mandates m where m.id = v_approval.mandate_id for update;
  if v_external.state <> 'approval_required' then
    p_reason := 'external payment is no longer awaiting approval';
  elsif clock_timestamp() > v_external.authorization_expires_at then
    p_reason := 'external payment authorization expired before approval';
  elsif v_mandate.id is null or v_mandate.user_id <> p_user_id or v_mandate.agent_id <> v_approval.agent_id then
    p_reason := 'approval mandate is missing or mismatched';
  elsif v_mandate.revoked_at is not null then
    p_reason := 'mandate was revoked before approval';
  elsif clock_timestamp() > v_mandate.expires_at then
    p_reason := 'mandate expired before approval';
  elsif v_mandate.payee_allowlist is not null and not (v_external.policy_payee = any(v_mandate.payee_allowlist)) then
    p_reason := 'external destination is no longer allowed by the mandate';
  elsif v_mandate.spent_micros + v_external.amount_micros > v_mandate.budget_micros then
    p_reason := 'approval would exceed the remaining mandate budget';
  else
    v_spent_today := case when v_today > v_mandate.spend_day then 0 else v_mandate.spent_today_micros end;
    if v_spent_today + v_external.amount_micros > v_mandate.daily_cap_micros then
      p_reason := 'approval would exceed the remaining daily cap';
    else
      p_reason := null;
    end if;
  end if;
  if p_reason is not null then
    update money.approvals a set
      status = 'failed', resolved_at = clock_timestamp(), reason = left(p_reason, 500)
    where a.id = p_approval_id;
    update money.external_payments e set state = 'cancelled', updated_at = clock_timestamp()
    where e.id = v_external.id;
    return query select * from money_private.render_external_command(v_command_id, false);
    return;
  end if;

  v_post_key := encode(public.digest(
    ('external:' || v_external.agent_id || ':' || v_external.idempotency_key)::text,
    'sha256'
  ), 'hex');
  select * into v_post from money_private.post_transfer_kernel(
    v_external.agent_id, 'external_debit', v_post_key,
    v_external.agent_id, 'external:x402', 'USD', v_external.amount_micros,
    v_approval.memo,
    jsonb_build_object(
      'mandateId', v_mandate.id,
      'approvalId', v_approval.id,
      'clientIdempotencyKey', v_external.idempotency_key,
      'externalId', v_external.id,
      'externalPayee', v_external.policy_payee
    ),
    null
  );
  if v_post.status = 'denied' then
    update money.approvals a set
      status = 'failed', resolved_at = clock_timestamp(),
      reason = left(coalesce(v_post.reason, 'external payment failed'), 500)
    where a.id = p_approval_id;
    update money.external_payments e set state = 'cancelled', updated_at = clock_timestamp()
    where e.id = v_external.id;
    return query select * from money_private.render_external_command(v_command_id, false);
    return;
  end if;
  perform money_private.commit_transfer_authorization(
    v_post.transfer_id, v_mandate.id, v_external.policy_payee,
    v_external.amount_micros, 'human_approved', v_approval.id
  );
  select t.seq into v_transfer_seq from money.transfers t where t.id = v_post.transfer_id;
  update money.external_payments e set
    transfer_seq = v_transfer_seq,
    receipt_id = v_post.receipt_id,
    state = 'pending',
    updated_at = clock_timestamp()
  where e.id = v_external.id;
  update money.approvals a set
    status = 'approved', resolved_at = clock_timestamp(), receipt_id = v_post.receipt_id, reason = null
  where a.id = p_approval_id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('external.pending', v_external.id::text, jsonb_build_object(
    'externalId', v_external.id, 'agentId', v_external.agent_id,
    'transferId', v_post.transfer_id, 'receiptId', v_post.receipt_id,
    'approvalId', v_approval.id, 'policyPayee', v_external.policy_payee,
    'amountMicros', v_external.amount_micros::text,
    'reverseAfter', v_external.reverse_after
  ));
  return query select * from money_private.render_external_command(v_command_id, false);
end;
$$;

revoke all on function money_private.resolve_external_approval(text, uuid, text, text) from public;

create or replace function money_private.reverse_external_payment(p_external_id uuid)
returns table (
  reversed boolean,
  external_id uuid,
  reversal_transfer_id uuid,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_external money.external_payments%rowtype;
  v_post record;
  v_reversal_seq bigint;
begin
  select e.* into v_external from money.external_payments e where e.id = p_external_id for update;
  if v_external.id is null then
    return query select false, p_external_id, null::uuid, 'external payment not found';
    return;
  end if;
  if v_external.state = 'reversed' then
    return query
      select true, v_external.id, t.id, 'already reversed'
      from money.transfers t where t.seq = v_external.reversal_transfer_seq;
    return;
  end if;
  if v_external.state <> 'pending' then
    return query select false, v_external.id, null::uuid, 'external payment is not pending';
    return;
  end if;
  if v_external.reverse_after >= clock_timestamp() then
    return query select false, v_external.id, null::uuid, 'confirmation deadline has not passed';
    return;
  end if;

  select * into v_post from money_private.post_transfer_kernel(
    'external:x402', 'external_reversal', 'rev_' || v_external.id::text,
    'external:x402', v_external.agent_id, 'USD', v_external.amount_micros,
    left('reversal: external payment ' || v_external.id::text || ' unconfirmed past deadline', 500),
    jsonb_build_object(
      'externalId', v_external.id,
      'originalTransferSeq', v_external.transfer_seq,
      'externalPayee', v_external.policy_payee
    ),
    null
  );
  if v_post.status <> 'posted' then
    raise exception 'external reversal posting failed: %', coalesce(v_post.reason, 'unknown') using errcode = 'XX000';
  end if;
  select t.seq into v_reversal_seq from money.transfers t where t.id = v_post.transfer_id;
  update money.external_payments e set
    state = 'reversed', reversal_transfer_seq = v_reversal_seq,
    updated_at = clock_timestamp()
  where e.id = v_external.id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('external.reversed', v_external.id::text, jsonb_build_object(
    'externalId', v_external.id,
    'agentId', v_external.agent_id,
    'originalTransferSeq', v_external.transfer_seq,
    'reversalTransferId', v_post.transfer_id,
    'amountMicros', v_external.amount_micros::text
  ));
  return query select true, v_external.id, v_post.transfer_id::uuid, null::text;
end;
$$;

revoke all on function money_private.reverse_external_payment(uuid) from public;

create or replace function money_private.confirm_external_payment(
  p_agent_id text,
  p_external_id uuid,
  p_settled_tx text
)
returns table (ok boolean, replayed boolean, external_state text, settled_tx text, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_external money.external_payments%rowtype;
begin
  if p_settled_tx is null or char_length(p_settled_tx) not between 1 and 256 then
    raise exception 'settlement transaction must contain 1-256 characters' using errcode = '22023';
  end if;
  select e.* into v_external from money.external_payments e where e.id = p_external_id for update;
  if v_external.id is null then raise exception 'external payment not found' using errcode = 'P0002'; end if;
  if v_external.agent_id <> p_agent_id then
    raise exception 'only the paying agent can confirm this payment' using errcode = '42501';
  end if;
  if v_external.state = 'confirmed' then
    if v_external.settled_tx <> p_settled_tx then
      return query select false, true, v_external.state, v_external.settled_tx,
        'payment was already confirmed with a different transaction';
    else
      return query select true, true, v_external.state, v_external.settled_tx, null::text;
    end if;
    return;
  end if;
  if v_external.state = 'reversed' then
    return query select false, true, v_external.state, null::text,
      'payment was already reversed and cannot be confirmed';
    return;
  end if;
  if v_external.state <> 'pending' then
    return query select false, false, v_external.state, null::text,
      'payment has not been approved and debited';
    return;
  end if;
  if v_external.reverse_after < clock_timestamp() then
    perform money_private.reverse_external_payment(v_external.id);
    return query select false, false, 'reversed', null::text,
      'confirmation arrived after the reversal deadline';
    return;
  end if;
  update money.external_payments e set
    state = 'confirmed', settled_tx = p_settled_tx,
    updated_at = clock_timestamp()
  where e.id = v_external.id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('external.confirmed', v_external.id::text, jsonb_build_object(
    'externalId', v_external.id, 'agentId', v_external.agent_id,
    'settledTx', p_settled_tx, 'settlementNetwork', v_external.settlement_network,
    'amountMicros', v_external.amount_micros::text
  ));
  return query select true, false, 'confirmed', p_settled_tx, null::text;
end;
$$;

revoke all on function money_private.confirm_external_payment(text, uuid, text) from public;

create or replace function money_private.sweep_external_payments(p_limit integer default 100)
returns table (external_id uuid, reversal_transfer_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_result record;
begin
  if p_limit not between 1 and 1000 then
    raise exception 'sweep limit must be between 1 and 1000' using errcode = '22023';
  end if;
  for v_id in
    select e.id from money.external_payments e
    where e.state = 'pending' and e.reverse_after < clock_timestamp()
    order by e.reverse_after, e.id
    limit p_limit
    for update skip locked
  loop
    select * into v_result from money_private.reverse_external_payment(v_id);
    if v_result.reversed then
      external_id := v_result.external_id;
      reversal_transfer_id := v_result.reversal_transfer_id;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function money_private.sweep_external_payments(integer) from public;

-- Mandate revocation/supersession and lazy approval expiry are implemented by
-- older policy functions. Propagate every terminal approval outcome into the
-- external lifecycle immediately, independent of which command caused it.
create or replace function money_private.cancel_external_with_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'pending' and new.status in ('rejected', 'expired', 'failed') then
    update money.external_payments e set
      state = 'cancelled', updated_at = clock_timestamp()
    where e.approval_id = new.id and e.state = 'approval_required';
  end if;
  return new;
end;
$$;

create trigger approvals_cancel_external
after update of status on money.approvals
for each row execute function money_private.cancel_external_with_approval();

create or replace function money_private.protect_external_payment_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.agent_id <> old.agent_id or
     new.host <> old.host or new.pay_to <> old.pay_to or
     new.settlement_asset <> old.settlement_asset or
     new.settlement_network <> old.settlement_network or
     new.resource <> old.resource or
     new.payment_header_ciphertext <> old.payment_header_ciphertext or
     new.idempotency_key <> old.idempotency_key or
     new.policy_payee <> old.policy_payee or
     new.amount_micros <> old.amount_micros or
     new.authorization_hash <> old.authorization_hash or
     new.authorization_expires_at <> old.authorization_expires_at or
     new.reverse_after <> old.reverse_after or
     new.approval_id is distinct from old.approval_id or
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
  if not (
    new.state = old.state or
    (old.state = 'approval_required' and new.state in ('cancelled', 'pending')) or
    (old.state = 'pending' and new.state in ('confirmed', 'reversed'))
  ) then
    raise exception 'invalid external payment state transition % -> %', old.state, new.state using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger external_payments_protect_transition
before update on money.external_payments
for each row execute function money_private.protect_external_payment_transition();

create trigger external_payments_delete_forbidden
before delete on money.external_payments
for each row execute function money_private.forbid_immutable_mutation();

create or replace function money_private.list_external_payments_for_requester(
  p_requester_id text,
  p_limit integer default 50
)
returns table (
  external_id uuid,
  agent_id text,
  state text,
  host text,
  pay_to text,
  settlement_asset text,
  settlement_network text,
  resource text,
  policy_payee text,
  amount_micros bigint,
  transfer_id uuid,
  receipt_id uuid,
  approval_id uuid,
  authorization_expires_at timestamptz,
  reverse_after timestamptz,
  settled_tx text,
  reversal_transfer_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_limit not between 1 and 100 then
    raise exception 'external payment limit must be between 1 and 100' using errcode = '22023';
  end if;
  return query
    select e.id, e.agent_id, e.state, e.host, e.pay_to,
      e.settlement_asset, e.settlement_network, e.resource, e.policy_payee,
      e.amount_micros, debit.id, e.receipt_id, e.approval_id,
      e.authorization_expires_at, e.reverse_after, e.settled_tx,
      reversal.id, e.created_at, e.updated_at
    from money.external_payments e
    join money.accounts agent on agent.id = e.agent_id
    join money.accounts requester on requester.id = p_requester_id and requester.status = 'active'
    left join money.transfers debit on debit.seq = e.transfer_seq
    left join money.transfers reversal on reversal.seq = e.reversal_transfer_seq
    where requester.id = e.agent_id or
      (requester.kind = 'user' and agent.owner_id = requester.id)
    order by e.created_at desc, e.id desc
    limit p_limit;
end;
$$;

revoke all on function money_private.list_external_payments_for_requester(text, integer) from public;

create or replace function money_private.get_external_payment_secret(
  p_agent_id text,
  p_external_id uuid
)
returns setof money.external_payments
language sql
stable
security definer
set search_path = ''
as $$
  select e.* from money.external_payments e
  join money.accounts a on a.id = p_agent_id and a.kind = 'agent' and a.status = 'active'
  where e.id = p_external_id and e.agent_id = p_agent_id
$$;

revoke all on function money_private.get_external_payment_secret(text, uuid) from public;

-- Fast idempotent retries should not ask a remote wallet or HSM to sign a
-- second authorization. The caller still compares every economic term before
-- returning the original header; concurrent first requests remain serialized
-- by request_external_payment's actor-scoped idempotency key.
create or replace function money_private.get_external_payment_secret_by_key(
  p_agent_id text,
  p_idempotency_key text
)
returns setof money.external_payments
language sql
stable
security definer
set search_path = ''
as $$
  select e.* from money.external_payments e
  join money.accounts a on a.id = p_agent_id and a.kind = 'agent' and a.status = 'active'
  where e.agent_id = p_agent_id and e.idempotency_key = p_idempotency_key
$$;

revoke all on function money_private.get_external_payment_secret_by_key(text, text) from public;

create or replace function money_private.is_external_approval(
  p_user_id text,
  p_approval_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1 from money.external_payments e
    join money.accounts agent on agent.id = e.agent_id
    where e.approval_id = p_approval_id and agent.owner_id = p_user_id
  )
$$;

revoke all on function money_private.is_external_approval(text, uuid) from public;

-- Reconcile all three receipt envelopes: historical/internal, refunds, and
-- external debits/reversals whose vendor identity is immutable evidence.
create or replace function money_private.ledger_health()
returns table (zero_sum boolean, receipts_ok boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    not exists (
      select 1 from money.transfers t
      left join money.ledger_entries e on e.transfer_seq = t.seq
      group by t.seq having count(e.*) <> 2 or coalesce(sum(e.amount_micros), 0) <> 0
    ),
    not exists (
      select 1 from money.receipts r
      join money.transfers t on t.seq = r.transfer_seq
      where r.evidence_hash <> public.digest((case
        when t.external_payee is not null then jsonb_build_object(
          'transferId', t.id,
          'actor', t.actor_id,
          'operation', t.operation,
          'from', t.from_account_id,
          'to', t.to_account_id,
          'asset', t.asset_code,
          'amount', t.amount_micros,
          'memo', t.memo,
          'externalPayee', t.external_payee,
          'requestHash', encode(t.request_hash, 'hex')
        )
        when t.refund_of is not null then jsonb_build_object(
          'transferId', t.id,
          'actor', t.actor_id,
          'operation', t.operation,
          'from', t.from_account_id,
          'to', t.to_account_id,
          'asset', t.asset_code,
          'amount', t.amount_micros,
          'memo', t.memo,
          'refundOf', t.refund_of,
          'requestHash', encode(t.request_hash, 'hex')
        )
        else jsonb_build_object(
          'transferId', t.id,
          'actor', t.actor_id,
          'operation', t.operation,
          'from', t.from_account_id,
          'to', t.to_account_id,
          'asset', t.asset_code,
          'amount', t.amount_micros,
          'memo', t.memo,
          'requestHash', encode(t.request_hash, 'hex')
        )
      end)::text, 'sha256')
    ) and not exists (
      select 1
      from money.external_payments e
      left join money.transfers debit on debit.seq = e.transfer_seq
      left join money.receipts receipt on receipt.id = e.receipt_id
      left join money.transfers reversal on reversal.seq = e.reversal_transfer_seq
      left join money.approvals approval on approval.id = e.approval_id
      where
        (e.state <> 'approval_required' and (
          debit.seq is null or receipt.id is null or receipt.transfer_seq <> debit.seq or
          debit.actor_id <> e.agent_id or debit.operation <> 'external_debit' or
          debit.from_account_id <> e.agent_id or debit.to_account_id <> 'external:x402' or
          debit.asset_code <> 'USD' or debit.amount_micros <> e.amount_micros or
          debit.external_payee <> e.policy_payee or
          debit.metadata->>'externalId' <> e.id::text or
          debit.metadata->>'clientIdempotencyKey' <> e.idempotency_key
        )) or
        (e.approval_id is not null and (
          approval.id is null or approval.agent_id <> e.agent_id or
          approval.to_account_id <> 'external:x402' or approval.asset_code <> 'USD' or
          approval.amount_micros <> e.amount_micros
        )) or
        (e.state = 'reversed' and (
          reversal.seq is null or reversal.actor_id <> 'external:x402' or
          reversal.operation <> 'external_reversal' or
          reversal.from_account_id <> 'external:x402' or reversal.to_account_id <> e.agent_id or
          reversal.asset_code <> 'USD' or reversal.amount_micros <> e.amount_micros or
          reversal.external_payee <> e.policy_payee or
          reversal.metadata->>'externalId' <> e.id::text or
          reversal.metadata->>'originalTransferSeq' <> e.transfer_seq::text
        ))
    )
$$;

revoke all on function money_private.ledger_health() from public;
