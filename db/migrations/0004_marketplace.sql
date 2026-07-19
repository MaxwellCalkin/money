-- Durable two-sided marketplace.
--
-- Registered service terms are the authority for every challenge. Challenge
-- payment, human-approval binding, single-use redemption, and cumulative
-- refunds are serialized in Postgres so retries and API replicas cannot
-- double-charge, double-serve, or over-refund.

alter table money.challenges
  add column claimed_by text references money.accounts(id),
  add column claimed_at timestamptz;

update money.challenges
set claimed_by = paid_by,
    claimed_at = created_at
where paid_by is not null;

alter table money.challenges
  add constraint challenges_claim_pair_check
    check ((claimed_by is null) = (claimed_at is null)),
  add constraint challenges_paid_claim_check
    check (paid_by is null or paid_by = claimed_by);

create index challenges_claimed_created_idx
  on money.challenges(claimed_by, created_at desc)
  where claimed_by is not null;
create index challenges_service_created_idx
  on money.challenges(service_id, created_at desc)
  where service_id is not null;
create index challenges_provider_unpaid_expiry_idx
  on money.challenges(provider_id, expires_at)
  where receipt_id is null;
create index services_active_created_idx
  on money.services(created_at desc, id desc)
  where active;

-- One posting kernel owns every journal mutation. The original public shape
-- remains as a wrapper; the internal kernel adds receipt-bound refunds without
-- creating a second implementation of balance and receipt invariants.
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

  -- Preserve the exact pre-v0.7 hash shape for every non-refund command. This
  -- keeps idempotent retries made before the migration replayable afterward.
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

  insert into money.idempotency_keys (
    actor_id, operation, idempotency_key, request_hash
  ) values (
    p_actor_id, p_operation, p_idempotency_key, v_hash
  )
  on conflict (actor_id, operation, idempotency_key) do nothing
  returning id into v_key_id;

  if v_key_id is null then
    select * into v_prior
    from money.idempotency_keys
    where actor_id = p_actor_id
      and operation = p_operation
      and idempotency_key = p_idempotency_key
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

  -- Every path takes identity and balance locks in lexical account order.
  perform 1 from money.accounts
  where id in (p_from_account_id, p_to_account_id)
  order by id
  for update;

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
  elsif p_operation not in ('pay', 'allocate', 'fund', 'refund') then
    raise exception 'unsupported transfer operation' using errcode = '22023';
  end if;

  if p_operation = 'refund' then
    -- Lock the immutable original receipt. All refunds for one purchase now
    -- serialize before the cumulative cap is checked.
    perform 1 from money.receipts r where r.id = p_refund_of for update;
    select t.* into v_original
    from money.receipts r
    join money.transfers t on t.seq = r.transfer_seq
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

  insert into money.balances (account_id, asset_code)
  select account_id, p_asset_code
  from unnest(array[p_from_account_id, p_to_account_id]) as pending(account_id)
  order by account_id
  on conflict (account_id, asset_code) do nothing;

  perform 1 from money.balances
  where asset_code = p_asset_code and account_id in (p_from_account_id, p_to_account_id)
  order by account_id
  for update;

  select available_micros into v_from_balance
  from money.balances where account_id = p_from_account_id and asset_code = p_asset_code;
  select available_micros into v_to_balance
  from money.balances where account_id = p_to_account_id and asset_code = p_asset_code;

  if v_from.kind <> 'external' and v_from_balance < p_amount_micros then
    v_result := jsonb_build_object(
      'denialCode', 'insufficient_funds',
      'reason', 'insufficient available balance',
      'fromBalanceMicros', v_from_balance,
      'toBalanceMicros', v_to_balance
    );
    update money.idempotency_keys set
      state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
    where id = v_key_id;
    return query select 'denied', false, null::uuid, null::uuid,
      'insufficient_funds', 'insufficient available balance', v_from_balance, v_to_balance;
    return;
  end if;

  insert into money.transfers (
    actor_id, operation, idempotency_key, request_hash,
    from_account_id, to_account_id, asset_code, amount_micros,
    memo, refund_of, metadata
  ) values (
    p_actor_id, p_operation, p_idempotency_key, v_hash,
    p_from_account_id, p_to_account_id, p_asset_code, p_amount_micros,
    p_memo, p_refund_of, p_metadata
  ) returning seq, id into v_transfer_seq, v_transfer_id;

  insert into money.ledger_entries (transfer_seq, account_id, asset_code, amount_micros)
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

  insert into money.receipts (transfer_seq, evidence_hash)
  values (
    v_transfer_seq,
    public.digest((case when p_refund_of is null then
      jsonb_build_object(
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
    else
      jsonb_build_object(
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
    end)::text, 'sha256')
  ) returning id into v_receipt_id;

  insert into money.outbox_events (topic, aggregate_id, payload)
  values (
    case when p_operation = 'refund' then 'refund.posted' else 'transfer.posted' end,
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
      'refundOf', p_refund_of
    )
  );

  update money.idempotency_keys set
    state = 'completed',
    result_kind = 'transfer',
    result_id = v_transfer_id::text,
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

create or replace function money_private.post_transfer(
  p_actor_id text,
  p_operation text,
  p_idempotency_key text,
  p_from_account_id text,
  p_to_account_id text,
  p_asset_code text,
  p_amount_micros bigint,
  p_memo text default '',
  p_metadata jsonb default '{}'::jsonb
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
language sql
security definer
set search_path = ''
as $$
  select * from money_private.post_transfer_kernel(
    p_actor_id, p_operation, p_idempotency_key,
    p_from_account_id, p_to_account_id, p_asset_code,
    p_amount_micros, p_memo, p_metadata, null
  )
$$;

revoke all on function money_private.post_transfer(
  text, text, text, text, text, text, bigint, text, jsonb
) from public;

create or replace function money_private.register_service(
  p_provider_id text,
  p_slug text,
  p_name text,
  p_description text,
  p_endpoint_url text,
  p_asset_code text,
  p_price_micros bigint,
  p_idempotency_key text
)
returns table (
  id uuid,
  provider_id text,
  slug text,
  name text,
  description text,
  endpoint_url text,
  asset_code text,
  price_micros bigint,
  active boolean,
  created_at timestamptz,
  updated_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider money.accounts%rowtype;
  v_service money.services%rowtype;
  v_inserted boolean := false;
  v_slug text := lower(p_slug);
begin
  if v_slug is null or v_slug !~ '^[a-z][a-z0-9-]{1,47}$' then
    raise exception 'invalid service slug' using errcode = '22023';
  end if;
  if p_name is null or char_length(p_name) not between 1 and 200 or
     p_description is null or char_length(p_description) > 2000 or
     p_endpoint_url is null or char_length(p_endpoint_url) not between 1 and 2048 or
     p_price_micros is null or p_price_micros <= 0 or
     p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid service terms' using errcode = '22023';
  end if;

  select a.* into v_provider from money.accounts a where a.id = p_provider_id for update;
  if v_provider.id is null or v_provider.kind <> 'provider' or v_provider.status <> 'active' or
     v_provider.owner_id is null or v_provider.public_key is null or v_provider.handle is null then
    raise exception 'service provider must be active, owned, keyed, and have a handle' using errcode = '42501';
  end if;

  insert into money.services(
    provider_id, slug, name, description, endpoint_url,
    asset_code, price_micros, idempotency_key
  ) values (
    p_provider_id, v_slug, p_name, p_description, p_endpoint_url,
    p_asset_code, p_price_micros, p_idempotency_key
  )
  on conflict on constraint services_provider_id_idempotency_key_key do nothing
  returning * into v_service;
  v_inserted := v_service.id is not null;

  if not v_inserted then
    select s.* into v_service from money.services s
    where s.provider_id = p_provider_id and s.idempotency_key = p_idempotency_key
    for update;
    if v_service.id is null or v_service.slug <> v_slug or
       v_service.name <> p_name or v_service.description <> p_description or
       v_service.endpoint_url <> p_endpoint_url or v_service.asset_code <> p_asset_code or
       v_service.price_micros <> p_price_micros then
      raise exception 'service idempotency key was reused with different terms' using errcode = '23505';
    end if;
  else
    insert into money.outbox_events(topic, aggregate_id, payload)
    values ('service.registered', v_service.id::text, jsonb_build_object(
      'serviceId', v_service.id,
      'providerId', v_service.provider_id,
      'slug', v_service.slug,
      'asset', v_service.asset_code,
      'priceMicros', v_service.price_micros::text
    ));
  end if;

  return query select
    v_service.id, v_service.provider_id, v_service.slug, v_service.name,
    v_service.description, v_service.endpoint_url, v_service.asset_code,
    v_service.price_micros, v_service.active, v_service.created_at,
    v_service.updated_at, not v_inserted;
end;
$$;

revoke all on function money_private.register_service(
  text, text, text, text, text, text, bigint, text
) from public;

create or replace function money_private.set_service_active(
  p_provider_id text,
  p_service_id uuid,
  p_active boolean
)
returns table (service_id uuid, active boolean, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service money.services%rowtype;
  v_changed boolean;
begin
  select s.* into v_service from money.services s where s.id = p_service_id for update;
  if v_service.id is null then raise exception 'service not found' using errcode = 'P0002'; end if;
  if v_service.provider_id <> p_provider_id then
    raise exception 'service belongs to another provider' using errcode = '42501';
  end if;
  v_changed := v_service.active <> p_active;
  if v_changed then
    update money.services s set active = p_active, updated_at = clock_timestamp()
    where s.id = p_service_id;
    insert into money.outbox_events(topic, aggregate_id, payload)
    values ('service.status_changed', p_service_id::text, jsonb_build_object(
      'serviceId', p_service_id, 'providerId', p_provider_id, 'active', p_active
    ));
  end if;
  return query select p_service_id, p_active, v_changed;
end;
$$;

revoke all on function money_private.set_service_active(text, uuid, boolean) from public;

create or replace function money_private.list_public_services(
  p_limit integer default 50,
  p_before_created timestamptz default null,
  p_before_id uuid default null
)
returns setof money.services
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_limit not between 1 and 100 then
    raise exception 'service page size must be between 1 and 100' using errcode = '22023';
  end if;
  if (p_before_created is null) <> (p_before_id is null) then
    raise exception 'service cursor requires both timestamp and id' using errcode = '22023';
  end if;
  return query
    select s.* from money.services s
    join money.accounts a on a.id = s.provider_id
    where s.active and a.status = 'active'
      and (p_before_created is null or (s.created_at, s.id) < (p_before_created, p_before_id))
    order by s.created_at desc, s.id desc
    limit p_limit;
end;
$$;

revoke all on function money_private.list_public_services(integer, timestamptz, uuid) from public;

create or replace function money_private.get_public_service(p_reference text)
returns setof money.services
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_handle text;
  v_slug text;
begin
  if p_reference like '@%/%' then
    v_handle := lower(split_part(substring(p_reference from 2), '/', 1));
    v_slug := lower(split_part(substring(p_reference from 2), '/', 2));
    return query
      select s.* from money.services s
      join money.accounts a on a.id = s.provider_id
      where a.handle = v_handle and a.status = 'active'
        and s.slug = v_slug and s.active;
    return;
  end if;
  begin
    v_id := p_reference::uuid;
  exception when invalid_text_representation then
    return;
  end;
  return query
    select s.* from money.services s
    join money.accounts a on a.id = s.provider_id
    where s.id = v_id and s.active and a.status = 'active';
end;
$$;

revoke all on function money_private.get_public_service(text) from public;

create or replace function money_private.create_service_challenge(
  p_provider_id text,
  p_service_id uuid
)
returns setof money.challenges
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service money.services%rowtype;
  v_challenge money.challenges%rowtype;
begin
  select s.* into v_service from money.services s where s.id = p_service_id for key share;
  if v_service.id is null or not v_service.active then
    raise exception 'service not found or inactive' using errcode = 'P0002';
  end if;
  if v_service.provider_id <> p_provider_id then
    raise exception 'service belongs to another provider' using errcode = '42501';
  end if;
  if not exists (
    select 1 from money.accounts a
    where a.id = p_provider_id and a.kind = 'provider' and a.status = 'active'
  ) then
    raise exception 'provider is inactive' using errcode = '42501';
  end if;

  -- Bound cleanup work per request. Paid rows remain durable; only stale,
  -- never-paid anonymous offers are discarded.
  delete from money.challenges c
  where c.id in (
    select stale.id from money.challenges stale
    where stale.provider_id = p_provider_id
      and stale.receipt_id is null
      and stale.expires_at < clock_timestamp() - interval '1 hour'
    order by stale.expires_at
    limit 500
    for update skip locked
  );

  insert into money.challenges(
    provider_id, service_id, asset_code, amount_micros, resource, expires_at
  ) values (
    p_provider_id, p_service_id, v_service.asset_code,
    v_service.price_micros, v_service.endpoint_url,
    clock_timestamp() + interval '10 minutes'
  ) returning * into v_challenge;

  return next v_challenge;
end;
$$;

revoke all on function money_private.create_service_challenge(text, uuid) from public;

create or replace function money_private.request_challenge_payment(
  p_agent_id text,
  p_challenge_id uuid
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
  v_challenge money.challenges%rowtype;
  v_payment record;
  v_key text;
  v_changed boolean;
begin
  select c.* into v_challenge from money.challenges c where c.id = p_challenge_id for update;
  if v_challenge.id is null then
    return query select 'denied', false, null::uuid, null::uuid, null::uuid,
      'challenge_invalid', 'challenge not found', null::bigint, null::bigint;
    return;
  end if;
  if v_challenge.claimed_by is not null and v_challenge.claimed_by <> p_agent_id then
    return query select 'denied', true, null::uuid, null::uuid, null::uuid,
      'challenge_invalid', 'challenge is already bound to another agent', null::bigint, null::bigint;
    return;
  end if;
  -- Paid retries win over expiry so a lost HTTP response never strands money.
  if v_challenge.receipt_id is null and v_challenge.expires_at <= clock_timestamp() then
    return query select 'denied', false, null::uuid, null::uuid, null::uuid,
      'challenge_invalid', 'challenge expired', null::bigint, null::bigint;
    return;
  end if;

  v_key := 'chl_' || v_challenge.id::text;
  select * into v_payment from money_private.request_agent_payment(
    p_agent_id, v_key, v_challenge.provider_id, v_challenge.asset_code,
    v_challenge.amount_micros, '402:' || v_challenge.resource
  );

  if v_payment.status = 'approval_required' then
    v_changed := v_challenge.claimed_by is null;
    update money.challenges c set
      claimed_by = p_agent_id,
      claimed_at = coalesce(c.claimed_at, clock_timestamp())
    where c.id = p_challenge_id;
    update money.approvals a set expires_at = least(a.expires_at, v_challenge.expires_at)
    where a.id = v_payment.approval_id and a.status = 'pending';
    if v_changed then
      insert into money.outbox_events(topic, aggregate_id, payload)
      values ('challenge.claimed', p_challenge_id::text, jsonb_build_object(
        'challengeId', p_challenge_id, 'agentId', p_agent_id,
        'approvalId', v_payment.approval_id
      ));
    end if;
  elsif v_payment.status = 'posted' then
    if not exists (
      select 1 from money.receipts r
      join money.transfers t on t.seq = r.transfer_seq
      where r.id = v_payment.receipt_id
        and t.from_account_id = p_agent_id
        and t.to_account_id = v_challenge.provider_id
        and t.asset_code = v_challenge.asset_code
        and t.amount_micros = v_challenge.amount_micros
    ) then
      raise exception 'challenge payment evidence mismatch' using errcode = 'XX000';
    end if;
    v_changed := v_challenge.receipt_id is null;
    update money.challenges c set
      claimed_by = p_agent_id,
      claimed_at = coalesce(c.claimed_at, clock_timestamp()),
      paid_by = p_agent_id,
      receipt_id = v_payment.receipt_id
    where c.id = p_challenge_id;
    if v_changed then
      insert into money.outbox_events(topic, aggregate_id, payload)
      values ('challenge.paid', p_challenge_id::text, jsonb_build_object(
        'challengeId', p_challenge_id, 'agentId', p_agent_id,
        'receiptId', v_payment.receipt_id
      ));
    end if;
  end if;

  return query select
    v_payment.status::text, v_payment.replayed::boolean,
    v_payment.transfer_id::uuid, v_payment.receipt_id::uuid,
    v_payment.approval_id::uuid, v_payment.denial_code::text,
    v_payment.reason::text, v_payment.from_balance_micros::bigint,
    v_payment.to_balance_micros::bigint;
end;
$$;

revoke all on function money_private.request_challenge_payment(text, uuid) from public;

-- Human-approved challenge payments are bound in the same transaction as the
-- approval settlement. The claim predicate prevents a generic payment whose
-- client key merely resembles a challenge key from capturing a challenge.
create or replace function money_private.bind_approved_challenge_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_challenge_id uuid;
  v_bound uuid;
begin
  if new.status <> 'approved' or old.status = 'approved' or new.receipt_id is null or
     new.idempotency_key !~ '^chl_[0-9a-fA-F-]{36}$' then
    return new;
  end if;
  begin
    v_challenge_id := substring(new.idempotency_key from 5)::uuid;
  exception when invalid_text_representation then
    return new;
  end;

  update money.challenges c set
    paid_by = new.agent_id,
    receipt_id = new.receipt_id
  where c.id = v_challenge_id
    and c.claimed_by = new.agent_id
    and c.provider_id = new.to_account_id
    and c.asset_code = new.asset_code
    and c.amount_micros = new.amount_micros
    and c.receipt_id is null
    and exists (
      select 1 from money.receipts r
      join money.transfers t on t.seq = r.transfer_seq
      where r.id = new.receipt_id
        and t.from_account_id = new.agent_id
        and t.to_account_id = new.to_account_id
        and t.asset_code = new.asset_code
        and t.amount_micros = new.amount_micros
    )
  returning c.id into v_bound;

  if v_bound is not null then
    insert into money.outbox_events(topic, aggregate_id, payload)
    values ('challenge.paid', v_bound::text, jsonb_build_object(
      'challengeId', v_bound,
      'agentId', new.agent_id,
      'receiptId', new.receipt_id,
      'approvalId', new.id
    ));
  end if;
  return new;
end;
$$;

revoke all on function money_private.bind_approved_challenge_payment() from public;

create trigger approvals_bind_challenge_payment
after update of status on money.approvals
for each row execute function money_private.bind_approved_challenge_payment();

create or replace function money_private.redeem_service_challenge(
  p_provider_id text,
  p_service_id uuid,
  p_challenge_id uuid,
  p_receipt_id uuid
)
returns table (ok boolean, reason text, challenge_id uuid, redeemed_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service money.services%rowtype;
  v_challenge money.challenges%rowtype;
  v_redeemed_at timestamptz;
begin
  select s.* into v_service from money.services s where s.id = p_service_id;
  if v_service.id is null or v_service.provider_id <> p_provider_id then
    return query select false, 'service does not belong to the signing provider', p_challenge_id, null::timestamptz;
    return;
  end if;
  select c.* into v_challenge from money.challenges c where c.id = p_challenge_id for update;
  if v_challenge.id is null or v_challenge.service_id <> p_service_id or
     v_challenge.provider_id <> p_provider_id then
    return query select false, 'challenge was not issued for this service', p_challenge_id, null::timestamptz;
    return;
  end if;
  if v_challenge.redeemed_at is not null then
    return query select false, 'challenge already redeemed (single-use)', p_challenge_id, v_challenge.redeemed_at;
    return;
  end if;
  if v_challenge.receipt_id is null or v_challenge.receipt_id <> p_receipt_id then
    return query select false, 'no payment recorded for this challenge and receipt', p_challenge_id, null::timestamptz;
    return;
  end if;
  if not exists (
    select 1 from money.receipts r
    join money.transfers t on t.seq = r.transfer_seq
    where r.id = p_receipt_id
      and t.from_account_id = v_challenge.paid_by
      and t.to_account_id = p_provider_id
      and t.asset_code = v_challenge.asset_code
      and t.amount_micros = v_challenge.amount_micros
      and t.memo = '402:' || v_challenge.resource
  ) then
    return query select false, 'receipt does not match challenge terms', p_challenge_id, null::timestamptz;
    return;
  end if;

  v_redeemed_at := clock_timestamp();
  update money.challenges c set redeemed_at = v_redeemed_at where c.id = p_challenge_id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('challenge.redeemed', p_challenge_id::text, jsonb_build_object(
    'challengeId', p_challenge_id,
    'serviceId', p_service_id,
    'providerId', p_provider_id,
    'receiptId', p_receipt_id
  ));
  return query select true, null::text, p_challenge_id, v_redeemed_at;
end;
$$;

revoke all on function money_private.redeem_service_challenge(text, uuid, uuid, uuid) from public;

create or replace function money_private.issue_refund(
  p_provider_id text,
  p_receipt_id uuid,
  p_amount_micros bigint,
  p_memo text,
  p_idempotency_key text
)
returns table (
  status text,
  replayed boolean,
  transfer_id uuid,
  receipt_id uuid,
  denial_code text,
  reason text,
  remaining_micros bigint,
  from_balance_micros bigint,
  to_balance_micros bigint,
  refund_of uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_original money.transfers%rowtype;
  v_post record;
  v_remaining bigint;
  v_memo text;
begin
  if p_amount_micros is null or p_amount_micros <= 0 then
    raise exception 'refund amount must be positive integer micros' using errcode = '22023';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key must contain 1-128 characters' using errcode = '22023';
  end if;
  if p_memo is null or char_length(p_memo) > 500 then
    raise exception 'memo must contain at most 500 characters' using errcode = '22023';
  end if;

  select t.* into v_original
  from money.receipts r
  join money.transfers t on t.seq = r.transfer_seq
  where r.id = p_receipt_id;
  if v_original.id is null or v_original.operation <> 'pay' or
     v_original.refund_of is not null or v_original.to_account_id <> p_provider_id then
    return query select 'denied', false, null::uuid, null::uuid,
      'refund_invalid', 'original purchase receipt was not paid to this provider',
      null::bigint, null::bigint, null::bigint, p_receipt_id;
    return;
  end if;

  v_memo := coalesce(nullif(p_memo, ''), 'refund for ' || p_receipt_id::text);
  select * into v_post from money_private.post_transfer_kernel(
    p_provider_id, 'refund', p_idempotency_key,
    p_provider_id, v_original.from_account_id, v_original.asset_code,
    p_amount_micros, v_memo,
    jsonb_build_object('clientIdempotencyKey', p_idempotency_key, 'refundOf', p_receipt_id),
    p_receipt_id
  );

  select greatest(v_original.amount_micros - coalesce(sum(t.amount_micros), 0), 0)::bigint
  into v_remaining
  from money.transfers t where t.refund_of = p_receipt_id;

  return query select
    case when v_post.status = 'posted' then 'refunded' else 'denied' end,
    v_post.replayed::boolean, v_post.transfer_id::uuid, v_post.receipt_id::uuid,
    v_post.denial_code::text, v_post.reason::text, v_remaining,
    v_post.from_balance_micros::bigint, v_post.to_balance_micros::bigint,
    p_receipt_id;
end;
$$;

revoke all on function money_private.issue_refund(text, uuid, bigint, text, text) from public;

create or replace function money_private.get_marketplace_challenges(
  p_requester_id text,
  p_challenge_ids uuid[]
)
returns setof money.challenges
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(array_length(p_challenge_ids, 1), 0) > 100 then
    raise exception 'at most 100 challenges may be requested' using errcode = '22023';
  end if;
  return query
    select c.* from money.challenges c
    join money.accounts requester on requester.id = p_requester_id and requester.status = 'active'
    left join money.accounts claimant on claimant.id = c.claimed_by
    left join money.accounts provider on provider.id = c.provider_id
    where c.id = any(p_challenge_ids)
      and (
        requester.id = c.claimed_by or requester.id = c.provider_id or
        (requester.kind = 'user' and requester.id in (claimant.owner_id, provider.owner_id))
      )
    order by c.created_at desc, c.id desc;
end;
$$;

revoke all on function money_private.get_marketplace_challenges(text, uuid[]) from public;

-- Receipt reconciliation understands the refund-aware evidence envelope while
-- retaining byte-for-byte validation for every receipt minted before v0.7.
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
      where r.evidence_hash <> public.digest((case when t.refund_of is null then
        jsonb_build_object(
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
      else
        jsonb_build_object(
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
      end)::text, 'sha256')
    )
$$;

revoke all on function money_private.ledger_health() from public;
