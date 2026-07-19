-- Atomic mandate policy and durable owner approvals.
-- Lock order for every command is: idempotency key -> account identities
-- (lexical id order) -> mandate -> approval -> balances. Payments for one
-- agent serialize on that agent's account row; unrelated agents proceed in
-- parallel.

alter table money.mandates add column request_hash bytea;

update money.mandates set request_hash = public.digest(jsonb_build_object(
  'userId', user_id,
  'agentId', agent_id,
  'asset', asset_code,
  'budget', budget_micros,
  'perTxCap', per_tx_cap_micros,
  'dailyCap', daily_cap_micros,
  'escalateAbove', escalate_above_micros,
  'newPayeeCap', new_payee_cap_micros,
  'allowlist', payee_allowlist,
  'expiresAt', extract(epoch from expires_at) * 1000000
)::text, 'sha256');

alter table money.mandates alter column request_hash set not null;
alter table money.mandates add constraint mandates_request_hash_length
  check (octet_length(request_hash) = 32);
alter table money.mandates add constraint mandates_spent_today_within_daily_cap
  check (spent_today_micros <= daily_cap_micros);

create table money.transfer_authorizations (
  transfer_seq bigint primary key references money.transfers(seq),
  mandate_id uuid not null references money.mandates(id),
  approval_id uuid references money.approvals(id),
  decision text not null check (decision in ('autonomous', 'human_approved')),
  policy_snapshot jsonb not null check (jsonb_typeof(policy_snapshot) = 'object'),
  evidence_hash bytea not null check (octet_length(evidence_hash) = 32),
  created_at timestamptz not null default clock_timestamp(),
  check (
    (decision = 'autonomous' and approval_id is null) or
    (decision = 'human_approved' and approval_id is not null)
  )
);

create unique index transfer_authorizations_approval_idx
  on money.transfer_authorizations(approval_id)
  where approval_id is not null;

create index transfer_authorizations_mandate_idx
  on money.transfer_authorizations(mandate_id, transfer_seq);

create trigger transfer_authorizations_append_only
before update or delete on money.transfer_authorizations
for each row execute function money_private.forbid_immutable_mutation();

-- One trigger covers every path that can resolve a pending approval: owner
-- action, expiry-on-read, mandate revocation/supersession, policy drift, or a
-- posting failure. Consumers therefore never have to infer terminal state.
create or replace function money_private.emit_approval_status_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transfer_id uuid;
begin
  if old.status = 'pending' and new.status <> old.status then
    if new.receipt_id is not null then
      select t.id into v_transfer_id
      from money.receipts r join money.transfers t on t.seq = r.transfer_seq
      where r.id = new.receipt_id;
    end if;
    insert into money.outbox_events(topic, aggregate_id, payload)
    values ('approval.' || new.status, new.id::text, jsonb_build_object(
      'approvalId', new.id,
      'userId', new.user_id,
      'agentId', new.agent_id,
      'mandateId', new.mandate_id,
      'status', new.status,
      'receiptId', new.receipt_id,
      'transferId', v_transfer_id,
      'reason', new.reason
    ));
  end if;
  return new;
end;
$$;

revoke all on function money_private.emit_approval_status_event() from public;

create trigger approvals_emit_status_event
after update of status on money.approvals
for each row execute function money_private.emit_approval_status_event();

-- Render the current durable outcome of a request_payment idempotency record.
-- Approval commands intentionally keep pointing at the approval row after it
-- resolves; retries therefore observe its final receipt or final denial.
create or replace function money_private.render_payment_command(
  p_command_id bigint,
  p_replayed boolean
)
returns table (
  status text,
  replayed boolean,
  transfer_id uuid,
  receipt_id uuid,
  approval_id uuid,
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
  v_command money.idempotency_keys%rowtype;
  v_approval money.approvals%rowtype;
begin
  select k.* into v_command from money.idempotency_keys k where k.id = p_command_id;
  if v_command.id is null or v_command.state <> 'completed' then
    raise exception 'payment command is missing or incomplete' using errcode = '40001';
  end if;

  if v_command.result_kind = 'denied' then
    return query select
      'denied'::text, p_replayed, null::uuid, null::uuid, null::uuid,
      v_command.result->>'denialCode', v_command.result->>'reason',
      nullif(v_command.result->>'fromBalanceMicros', '')::bigint,
      nullif(v_command.result->>'toBalanceMicros', '')::bigint;
    return;
  end if;

  if v_command.result_kind = 'transfer' then
    return query
      select 'posted'::text, p_replayed, t.id, r.id, null::uuid,
        null::text, null::text, fb.available_micros, tb.available_micros
      from money.transfers t
      join money.receipts r on r.transfer_seq = t.seq
      join money.balances fb on fb.account_id = t.from_account_id and fb.asset_code = t.asset_code
      join money.balances tb on tb.account_id = t.to_account_id and tb.asset_code = t.asset_code
      where t.id::text = v_command.result_id;
    return;
  end if;

  if v_command.result_kind <> 'approval' then
    raise exception 'payment command has unknown result kind %', v_command.result_kind using errcode = 'XX000';
  end if;

  update money.approvals a set
    status = 'expired',
    resolved_at = clock_timestamp(),
    reason = 'approval request expired'
  where a.id::text = v_command.result_id
    and a.status = 'pending'
    and a.expires_at <= clock_timestamp();

  select a.* into v_approval from money.approvals a where a.id::text = v_command.result_id;
  if v_approval.id is null then
    raise exception 'payment command references a missing approval' using errcode = 'XX000';
  end if;

  if v_approval.status = 'pending' then
    return query select
      'approval_required'::text, p_replayed, null::uuid, null::uuid, v_approval.id,
      null::text, null::text, null::bigint, null::bigint;
    return;
  end if;

  if v_approval.status = 'approved' then
    return query
      select 'posted'::text, p_replayed, t.id, r.id, v_approval.id,
        null::text, null::text, fb.available_micros, tb.available_micros
      from money.receipts r
      join money.transfers t on t.seq = r.transfer_seq
      join money.balances fb on fb.account_id = t.from_account_id and fb.asset_code = t.asset_code
      join money.balances tb on tb.account_id = t.to_account_id and tb.asset_code = t.asset_code
      where r.id = v_approval.receipt_id;
    return;
  end if;

  return query select
    'denied'::text, p_replayed, null::uuid, null::uuid, v_approval.id,
    case v_approval.status
      when 'expired' then 'approval_expired'
      when 'failed' then 'approval_failed'
      else 'approval_rejected'
    end,
    coalesce(v_approval.reason, 'approval ' || v_approval.status),
    null::bigint, null::bigint;
end;
$$;

revoke all on function money_private.render_payment_command(bigint, boolean) from public;

create or replace function money_private.commit_transfer_authorization(
  p_transfer_id uuid,
  p_mandate_id uuid,
  p_payee_id text,
  p_amount_micros bigint,
  p_decision text,
  p_approval_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mandate money.mandates%rowtype;
  v_transfer_seq bigint;
  v_today date := (clock_timestamp() at time zone 'utc')::date;
  v_snapshot jsonb;
begin
  select m.* into v_mandate from money.mandates m where m.id = p_mandate_id for update;
  if v_mandate.id is null then raise exception 'authorization mandate missing' using errcode = 'XX000'; end if;
  select t.seq into v_transfer_seq from money.transfers t where t.id = p_transfer_id;
  if v_transfer_seq is null then raise exception 'authorization transfer missing' using errcode = 'XX000'; end if;

  v_snapshot := jsonb_build_object(
    'mandateId', v_mandate.id,
    'userId', v_mandate.user_id,
    'agentId', v_mandate.agent_id,
    'asset', v_mandate.asset_code,
    'budgetMicros', v_mandate.budget_micros::text,
    'spentBeforeMicros', v_mandate.spent_micros::text,
    'dailyCapMicros', v_mandate.daily_cap_micros::text,
    'spentTodayBeforeMicros', case when v_today > v_mandate.spend_day then '0' else v_mandate.spent_today_micros::text end,
    'perTxCapMicros', v_mandate.per_tx_cap_micros::text,
    'escalateAboveMicros', v_mandate.escalate_above_micros::text,
    'newPayeeCapMicros', v_mandate.new_payee_cap_micros::text,
    'payeeId', p_payee_id,
    'amountMicros', p_amount_micros::text,
    'decision', p_decision,
    'approvalId', p_approval_id
  );

  update money.mandates m set
    spent_micros = m.spent_micros + p_amount_micros,
    spent_today_micros = case
      when v_today > m.spend_day then p_amount_micros
      else m.spent_today_micros + p_amount_micros
    end,
    spend_day = greatest(m.spend_day, v_today)
  where m.id = p_mandate_id;

  insert into money.mandate_seen_payees(mandate_id, payee_id)
  values (p_mandate_id, p_payee_id)
  on conflict (mandate_id, payee_id) do nothing;

  insert into money.transfer_authorizations(
    transfer_seq, mandate_id, approval_id, decision, policy_snapshot, evidence_hash
  ) values (
    v_transfer_seq, p_mandate_id, p_approval_id, p_decision, v_snapshot,
    public.digest(jsonb_build_object(
      'transferId', p_transfer_id,
      'policy', v_snapshot
    )::text, 'sha256')
  );

  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('payment.authorized', p_transfer_id::text, jsonb_build_object(
    'transferId', p_transfer_id,
    'mandateId', p_mandate_id,
    'approvalId', p_approval_id,
    'decision', p_decision,
    'amountMicros', p_amount_micros::text
  ));
end;
$$;

revoke all on function money_private.commit_transfer_authorization(uuid, uuid, text, bigint, text, uuid) from public;

create or replace function money_private.grant_mandate(
  p_user_id text,
  p_agent_id text,
  p_asset_code text,
  p_budget_micros bigint,
  p_per_tx_cap_micros bigint,
  p_daily_cap_micros bigint,
  p_escalate_above_micros bigint,
  p_new_payee_cap_micros bigint,
  p_payee_allowlist text[],
  p_expires_at timestamptz,
  p_idempotency_key text
)
returns table (mandate_id uuid, replayed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent money.accounts%rowtype;
  v_prior money.mandates%rowtype;
  v_id uuid;
  v_hash bytea;
  v_allowlist text[];
begin
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key must contain 1-128 characters' using errcode = '22023';
  end if;
  if p_budget_micros < 0 or p_per_tx_cap_micros < 0 or p_daily_cap_micros < 0
    or p_escalate_above_micros < 0 or p_new_payee_cap_micros < 0 then
    raise exception 'mandate limits must be non-negative' using errcode = '22023';
  end if;
  if p_expires_at is null or p_expires_at <= clock_timestamp() then
    raise exception 'mandate expiry must be in the future' using errcode = '22023';
  end if;
  if p_payee_allowlist is not null then
    if exists (select 1 from unnest(p_payee_allowlist) x where x is null or x = '') then
      raise exception 'allowlist entries must be non-empty' using errcode = '22023';
    end if;
    select coalesce(array_agg(distinct x order by x), '{}'::text[]) into v_allowlist
    from unnest(p_payee_allowlist) x;
  end if;

  v_hash := public.digest(jsonb_build_object(
    'userId', p_user_id,
    'agentId', p_agent_id,
    'asset', p_asset_code,
    'budget', p_budget_micros,
    'perTxCap', p_per_tx_cap_micros,
    'dailyCap', p_daily_cap_micros,
    'escalateAbove', p_escalate_above_micros,
    'newPayeeCap', p_new_payee_cap_micros,
    'allowlist', v_allowlist,
    'expiresAt', extract(epoch from p_expires_at) * 1000000
  )::text, 'sha256');

  perform 1 from money.accounts a
  where a.id in (p_user_id, p_agent_id)
  order by a.id for update;
  select a.* into v_agent from money.accounts a where a.id = p_agent_id;
  if v_agent.id is null or v_agent.kind <> 'agent' or v_agent.owner_id <> p_user_id or v_agent.status <> 'active' then
    raise exception 'mandate agent must be active and owned by the signing user' using errcode = '42501';
  end if;
  if not exists (select 1 from money.accounts a where a.id = p_user_id and a.kind = 'user' and a.status = 'active') then
    raise exception 'mandate owner must be an active user' using errcode = '42501';
  end if;
  if not exists (select 1 from money.assets a where a.code = p_asset_code and a.enabled) then
    raise exception 'mandate asset is not enabled' using errcode = '22023';
  end if;

  select m.* into v_prior from money.mandates m
  where m.user_id = p_user_id and m.idempotency_key = p_idempotency_key
  for update;
  if v_prior.id is not null then
    if v_prior.request_hash <> v_hash then
      raise exception 'mandate idempotency key reused with different terms' using errcode = '23505';
    end if;
    return query select v_prior.id, true;
    return;
  end if;

  with superseded as (
    update money.mandates m set revoked_at = clock_timestamp()
    where m.agent_id = p_agent_id and m.asset_code = p_asset_code and m.revoked_at is null
    returning m.id
  )
  update money.approvals a set
    status = 'failed', resolved_at = clock_timestamp(), reason = 'mandate superseded by owner'
  where a.status = 'pending' and a.mandate_id in (select id from superseded);

  insert into money.mandates(
    user_id, agent_id, asset_code, budget_micros, per_tx_cap_micros,
    daily_cap_micros, escalate_above_micros, new_payee_cap_micros,
    payee_allowlist, expires_at, idempotency_key, request_hash
  ) values (
    p_user_id, p_agent_id, p_asset_code, p_budget_micros, p_per_tx_cap_micros,
    p_daily_cap_micros, p_escalate_above_micros, p_new_payee_cap_micros,
    v_allowlist, p_expires_at, p_idempotency_key, v_hash
  ) returning id into v_id;

  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('mandate.granted', v_id::text, jsonb_build_object(
    'mandateId', v_id, 'userId', p_user_id, 'agentId', p_agent_id,
    'asset', p_asset_code, 'budgetMicros', p_budget_micros::text
  ));
  return query select v_id, false;
end;
$$;

revoke all on function money_private.grant_mandate(text, text, text, bigint, bigint, bigint, bigint, bigint, text[], timestamptz, text) from public;

create or replace function money_private.revoke_mandate(p_user_id text, p_mandate_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_agent_id text;
  v_changed boolean;
begin
  select m.agent_id into v_agent_id from money.mandates m where m.id = p_mandate_id;
  if v_agent_id is null then raise exception 'unknown mandate' using errcode = 'P0002'; end if;
  perform 1 from money.accounts a where a.id in (p_user_id, v_agent_id) order by a.id for update;
  if not exists (select 1 from money.mandates m where m.id = p_mandate_id and m.user_id = p_user_id) then
    raise exception 'mandate belongs to another owner' using errcode = '42501';
  end if;
  update money.mandates m set revoked_at = coalesce(m.revoked_at, clock_timestamp())
  where m.id = p_mandate_id and m.revoked_at is null;
  v_changed := found;
  if v_changed then
    update money.approvals a set
      status = 'failed', resolved_at = clock_timestamp(), reason = 'mandate revoked by owner'
    where a.mandate_id = p_mandate_id and a.status = 'pending';
    insert into money.outbox_events(topic, aggregate_id, payload)
    values ('mandate.revoked', p_mandate_id::text, jsonb_build_object('mandateId', p_mandate_id, 'userId', p_user_id));
  end if;
  return v_changed;
end;
$$;

revoke all on function money_private.revoke_mandate(text, uuid) from public;

create or replace function money_private.request_agent_payment(
  p_agent_id text,
  p_idempotency_key text,
  p_to_account_id text,
  p_asset_code text,
  p_amount_micros bigint,
  p_memo text default ''
)
returns table (
  status text,
  replayed boolean,
  transfer_id uuid,
  receipt_id uuid,
  approval_id uuid,
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
  v_agent money.accounts%rowtype;
  v_payee money.accounts%rowtype;
  v_mandate money.mandates%rowtype;
  v_today date := (clock_timestamp() at time zone 'utc')::date;
  v_spent_today bigint;
  v_seen boolean;
  v_trusted boolean;
  v_approval money.approvals%rowtype;
  v_recent money.approvals%rowtype;
  v_pending_count integer;
  v_post record;
  v_post_key text;
  v_result jsonb;
begin
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key must contain 1-128 characters' using errcode = '22023';
  end if;
  if p_amount_micros is null or p_amount_micros <= 0 then
    raise exception 'amount must be positive integer micros' using errcode = '22023';
  end if;
  if p_memo is null or char_length(p_memo) > 500 then
    raise exception 'memo must contain at most 500 characters' using errcode = '22023';
  end if;

  v_hash := public.digest(jsonb_build_object(
    'agentId', p_agent_id, 'to', p_to_account_id, 'asset', p_asset_code,
    'amount', p_amount_micros, 'memo', p_memo
  )::text, 'sha256');

  insert into money.idempotency_keys(actor_id, operation, idempotency_key, request_hash)
  values (p_agent_id, 'request_payment', p_idempotency_key, v_hash)
  on conflict (actor_id, operation, idempotency_key) do nothing
  returning id into v_key_id;

  if v_key_id is null then
    select k.* into v_prior from money.idempotency_keys k
    where k.actor_id = p_agent_id and k.operation = 'request_payment' and k.idempotency_key = p_idempotency_key
    for update;
    if v_prior.request_hash <> v_hash then
      return query select 'denied'::text, true, null::uuid, null::uuid, null::uuid,
        'idempotency_conflict'::text, 'idempotency key was reused with different payment terms'::text,
        null::bigint, null::bigint;
      return;
    end if;
    return query select * from money_private.render_payment_command(v_prior.id, true);
    return;
  end if;

  perform 1 from money.accounts a
  where a.id in (p_agent_id, p_to_account_id)
  order by a.id for update;
  select a.* into v_agent from money.accounts a where a.id = p_agent_id;
  select a.* into v_payee from money.accounts a where a.id = p_to_account_id;
  if v_agent.id is null or v_agent.kind <> 'agent' or v_agent.status <> 'active' then
    raise exception 'paying agent is unknown or inactive' using errcode = '42501';
  end if;
  if v_payee.id is null or v_payee.kind = 'external' or v_payee.status <> 'active' or v_payee.id = v_agent.id then
    raise exception 'payee must be a distinct active internal account' using errcode = '22023';
  end if;

  update money.approvals a set
    status = 'expired', resolved_at = clock_timestamp(), reason = 'approval request expired'
  where a.agent_id = p_agent_id and a.status = 'pending' and a.expires_at <= clock_timestamp();

  select m.* into v_mandate from money.mandates m
  where m.agent_id = p_agent_id and m.asset_code = p_asset_code and m.revoked_at is null
  order by m.created_at desc limit 1 for update;

  if v_mandate.id is null then
    v_result := jsonb_build_object('denialCode', 'no_mandate', 'reason', 'agent has no active mandate for this asset');
  elsif clock_timestamp() > v_mandate.expires_at then
    v_result := jsonb_build_object('denialCode', 'expired', 'reason', 'mandate has expired');
  elsif v_mandate.payee_allowlist is not null and not (p_to_account_id = any(v_mandate.payee_allowlist)) then
    v_result := jsonb_build_object('denialCode', 'payee_not_allowed', 'reason', 'payee is not on the mandate allowlist');
  elsif v_mandate.spent_micros + p_amount_micros > v_mandate.budget_micros then
    v_result := jsonb_build_object('denialCode', 'budget', 'reason', 'payment would exceed the total mandate budget');
  else
    v_spent_today := case when v_today > v_mandate.spend_day then 0 else v_mandate.spent_today_micros end;
    if v_spent_today + p_amount_micros > v_mandate.daily_cap_micros then
      v_result := jsonb_build_object('denialCode', 'daily_cap', 'reason', 'payment would exceed the mandate daily cap');
    end if;
  end if;

  if v_result is not null then
    update money.idempotency_keys k set state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
    where k.id = v_key_id;
    return query select * from money_private.render_payment_command(v_key_id, false);
    return;
  end if;

  if p_amount_micros > v_mandate.escalate_above_micros then
    select a.* into v_approval from money.approvals a
    where a.agent_id = p_agent_id and a.to_account_id = p_to_account_id
      and a.asset_code = p_asset_code and a.amount_micros = p_amount_micros
      and a.memo = p_memo and a.status = 'pending'
    order by a.created_at desc limit 1;
    if v_approval.id is null then
      select a.* into v_recent from money.approvals a
      where a.agent_id = p_agent_id and a.to_account_id = p_to_account_id
        and a.asset_code = p_asset_code and a.amount_micros = p_amount_micros
        and a.memo = p_memo and a.status in ('rejected', 'failed', 'expired')
        and a.resolved_at > clock_timestamp() - interval '5 minutes'
      order by a.resolved_at desc limit 1;
      if v_recent.id is not null then
        v_result := jsonb_build_object(
          'denialCode', case when v_recent.status = 'expired' then 'approval_expired' else 'approval_rejected' end,
          'reason', coalesce(v_recent.reason, 'matching approval was recently resolved') || ' (5 minute cooldown)'
        );
        update money.idempotency_keys k set state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
        where k.id = v_key_id;
        return query select * from money_private.render_payment_command(v_key_id, false);
        return;
      end if;
      select count(*) into v_pending_count from money.approvals a where a.agent_id = p_agent_id and a.status = 'pending';
      if v_pending_count >= 20 then
        v_result := jsonb_build_object('denialCode', 'approval_limit', 'reason', 'agent already has 20 pending approvals');
        update money.idempotency_keys k set state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
        where k.id = v_key_id;
        return query select * from money_private.render_payment_command(v_key_id, false);
        return;
      end if;
      insert into money.approvals(
        user_id, mandate_id, agent_id, to_account_id, asset_code,
        amount_micros, memo, idempotency_key, expires_at
      ) values (
        v_mandate.user_id, v_mandate.id, p_agent_id, p_to_account_id, p_asset_code,
        p_amount_micros, p_memo, p_idempotency_key,
        least(clock_timestamp() + interval '24 hours', v_mandate.expires_at)
      ) returning * into v_approval;
      insert into money.outbox_events(topic, aggregate_id, payload)
      values ('approval.requested', v_approval.id::text, jsonb_build_object(
        'approvalId', v_approval.id, 'userId', v_approval.user_id,
        'agentId', p_agent_id, 'to', p_to_account_id,
        'asset', p_asset_code, 'amountMicros', p_amount_micros::text
      ));
    end if;
    update money.idempotency_keys k set
      state = 'completed', result_kind = 'approval', result_id = v_approval.id::text,
      result = jsonb_build_object('approvalId', v_approval.id), completed_at = clock_timestamp()
    where k.id = v_key_id;
    return query select * from money_private.render_payment_command(v_key_id, v_approval.idempotency_key <> p_idempotency_key);
    return;
  end if;

  if p_amount_micros > v_mandate.per_tx_cap_micros then
    v_result := jsonb_build_object('denialCode', 'per_tx_cap', 'reason', 'payment exceeds the mandate per-transaction cap');
  else
    select exists(
      select 1 from money.mandate_seen_payees s where s.mandate_id = v_mandate.id and s.payee_id = p_to_account_id
    ) into v_seen;
    v_trusted := v_payee.id = v_mandate.user_id or v_payee.owner_id = v_mandate.user_id;
    if not v_seen and not v_trusted and p_amount_micros > v_mandate.new_payee_cap_micros then
      v_result := jsonb_build_object('denialCode', 'new_payee_cap', 'reason', 'first payment to this payee exceeds the new-payee cap');
    end if;
  end if;

  if v_result is not null then
    update money.idempotency_keys k set state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
    where k.id = v_key_id;
    return query select * from money_private.render_payment_command(v_key_id, false);
    return;
  end if;

  v_post_key := encode(public.digest((p_agent_id || ':' || p_idempotency_key)::text, 'sha256'), 'hex');
  select * into v_post from money_private.post_transfer(
    p_agent_id, 'pay', v_post_key, p_agent_id, p_to_account_id,
    p_asset_code, p_amount_micros, p_memo,
    jsonb_build_object('mandateId', v_mandate.id, 'clientIdempotencyKey', p_idempotency_key)
  );
  if v_post.status = 'denied' then
    v_result := jsonb_build_object(
      'denialCode', v_post.denial_code, 'reason', v_post.reason,
      'fromBalanceMicros', v_post.from_balance_micros, 'toBalanceMicros', v_post.to_balance_micros
    );
    update money.idempotency_keys k set state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
    where k.id = v_key_id;
    return query select * from money_private.render_payment_command(v_key_id, false);
    return;
  end if;

  perform money_private.commit_transfer_authorization(
    v_post.transfer_id, v_mandate.id, p_to_account_id, p_amount_micros, 'autonomous', null
  );
  update money.idempotency_keys k set
    state = 'completed', result_kind = 'transfer', result_id = v_post.transfer_id::text,
    result = jsonb_build_object('transferId', v_post.transfer_id, 'receiptId', v_post.receipt_id),
    completed_at = clock_timestamp()
  where k.id = v_key_id;
  return query select * from money_private.render_payment_command(v_key_id, false);
end;
$$;

revoke all on function money_private.request_agent_payment(text, text, text, text, bigint, text) from public;

create or replace function money_private.resolve_approval(
  p_user_id text,
  p_approval_id uuid,
  p_action text,
  p_reason text default null
)
returns table (
  status text,
  replayed boolean,
  transfer_id uuid,
  receipt_id uuid,
  approval_id uuid,
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
  v_hint money.approvals%rowtype;
  v_approval money.approvals%rowtype;
  v_mandate money.mandates%rowtype;
  v_command_id bigint;
  v_today date := (clock_timestamp() at time zone 'utc')::date;
  v_spent_today bigint;
  v_post record;
  v_post_key text;
begin
  if p_action not in ('approve', 'reject') then raise exception 'action must be approve or reject' using errcode = '22023'; end if;
  if p_reason is not null and char_length(p_reason) > 500 then raise exception 'reason is too long' using errcode = '22023'; end if;
  select a.* into v_hint from money.approvals a where a.id = p_approval_id;
  if v_hint.id is null then raise exception 'unknown approval' using errcode = 'P0002'; end if;
  perform 1 from money.accounts a
  where a.id in (p_user_id, v_hint.agent_id, v_hint.to_account_id)
  order by a.id for update;
  select a.* into v_approval from money.approvals a where a.id = p_approval_id for update;
  if v_approval.user_id <> p_user_id then raise exception 'approval belongs to another owner' using errcode = '42501'; end if;
  select k.id into v_command_id from money.idempotency_keys k
  where k.actor_id = v_approval.agent_id and k.operation = 'request_payment'
    and k.idempotency_key = v_approval.idempotency_key;
  if v_command_id is null then raise exception 'approval command is missing' using errcode = 'XX000'; end if;

  if v_approval.status = 'pending' and v_approval.expires_at <= clock_timestamp() then
    update money.approvals a set status = 'expired', resolved_at = clock_timestamp(), reason = 'approval request expired'
    where a.id = p_approval_id;
    return query select * from money_private.render_payment_command(v_command_id, true);
    return;
  end if;
  if v_approval.status <> 'pending' then
    return query select * from money_private.render_payment_command(v_command_id, true);
    return;
  end if;
  if p_action = 'reject' then
    update money.approvals a set
      status = 'rejected', resolved_at = clock_timestamp(), reason = coalesce(nullif(p_reason, ''), 'rejected by owner')
    where a.id = p_approval_id;
    return query select * from money_private.render_payment_command(v_command_id, false);
    return;
  end if;

  select m.* into v_mandate from money.mandates m where m.id = v_approval.mandate_id for update;
  if v_mandate.id is null or v_mandate.user_id <> p_user_id or v_mandate.agent_id <> v_approval.agent_id then
    p_reason := 'approval mandate is missing or mismatched';
  elsif v_mandate.revoked_at is not null then
    p_reason := 'mandate was revoked before approval';
  elsif clock_timestamp() > v_mandate.expires_at then
    p_reason := 'mandate expired before approval';
  elsif v_mandate.payee_allowlist is not null and not (v_approval.to_account_id = any(v_mandate.payee_allowlist)) then
    p_reason := 'payee is no longer allowed by the mandate';
  elsif v_mandate.spent_micros + v_approval.amount_micros > v_mandate.budget_micros then
    p_reason := 'approval would exceed the remaining mandate budget';
  else
    v_spent_today := case when v_today > v_mandate.spend_day then 0 else v_mandate.spent_today_micros end;
    if v_spent_today + v_approval.amount_micros > v_mandate.daily_cap_micros then
      p_reason := 'approval would exceed the remaining daily cap';
    else
      p_reason := null;
    end if;
  end if;
  if p_reason is not null then
    update money.approvals a set status = 'failed', resolved_at = clock_timestamp(), reason = left(p_reason, 500)
    where a.id = p_approval_id;
    return query select * from money_private.render_payment_command(v_command_id, false);
    return;
  end if;

  v_post_key := encode(public.digest((v_approval.agent_id || ':' || v_approval.idempotency_key)::text, 'sha256'), 'hex');
  select * into v_post from money_private.post_transfer(
    v_approval.agent_id, 'pay', v_post_key, v_approval.agent_id, v_approval.to_account_id,
    v_approval.asset_code, v_approval.amount_micros, v_approval.memo,
    jsonb_build_object('mandateId', v_mandate.id, 'approvalId', v_approval.id, 'clientIdempotencyKey', v_approval.idempotency_key)
  );
  if v_post.status = 'denied' then
    update money.approvals a set
      status = 'failed', resolved_at = clock_timestamp(), reason = left(coalesce(v_post.reason, 'payment failed'), 500)
    where a.id = p_approval_id;
    return query select * from money_private.render_payment_command(v_command_id, false);
    return;
  end if;

  perform money_private.commit_transfer_authorization(
    v_post.transfer_id, v_mandate.id, v_approval.to_account_id,
    v_approval.amount_micros, 'human_approved', v_approval.id
  );
  update money.approvals a set
    status = 'approved', resolved_at = clock_timestamp(), receipt_id = v_post.receipt_id, reason = null
  where a.id = p_approval_id;
  return query select * from money_private.render_payment_command(v_command_id, false);
end;
$$;

revoke all on function money_private.resolve_approval(text, uuid, text, text) from public;

-- Tenant-scoped reads keep the shared application role away from direct table
-- SELECT. The signed API supplies the authenticated requester id; these
-- functions then constrain every row to that owner or agent.
create or replace function money_private.get_mandate(
  p_requester_id text,
  p_mandate_id uuid
)
returns setof money.mandates
language sql
stable
security definer
set search_path = ''
as $$
  select m.* from money.mandates m
  where m.id = p_mandate_id
    and p_requester_id in (m.user_id, m.agent_id)
$$;

revoke all on function money_private.get_mandate(text, uuid) from public;

create or replace function money_private.get_approval(
  p_requester_id text,
  p_approval_id uuid
)
returns setof money.approvals
language sql
stable
security definer
set search_path = ''
as $$
  select a.* from money.approvals a
  where a.id = p_approval_id
    and p_requester_id in (a.user_id, a.agent_id)
$$;

revoke all on function money_private.get_approval(text, uuid) from public;

create or replace function money_private.list_approvals(
  p_requester_id text,
  p_status text default null,
  p_limit integer default 100
)
returns setof money.approvals
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected', 'expired', 'failed') then
    raise exception 'invalid approval status' using errcode = '22023';
  end if;
  if p_limit not between 1 and 500 then
    raise exception 'approval list limit must be between 1 and 500' using errcode = '22023';
  end if;
  return query
    select a.* from money.approvals a
    where p_requester_id in (a.user_id, a.agent_id)
      and (p_status is null or a.status = p_status)
    order by a.created_at desc, a.id desc
    limit p_limit;
end;
$$;

revoke all on function money_private.list_approvals(text, text, integer) from public;

create or replace function money_private.list_mandates(
  p_requester_id text,
  p_limit integer default 100
)
returns setof money.mandates
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_limit not between 1 and 500 then
    raise exception 'mandate list limit must be between 1 and 500' using errcode = '22023';
  end if;
  return query
    select m.* from money.mandates m
    where p_requester_id in (m.user_id, m.agent_id)
    order by m.created_at desc, m.id desc
    limit p_limit;
end;
$$;

revoke all on function money_private.list_mandates(text, integer) from public;

comment on function money_private.request_agent_payment(text, text, text, text, bigint, text)
is 'Atomic policy evaluation plus posting. This is the only agent-payment function granted to the application role.';
