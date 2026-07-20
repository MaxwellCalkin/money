-- Production treasury boundary: bank funding, customer/provider payouts,
-- return exposure, durable provider-event ingestion, and asset reconciliation.
--
-- Webhook ingress cannot move money. It may only enqueue a provider event.
-- The treasury worker re-fetches that event with provider credentials and
-- invokes narrowly scoped commands. Payout workers reserve funds in the
-- journal before calling a provider and never hold database locks over HTTP.

insert into money.accounts (id, kind, name)
values ('external:payout', 'external', 'External payout settlement boundary')
on conflict (id) do nothing;

insert into money.balances (account_id, asset_code)
values ('external:payout', 'USD')
on conflict (account_id, asset_code) do nothing;

create table money.treasury_controls (
  singleton boolean primary key default true check (singleton),
  funding_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  external_spend_enabled boolean not null default false,
  max_payout_micros bigint not null default 100000000000 check (max_payout_micros > 0),
  max_pending_payout_micros bigint not null default 1000000000000 check (max_pending_payout_micros > 0),
  max_open_exposure_micros bigint not null default 100000000000 check (max_open_exposure_micros > 0),
  max_reconciliation_variance_micros bigint not null default 1000000 check (max_reconciliation_variance_micros >= 0),
  breaker_reason text default 'initial treasury reconciliation and review required'
    check (breaker_reason is null or char_length(breaker_reason) between 1 and 500),
  updated_at timestamptz not null default clock_timestamp()
);

insert into money.treasury_controls(singleton) values (true)
on conflict (singleton) do nothing;

create table money.treasury_control_events (
  id bigint generated always as identity primary key,
  action text not null check (action in ('configured', 'tripped')),
  funding_enabled boolean not null,
  payouts_enabled boolean not null,
  external_spend_enabled boolean not null,
  max_payout_micros bigint not null check (max_payout_micros > 0),
  max_pending_payout_micros bigint not null check (max_pending_payout_micros > 0),
  max_open_exposure_micros bigint not null check (max_open_exposure_micros > 0),
  max_reconciliation_variance_micros bigint not null check (max_reconciliation_variance_micros >= 0),
  reason text not null check (char_length(reason) between 1 and 500),
  database_actor text not null check (char_length(database_actor) between 1 and 255),
  created_at timestamptz not null default clock_timestamp()
);

create index treasury_control_events_created_idx
  on money.treasury_control_events(created_at desc, id desc);

create table money.treasury_deposit_routes (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references money.accounts(id),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_route_ref text not null check (char_length(provider_route_ref) between 3 and 255),
  label text not null check (char_length(label) between 1 and 100),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint treasury_deposit_route_provider_ref_uq unique (provider, provider_route_ref)
);

create index treasury_deposit_routes_user_idx
  on money.treasury_deposit_routes(user_id, created_at desc);

create table money.treasury_destinations (
  id uuid primary key default gen_random_uuid(),
  account_id text not null references money.accounts(id),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_ref text not null check (char_length(provider_ref) between 3 and 255),
  label text not null check (char_length(label) between 1 and 100),
  status text not null default 'verified' check (status in ('verified', 'disabled')),
  verified_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint treasury_destination_provider_ref_uq unique (provider, provider_ref)
);

create index treasury_destinations_account_idx
  on money.treasury_destinations(account_id, created_at desc);

create table money.treasury_event_inbox (
  id bigint generated always as identity primary key,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_event_id text not null check (char_length(provider_event_id) between 3 and 255),
  endpoint_id text not null check (char_length(endpoint_id) between 1 and 255),
  delivery_hash bytea not null check (octet_length(delivery_hash) = 32),
  state text not null default 'queued' check (state in ('queued', 'processing', 'completed', 'ignored', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default clock_timestamp(),
  locked_at timestamptz,
  locked_by text,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  received_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint treasury_event_inbox_provider_event_uq unique (provider, provider_event_id),
  check (
    (state = 'processing' and locked_at is not null and locked_by is not null and completed_at is null) or
    (state in ('queued') and locked_at is null and locked_by is null and completed_at is null) or
    (state in ('completed', 'ignored', 'dead') and locked_at is null and locked_by is null and completed_at is not null)
  )
);

create index treasury_event_inbox_ready_idx
  on money.treasury_event_inbox(available_at, id)
  where state = 'queued';

create table money.treasury_event_reviews (
  id uuid primary key default gen_random_uuid(),
  inbox_id bigint not null references money.treasury_event_inbox(id),
  resolution text not null check (resolution in ('retry', 'ignore')),
  prior_error text check (prior_error is null or char_length(prior_error) <= 1000),
  review_reference text not null check (char_length(review_reference) between 3 and 100),
  reason text not null check (char_length(reason) between 3 and 500),
  database_actor text not null check (char_length(database_actor) between 1 and 255),
  created_at timestamptz not null default clock_timestamp()
);

create index treasury_event_reviews_inbox_created_idx
  on money.treasury_event_reviews(inbox_id, created_at desc, id desc);

create table money.treasury_provider_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_event_id text not null check (char_length(provider_event_id) between 3 and 255),
  event_type text not null check (char_length(event_type) between 3 and 255),
  provider_object_id text not null check (char_length(provider_object_id) between 3 and 255),
  payload_hash bytea not null check (octet_length(payload_hash) = 32),
  canonical_payload jsonb not null check (jsonb_typeof(canonical_payload) = 'object'),
  outcome text not null check (outcome in ('applied', 'duplicate', 'ignored')),
  created_at timestamptz not null default clock_timestamp(),
  constraint treasury_provider_event_provider_event_uq unique (provider, provider_event_id)
);

create index treasury_provider_events_object_idx
  on money.treasury_provider_events(provider, provider_object_id, created_at desc);

create table money.treasury_fundings (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_transfer_id text not null check (char_length(provider_transfer_id) between 3 and 255),
  route_id uuid not null references money.treasury_deposit_routes(id),
  user_id text not null references money.accounts(id),
  asset_code text not null references money.assets(code),
  amount_micros bigint not null check (amount_micros > 0),
  state text not null check (state in ('settled', 'returned')),
  funding_transfer_seq bigint not null unique references money.transfers(seq),
  return_transfer_seq bigint unique references money.transfers(seq),
  settled_event_id text not null,
  returned_event_id text,
  settled_at timestamptz not null,
  returned_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_transfer_id),
  check (
    (state = 'settled' and return_transfer_seq is null and returned_event_id is null and returned_at is null) or
    (state = 'returned' and return_transfer_seq is not null and returned_event_id is not null and returned_at is not null)
  )
);

create index treasury_fundings_user_created_idx
  on money.treasury_fundings(user_id, created_at desc);

create table money.treasury_exposures (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references money.accounts(id),
  funding_id uuid not null references money.treasury_fundings(id),
  amount_micros bigint not null check (amount_micros > 0),
  recovered_micros bigint not null default 0 check (recovered_micros >= 0 and recovered_micros <= amount_micros),
  state text not null default 'open' check (state in ('open', 'recovered', 'written_off')),
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  check (
    (state = 'open' and recovered_micros < amount_micros and resolved_at is null) or
    (state = 'recovered' and recovered_micros = amount_micros and resolved_at is not null) or
    (state = 'written_off' and resolved_at is not null)
  )
);

create index treasury_exposures_open_user_idx
  on money.treasury_exposures(user_id, created_at, id)
  where state = 'open';

create table money.treasury_freezes (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references money.accounts(id),
  account_id text not null references money.accounts(id),
  funding_id uuid not null references money.treasury_fundings(id),
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default clock_timestamp(),
  released_at timestamptz,
  release_reason text check (release_reason is null or char_length(release_reason) between 1 and 500),
  check ((released_at is null and release_reason is null) or (released_at is not null and release_reason is not null))
);

create unique index treasury_freezes_active_account_idx
  on money.treasury_freezes(account_id)
  where released_at is null;

create table money.treasury_payouts (
  id uuid primary key default gen_random_uuid(),
  source_account_id text not null references money.accounts(id),
  destination_id uuid not null references money.treasury_destinations(id),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  asset_code text not null references money.assets(code),
  amount_micros bigint not null check (amount_micros > 0),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  hold_transfer_seq bigint not null unique references money.transfers(seq),
  reversal_transfer_seq bigint unique references money.transfers(seq),
  provider_transfer_id text check (provider_transfer_id is null or char_length(provider_transfer_id) between 3 and 255),
  state text not null default 'queued' check (state in (
    'queued', 'submitting', 'submitted', 'settled', 'failed', 'returned', 'cancelled', 'manual_review'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default clock_timestamp(),
  first_attempt_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  requested_at timestamptz not null default clock_timestamp(),
  submitted_at timestamptz,
  settled_at timestamptz,
  terminal_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (source_account_id, idempotency_key),
  unique (provider, provider_transfer_id),
  check (
    (state = 'queued' and provider_transfer_id is null and reversal_transfer_seq is null and locked_at is null and locked_by is null and terminal_at is null) or
    (state = 'submitting' and reversal_transfer_seq is null and locked_at is not null and locked_by is not null and terminal_at is null) or
    (state = 'submitted' and provider_transfer_id is not null and reversal_transfer_seq is null and locked_at is null and locked_by is null and submitted_at is not null and terminal_at is null) or
    (state = 'settled' and provider_transfer_id is not null and reversal_transfer_seq is null and locked_at is null and locked_by is null and settled_at is not null and terminal_at is not null) or
    (state in ('failed', 'returned', 'cancelled') and reversal_transfer_seq is not null and locked_at is null and locked_by is null and terminal_at is not null) or
    (state = 'manual_review' and reversal_transfer_seq is null and locked_at is null and locked_by is null and terminal_at is null)
  )
);

create index treasury_payouts_ready_idx
  on money.treasury_payouts(available_at, requested_at, id)
  where state = 'queued';
create index treasury_payouts_source_created_idx
  on money.treasury_payouts(source_account_id, requested_at desc);
create index treasury_payouts_unsettled_idx
  on money.treasury_payouts(provider, state, requested_at)
  where state in ('queued', 'submitting', 'submitted', 'manual_review');

create table money.treasury_payout_reviews (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null unique references money.treasury_payouts(id),
  resolved_state text not null check (resolved_state in ('submitted', 'settled', 'failed', 'returned', 'cancelled')),
  provider_transfer_id text check (provider_transfer_id is null or char_length(provider_transfer_id) between 3 and 255),
  review_reference text not null check (char_length(review_reference) between 3 and 100),
  reason text not null check (char_length(reason) between 3 and 500),
  reversal_transfer_seq bigint unique references money.transfers(seq),
  created_at timestamptz not null default clock_timestamp(),
  check (
    (resolved_state in ('submitted', 'settled', 'returned', 'cancelled') and provider_transfer_id is not null) or
    (resolved_state = 'failed')
  ),
  check (
    (resolved_state in ('failed', 'returned', 'cancelled') and reversal_transfer_seq is not null) or
    (resolved_state in ('submitted', 'settled') and reversal_transfer_seq is null)
  )
);

create index treasury_payout_reviews_created_idx
  on money.treasury_payout_reviews(created_at desc, id desc);

create table money.treasury_asset_accounts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_account_ref text not null check (char_length(provider_account_ref) between 3 and 255),
  asset_code text not null references money.assets(code),
  kind text not null check (kind in ('bank', 'stablecoin', 'reserve')),
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint treasury_asset_account_provider_ref_asset_uq unique (provider, provider_account_ref, asset_code)
);

create table money.treasury_asset_snapshots (
  id bigint generated always as identity primary key,
  asset_account_id uuid not null references money.treasury_asset_accounts(id),
  asset_code text not null references money.assets(code),
  book_micros bigint not null check (book_micros >= 0),
  available_micros bigint not null check (available_micros >= 0),
  holding_micros bigint not null default 0 check (holding_micros >= 0),
  locked_micros bigint not null default 0 check (locked_micros >= 0),
  pending_micros bigint not null default 0 check (pending_micros >= 0),
  provider_observation_id text not null check (char_length(provider_observation_id) between 1 and 255),
  observed_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint treasury_asset_snapshot_observation_uq unique (asset_account_id, provider_observation_id),
  check (observed_at <= recorded_at + interval '5 minutes')
);

create index treasury_asset_snapshots_latest_idx
  on money.treasury_asset_snapshots(asset_account_id, observed_at desc, id desc);

create table money.treasury_poll_cursors (
  provider text primary key check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  polled_through timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);

-- One reviewed journal helper serves every treasury movement. It is never
-- granted directly. The economic command wrappers below enforce provider
-- evidence and lifecycle state before invoking it.
create or replace function money_private.post_treasury_transfer(
  p_actor_id text,
  p_operation text,
  p_idempotency_key text,
  p_from_account_id text,
  p_to_account_id text,
  p_asset_code text,
  p_amount_micros bigint,
  p_memo text,
  p_metadata jsonb
)
returns table (
  status text, replayed boolean, transfer_seq bigint, transfer_id uuid, receipt_id uuid,
  denial_code text, reason text, from_balance_micros bigint, to_balance_micros bigint
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
  v_from_balance bigint;
  v_to_balance bigint;
  v_transfer_seq bigint;
  v_transfer_id uuid;
  v_receipt_id uuid;
  v_result jsonb;
begin
  if p_actor_id is null or p_operation not in ('funding_settlement', 'funding_return', 'payout_hold', 'payout_reversal') then
    raise exception 'unsupported treasury transfer operation' using errcode = '22023';
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
    raise exception 'invalid treasury memo or metadata' using errcode = '22023';
  end if;

  v_hash := public.digest(jsonb_build_object(
    'actor', p_actor_id, 'operation', p_operation,
    'from', p_from_account_id, 'to', p_to_account_id,
    'asset', p_asset_code, 'amount', p_amount_micros,
    'memo', p_memo, 'metadata', p_metadata
  )::text, 'sha256');

  insert into money.idempotency_keys(actor_id, operation, idempotency_key, request_hash)
  values (p_actor_id, p_operation, p_idempotency_key, v_hash)
  on conflict (actor_id, operation, idempotency_key) do nothing
  returning id into v_key_id;

  if v_key_id is null then
    select * into v_prior from money.idempotency_keys
    where actor_id = p_actor_id and operation = p_operation and idempotency_key = p_idempotency_key
    for update;
    if v_prior.request_hash <> v_hash then
      return query select 'denied', true, null::bigint, null::uuid, null::uuid,
        'idempotency_conflict', 'idempotency key was reused with different treasury terms',
        null::bigint, null::bigint;
      return;
    end if;
    if v_prior.state <> 'completed' then
      raise exception 'treasury idempotency reservation is unexpectedly incomplete' using errcode = '40001';
    end if;
    if v_prior.result_kind = 'denied' then
      return query select 'denied', true, null::bigint, null::uuid, null::uuid,
        v_prior.result->>'denialCode', v_prior.result->>'reason',
        nullif(v_prior.result->>'fromBalanceMicros', '')::bigint,
        nullif(v_prior.result->>'toBalanceMicros', '')::bigint;
      return;
    end if;
    return query
      select 'posted', true, t.seq, t.id, r.id, null::text, null::text,
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
    raise exception 'unknown treasury transfer account' using errcode = '23503';
  end if;

  if p_operation = 'funding_settlement' and not (
    p_actor_id = 'external:funding' and p_from_account_id = 'external:funding' and
    v_from.kind = 'external' and v_to.kind = 'user' and v_to.status in ('active', 'frozen')
  ) then
    raise exception 'funding settlement must credit a user from the funding boundary' using errcode = '42501';
  elsif p_operation = 'funding_return' and not (
    p_actor_id = 'external:funding' and v_from.kind = 'user' and
    p_to_account_id = 'external:funding' and v_to.kind = 'external'
  ) then
    raise exception 'funding return must debit a user into the funding boundary' using errcode = '42501';
  elsif p_operation = 'payout_hold' and not (
    p_actor_id = p_from_account_id and v_from.kind in ('user', 'provider') and v_from.status = 'active' and
    p_to_account_id = 'external:payout' and v_to.kind = 'external'
  ) then
    raise exception 'payout hold must reserve an active user or provider balance' using errcode = '42501';
  elsif p_operation = 'payout_reversal' and not (
    p_actor_id = 'external:payout' and p_from_account_id = 'external:payout' and v_from.kind = 'external' and
    v_to.kind in ('user', 'provider') and v_to.status in ('active', 'frozen', 'closed')
  ) then
    raise exception 'payout reversal must return the payout boundary to its source' using errcode = '42501';
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

  if p_operation in ('payout_hold', 'payout_reversal') and v_from_balance < p_amount_micros then
    v_result := jsonb_build_object(
      'denialCode', 'insufficient_funds', 'reason', 'insufficient available balance',
      'fromBalanceMicros', v_from_balance, 'toBalanceMicros', v_to_balance
    );
    update money.idempotency_keys set
      state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
    where id = v_key_id;
    return query select 'denied', false, null::bigint, null::uuid, null::uuid,
      'insufficient_funds', 'insufficient available balance', v_from_balance, v_to_balance;
    return;
  end if;

  insert into money.transfers(
    actor_id, operation, idempotency_key, request_hash,
    from_account_id, to_account_id, asset_code, amount_micros, memo, metadata
  ) values (
    p_actor_id, p_operation, p_idempotency_key, v_hash,
    p_from_account_id, p_to_account_id, p_asset_code, p_amount_micros, p_memo, p_metadata
  ) returning seq, id into v_transfer_seq, v_transfer_id;

  insert into money.ledger_entries(transfer_seq, account_id, asset_code, amount_micros)
  values
    (v_transfer_seq, p_from_account_id, p_asset_code, -p_amount_micros),
    (v_transfer_seq, p_to_account_id, p_asset_code, p_amount_micros);

  update money.balances set
    available_micros = available_micros + case
      when account_id = p_from_account_id then -p_amount_micros else p_amount_micros end,
    version = version + 1,
    updated_at = clock_timestamp()
  where asset_code = p_asset_code and account_id in (p_from_account_id, p_to_account_id);

  insert into money.receipts(transfer_seq, evidence_hash)
  values (v_transfer_seq, public.digest(jsonb_build_object(
    'transferId', v_transfer_id, 'actor', p_actor_id, 'operation', p_operation,
    'from', p_from_account_id, 'to', p_to_account_id, 'asset', p_asset_code,
    'amount', p_amount_micros, 'memo', p_memo, 'requestHash', encode(v_hash, 'hex')
  )::text, 'sha256'))
  returning id into v_receipt_id;

  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('treasury.transfer.posted', v_transfer_id::text, jsonb_build_object(
    'transferId', v_transfer_id, 'receiptId', v_receipt_id,
    'operation', p_operation, 'from', p_from_account_id, 'to', p_to_account_id,
    'asset', p_asset_code, 'amountMicros', p_amount_micros
  ));

  update money.idempotency_keys set
    state = 'completed', result_kind = 'posted', result_id = v_transfer_id::text,
    result = jsonb_build_object('transferId', v_transfer_id, 'receiptId', v_receipt_id),
    completed_at = clock_timestamp()
  where id = v_key_id;

  select available_micros into v_from_balance
  from money.balances where account_id = p_from_account_id and asset_code = p_asset_code;
  select available_micros into v_to_balance
  from money.balances where account_id = p_to_account_id and asset_code = p_asset_code;

  return query select 'posted', false, v_transfer_seq, v_transfer_id, v_receipt_id,
    null::text, null::text, v_from_balance, v_to_balance;
end;
$$;

revoke all on function money_private.post_treasury_transfer(text,text,text,text,text,text,bigint,text,jsonb) from public;

create or replace function money_private.register_treasury_deposit_route(
  p_user_id text,
  p_provider text,
  p_provider_route_ref text,
  p_label text
)
returns table (id uuid, user_id text, provider text, label text, status text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account money.accounts%rowtype;
  v_route money.treasury_deposit_routes%rowtype;
begin
  if p_provider !~ '^[a-z][a-z0-9_-]{1,31}$' or char_length(p_provider_route_ref) not between 3 and 255 or
     char_length(p_label) not between 1 and 100 then
    raise exception 'invalid treasury deposit route' using errcode = '22023';
  end if;
  select * into v_account from money.accounts where money.accounts.id = p_user_id for update;
  if v_account.id is null or v_account.kind <> 'user' or v_account.status = 'closed' then
    raise exception 'deposit route requires an open user account' using errcode = '42501';
  end if;
  insert into money.treasury_deposit_routes(user_id, provider, provider_route_ref, label)
  values (p_user_id, p_provider, p_provider_route_ref, p_label)
  on conflict on constraint treasury_deposit_route_provider_ref_uq do nothing
  returning * into v_route;
  if v_route.id is null then
    select * into v_route from money.treasury_deposit_routes
    where money.treasury_deposit_routes.provider = p_provider
      and provider_route_ref = p_provider_route_ref
    for update;
    if v_route.user_id <> p_user_id then
      raise exception 'provider deposit route is already bound to another user' using errcode = '42501';
    end if;
    update money.treasury_deposit_routes set
      label = p_label, status = 'active', updated_at = clock_timestamp()
    where money.treasury_deposit_routes.id = v_route.id
    returning * into v_route;
  end if;
  return query select v_route.id, v_route.user_id, v_route.provider, v_route.label, v_route.status, v_route.created_at;
end;
$$;

create or replace function money_private.register_treasury_destination(
  p_account_id text,
  p_provider text,
  p_provider_ref text,
  p_label text
)
returns table (id uuid, account_id text, provider text, label text, status text, verified_at timestamptz, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account money.accounts%rowtype;
  v_destination money.treasury_destinations%rowtype;
begin
  if p_provider !~ '^[a-z][a-z0-9_-]{1,31}$' or char_length(p_provider_ref) not between 3 and 255 or
     char_length(p_label) not between 1 and 100 then
    raise exception 'invalid treasury payout destination' using errcode = '22023';
  end if;
  select * into v_account from money.accounts where money.accounts.id = p_account_id for update;
  if v_account.id is null or v_account.kind not in ('user', 'provider') or v_account.status = 'closed' then
    raise exception 'payout destination requires an open user or provider account' using errcode = '42501';
  end if;
  insert into money.treasury_destinations(account_id, provider, provider_ref, label)
  values (p_account_id, p_provider, p_provider_ref, p_label)
  on conflict on constraint treasury_destination_provider_ref_uq do nothing
  returning * into v_destination;
  if v_destination.id is null then
    select * into v_destination from money.treasury_destinations
    where money.treasury_destinations.provider = p_provider and provider_ref = p_provider_ref
    for update;
    if v_destination.account_id <> p_account_id then
      raise exception 'provider destination is already bound to another account' using errcode = '42501';
    end if;
    update money.treasury_destinations set
      label = p_label, status = 'verified', verified_at = clock_timestamp(), updated_at = clock_timestamp()
    where money.treasury_destinations.id = v_destination.id
    returning * into v_destination;
  end if;
  return query select v_destination.id, v_destination.account_id, v_destination.provider,
    v_destination.label, v_destination.status, v_destination.verified_at, v_destination.created_at;
end;
$$;

create or replace function money_private.set_treasury_destination_status(
  p_account_id text,
  p_destination_id uuid,
  p_status text
)
returns table (id uuid, status text, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('verified', 'disabled') then
    raise exception 'invalid treasury destination status' using errcode = '22023';
  end if;
  return query
    update money.treasury_destinations d set
      status = p_status,
      verified_at = case when p_status = 'verified' then clock_timestamp() else d.verified_at end,
      updated_at = clock_timestamp()
    where d.id = p_destination_id and d.account_id = p_account_id
    returning d.id, d.status, d.updated_at;
  if not found then
    raise exception 'treasury destination not found' using errcode = 'P0002';
  end if;
end;
$$;

create or replace function money_private.register_treasury_asset_account(
  p_provider text,
  p_provider_account_ref text,
  p_asset_code text,
  p_kind text
)
returns table (id uuid, provider text, account_ref text, asset_code text, kind text, active boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account money.treasury_asset_accounts%rowtype;
begin
  if p_provider !~ '^[a-z][a-z0-9_-]{1,31}$' or char_length(p_provider_account_ref) not between 3 and 255 or
     p_kind not in ('bank', 'stablecoin', 'reserve') then
    raise exception 'invalid treasury asset account' using errcode = '22023';
  end if;
  if not exists (select 1 from money.assets where code = p_asset_code and enabled) then
    raise exception 'unknown or disabled treasury asset' using errcode = '22023';
  end if;
  insert into money.treasury_asset_accounts(provider, provider_account_ref, asset_code, kind)
  values (p_provider, p_provider_account_ref, p_asset_code, p_kind)
  on conflict on constraint treasury_asset_account_provider_ref_asset_uq do update set
    kind = excluded.kind, active = true, updated_at = clock_timestamp()
  returning * into v_account;
  return query select v_account.id, v_account.provider, v_account.provider_account_ref,
    v_account.asset_code, v_account.kind, v_account.active;
end;
$$;

create or replace function money_private.enqueue_treasury_provider_event(
  p_provider text,
  p_provider_event_id text,
  p_endpoint_id text,
  p_delivery_hash bytea
)
returns table (inbox_id bigint, replayed boolean, state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row money.treasury_event_inbox%rowtype;
begin
  if p_provider !~ '^[a-z][a-z0-9_-]{1,31}$' or char_length(p_provider_event_id) not between 3 and 255 or
     char_length(p_endpoint_id) not between 1 and 255 or octet_length(p_delivery_hash) <> 32 then
    raise exception 'invalid treasury provider event envelope' using errcode = '22023';
  end if;
  insert into money.treasury_event_inbox(provider, provider_event_id, endpoint_id, delivery_hash)
  values (p_provider, p_provider_event_id, p_endpoint_id, p_delivery_hash)
  on conflict on constraint treasury_event_inbox_provider_event_uq do nothing
  returning * into v_row;
  if v_row.id is not null then
    return query select v_row.id, false, v_row.state;
    return;
  end if;
  select * into v_row from money.treasury_event_inbox
  where provider = p_provider and provider_event_id = p_provider_event_id;
  return query select v_row.id, true, v_row.state;
end;
$$;

create or replace function money_private.claim_treasury_provider_events(
  p_worker_id text,
  p_limit integer
)
returns table (inbox_id bigint, provider text, provider_event_id text, attempts integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if char_length(p_worker_id) not between 1 and 128 or p_limit not between 1 and 1000 then
    raise exception 'invalid treasury event worker claim' using errcode = '22023';
  end if;
  -- Expired leases return to the queue. The update and claim stay in one
  -- short transaction and no provider HTTP call occurs under these locks.
  update money.treasury_event_inbox set
    state = 'queued', locked_at = null, locked_by = null,
    available_at = clock_timestamp(), last_error = 'worker lease expired'
  where state = 'processing' and locked_at < clock_timestamp() - interval '2 minutes';

  return query
    with claims as (
      select i.id from money.treasury_event_inbox i
      where i.state = 'queued' and i.available_at <= clock_timestamp()
      order by i.available_at, i.id
      limit p_limit
      for update skip locked
    )
    update money.treasury_event_inbox i set
      state = 'processing', locked_at = clock_timestamp(), locked_by = p_worker_id,
      attempts = i.attempts + 1
    from claims where i.id = claims.id
    returning i.id, i.provider, i.provider_event_id, i.attempts;
end;
$$;

create or replace function money_private.complete_treasury_provider_event(
  p_worker_id text,
  p_inbox_id bigint,
  p_outcome text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_outcome not in ('completed', 'ignored') then
    raise exception 'invalid treasury provider event outcome' using errcode = '22023';
  end if;
  update money.treasury_event_inbox set
    state = p_outcome, locked_at = null, locked_by = null,
    last_error = null, completed_at = clock_timestamp()
  where id = p_inbox_id and state = 'processing' and locked_by = p_worker_id;
  if not found then
    raise exception 'treasury event worker does not own this claim' using errcode = '42501';
  end if;
  return true;
end;
$$;

create or replace function money_private.fail_treasury_provider_event(
  p_worker_id text,
  p_inbox_id bigint,
  p_error text,
  p_retry_after_seconds integer,
  p_dead boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if char_length(p_error) not between 1 and 1000 or p_retry_after_seconds not between 0 and 86400 then
    raise exception 'invalid treasury provider event failure' using errcode = '22023';
  end if;
  update money.treasury_event_inbox set
    state = case when p_dead then 'dead' else 'queued' end,
    locked_at = null, locked_by = null, last_error = p_error,
    available_at = clock_timestamp() + make_interval(secs => p_retry_after_seconds),
    completed_at = case when p_dead then clock_timestamp() else null end
  where id = p_inbox_id and state = 'processing' and locked_by = p_worker_id;
  if not found then
    raise exception 'treasury event worker does not own this claim' using errcode = '42501';
  end if;
  if p_dead then
    perform money_private.trip_treasury_breaker(
      'dead-letter treasury provider event ' || p_inbox_id::text
    );
  end if;
  return true;
end;
$$;

create or replace function money_private.resolve_treasury_event_review(
  p_inbox_id bigint,
  p_resolution text,
  p_review_reference text,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event money.treasury_event_inbox%rowtype;
  v_state text;
begin
  if p_resolution not in ('retry', 'ignore') or
     char_length(p_review_reference) not between 3 and 100 or
     char_length(p_reason) not between 3 and 500 then
    raise exception 'invalid treasury event review resolution' using errcode = '22023';
  end if;
  select * into v_event from money.treasury_event_inbox where id = p_inbox_id for update;
  if v_event.id is null then raise exception 'treasury provider event not found' using errcode = 'P0002'; end if;
  if v_event.state <> 'dead' then
    raise exception 'treasury provider event is not awaiting review' using errcode = '55000';
  end if;
  if exists (
    select 1 from money.treasury_controls
    where singleton and (funding_enabled or payouts_enabled or external_spend_enabled)
  ) then
    raise exception 'all treasury breakers must remain open during event review' using errcode = '55000';
  end if;
  insert into money.treasury_event_reviews(
    inbox_id, resolution, prior_error, review_reference, reason, database_actor
  ) values (
    v_event.id, p_resolution, v_event.last_error, p_review_reference, p_reason, session_user
  );
  if p_resolution = 'retry' then
    update money.treasury_event_inbox set
      state = 'queued', attempts = 0, available_at = clock_timestamp(),
      locked_at = null, locked_by = null,
      last_error = 'reviewed retry: ' || p_reason, completed_at = null
    where id = v_event.id
    returning state into v_state;
  else
    update money.treasury_event_inbox set
      state = 'ignored', locked_at = null, locked_by = null,
      last_error = 'reviewed ignore: ' || p_reason,
      completed_at = clock_timestamp()
    where id = v_event.id
    returning state into v_state;
  end if;
  return v_state;
end;
$$;

create or replace function money_private.get_treasury_poll_cursor(p_provider text)
returns timestamptz
language sql
security definer
set search_path = ''
stable
as $$
  select polled_through from money.treasury_poll_cursors where provider = p_provider
$$;

create or replace function money_private.set_treasury_poll_cursor(p_provider text, p_polled_through timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare v_result timestamptz;
begin
  if p_provider !~ '^[a-z][a-z0-9_-]{1,31}$' or p_polled_through > clock_timestamp() + interval '1 minute' then
    raise exception 'invalid treasury poll cursor' using errcode = '22023';
  end if;
  insert into money.treasury_poll_cursors(provider, polled_through)
  values (p_provider, p_polled_through)
  on conflict (provider) do update set
    polled_through = greatest(money.treasury_poll_cursors.polled_through, excluded.polled_through),
    updated_at = clock_timestamp()
  returning polled_through into v_result;
  return v_result;
end;
$$;

create or replace function money_private.record_treasury_provider_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_provider_object_id text,
  p_payload_hash bytea,
  p_canonical_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_prior money.treasury_provider_events%rowtype;
begin
  if p_provider !~ '^[a-z][a-z0-9_-]{1,31}$' or
     char_length(p_provider_event_id) not between 3 and 255 or
     char_length(p_event_type) not between 3 and 255 or
     char_length(p_provider_object_id) not between 3 and 255 or
     octet_length(p_payload_hash) <> 32 or jsonb_typeof(p_canonical_payload) <> 'object' then
    raise exception 'invalid normalized treasury provider event' using errcode = '22023';
  end if;
  insert into money.treasury_provider_events(
    provider, provider_event_id, event_type, provider_object_id,
    payload_hash, canonical_payload, outcome
  ) values (
    p_provider, p_provider_event_id, p_event_type, p_provider_object_id,
    p_payload_hash, p_canonical_payload, 'applied'
  ) on conflict on constraint treasury_provider_event_provider_event_uq do nothing
  returning id into v_id;
  if v_id is not null then return false; end if;
  select * into v_prior from money.treasury_provider_events
  where provider = p_provider and provider_event_id = p_provider_event_id;
  if v_prior.event_type <> p_event_type or v_prior.provider_object_id <> p_provider_object_id or
     v_prior.payload_hash <> p_payload_hash or v_prior.canonical_payload <> p_canonical_payload then
    raise exception 'provider event id was reused with different normalized evidence' using errcode = '22023';
  end if;
  return true;
end;
$$;

create or replace function money_private.settle_treasury_funding(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_provider_transfer_id text,
  p_provider_route_ref text,
  p_asset_code text,
  p_amount_micros bigint,
  p_occurred_at timestamptz,
  p_payload_hash bytea,
  p_canonical_payload jsonb
)
returns table (
  result_status text, replayed boolean, funding_id uuid,
  transfer_id uuid, receipt_id uuid, user_balance_micros bigint,
  recovered_exposure_micros bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_replay boolean;
  v_route money.treasury_deposit_routes%rowtype;
  v_funding money.treasury_fundings%rowtype;
  v_post record;
  v_transfer money.transfers%rowtype;
  v_receipt_id uuid;
  v_pre_balance bigint;
  v_balance bigint;
  v_recovery bigint := 0;
  v_remaining bigint;
  v_exposure money.treasury_exposures%rowtype;
  v_apply bigint;
  v_key text;
begin
  if p_provider <> 'column' or p_event_type <> 'ach.incoming_transfer.settled' or p_asset_code <> 'USD' or
     p_amount_micros is null or p_amount_micros <= 0 or p_amount_micros % 10000 <> 0 or
     p_occurred_at is null or p_occurred_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid settled funding amount or timestamp' using errcode = '22023';
  end if;

  v_event_replay := money_private.record_treasury_provider_event(
    p_provider, p_provider_event_id, p_event_type, p_provider_transfer_id,
    p_payload_hash, p_canonical_payload
  );
  perform pg_advisory_xact_lock(hashtext('treasury-funding:' || p_provider || ':' || p_provider_transfer_id));

  select * into v_funding from money.treasury_fundings
  where provider = p_provider and provider_transfer_id = p_provider_transfer_id
  for update;
  if v_funding.id is not null then
    if v_funding.amount_micros <> p_amount_micros or v_funding.asset_code <> p_asset_code or not exists (
      select 1 from money.treasury_deposit_routes r
      where r.id = v_funding.route_id and r.provider = p_provider
        and r.provider_route_ref = p_provider_route_ref
    ) then
      raise exception 'provider transfer was reused with different funding terms' using errcode = '22023';
    end if;
    update money.treasury_provider_events set outcome = 'duplicate'
    where provider = p_provider and provider_event_id = p_provider_event_id and not v_event_replay;
    select * into v_transfer from money.transfers
    where seq = v_funding.funding_transfer_seq;
    select id into v_receipt_id from money.receipts
    where transfer_seq = v_funding.funding_transfer_seq;
    select available_micros into v_balance from money.balances
    where account_id = v_funding.user_id and asset_code = p_asset_code;
    return query select v_funding.state, true, v_funding.id,
      v_transfer.id, v_receipt_id, v_balance, 0::bigint;
    return;
  end if;

  -- A breaker stops new credits, not exact acknowledgment of a transfer that
  -- was already journaled. This check therefore follows the replay branch.
  perform 1 from money.treasury_controls where singleton and funding_enabled for update;
  if not found then
    raise exception 'treasury funding circuit breaker is open' using errcode = '55000';
  end if;

  select * into v_route from money.treasury_deposit_routes
  where provider = p_provider and provider_route_ref = p_provider_route_ref
  for update;
  if v_route.id is null or v_route.status <> 'active' then
    raise exception 'provider funding route is unknown or disabled' using errcode = 'P0002';
  end if;
  select available_micros into v_pre_balance from money.balances
  where account_id = v_route.user_id and asset_code = p_asset_code
  for update;
  v_pre_balance := coalesce(v_pre_balance, 0);
  v_key := 'fund_' || encode(public.digest(p_provider || ':' || p_provider_transfer_id, 'sha256'), 'hex');

  select * into v_post from money_private.post_treasury_transfer(
    'external:funding', 'funding_settlement', v_key,
    'external:funding', v_route.user_id, p_asset_code, p_amount_micros,
    'settled provider funding', jsonb_build_object(
      'provider', p_provider, 'providerTransferId', p_provider_transfer_id,
      'providerEventId', p_provider_event_id, 'routeId', v_route.id
    )
  );
  if v_post.status <> 'posted' then
    raise exception 'funding settlement journal command was denied: %', v_post.denial_code using errcode = '55000';
  end if;

  insert into money.treasury_fundings(
    provider, provider_transfer_id, route_id, user_id, asset_code,
    amount_micros, state, funding_transfer_seq, settled_event_id, settled_at
  ) values (
    p_provider, p_provider_transfer_id, v_route.id, v_route.user_id, p_asset_code,
    p_amount_micros, 'settled', v_post.transfer_seq, p_provider_event_id, p_occurred_at
  ) returning * into v_funding;

  v_recovery := least(p_amount_micros, greatest(-v_pre_balance, 0));
  v_remaining := v_recovery;
  for v_exposure in
    select * from money.treasury_exposures
    where user_id = v_route.user_id and state = 'open'
    order by created_at, id
    for update
  loop
    exit when v_remaining <= 0;
    v_apply := least(v_remaining, v_exposure.amount_micros - v_exposure.recovered_micros);
    update money.treasury_exposures set
      recovered_micros = recovered_micros + v_apply,
      state = case when recovered_micros + v_apply = amount_micros then 'recovered' else 'open' end,
      resolved_at = case when recovered_micros + v_apply = amount_micros then clock_timestamp() else null end
    where id = v_exposure.id;
    v_remaining := v_remaining - v_apply;
  end loop;

  select available_micros into v_balance from money.balances
  where account_id = v_route.user_id and asset_code = p_asset_code;
  return query select 'settled', v_event_replay or v_post.replayed, v_funding.id,
    v_post.transfer_id, v_post.receipt_id, v_balance, v_recovery - v_remaining;
end;
$$;

create or replace function money_private.return_treasury_funding(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_provider_transfer_id text,
  p_asset_code text,
  p_amount_micros bigint,
  p_reason text,
  p_occurred_at timestamptz,
  p_payload_hash bytea,
  p_canonical_payload jsonb
)
returns table (
  result_status text, replayed boolean, funding_id uuid,
  transfer_id uuid, receipt_id uuid, user_balance_micros bigint,
  opened_exposure_micros bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_replay boolean;
  v_funding money.treasury_fundings%rowtype;
  v_post record;
  v_transfer money.transfers%rowtype;
  v_receipt_id uuid;
  v_pre_balance bigint;
  v_balance bigint;
  v_exposure bigint;
  v_total_exposure bigint;
  v_key text;
begin
  if p_provider <> 'column' or p_event_type <> 'ach.incoming_transfer.returned' or p_asset_code <> 'USD' or
     p_amount_micros is null or p_amount_micros <= 0 or p_amount_micros % 10000 <> 0 or
     char_length(p_reason) not between 1 and 500 or p_occurred_at is null or
     p_occurred_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid funding return evidence' using errcode = '22023';
  end if;
  v_event_replay := money_private.record_treasury_provider_event(
    p_provider, p_provider_event_id, p_event_type, p_provider_transfer_id,
    p_payload_hash, p_canonical_payload
  );
  perform pg_advisory_xact_lock(hashtext('treasury-funding:' || p_provider || ':' || p_provider_transfer_id));
  select * into v_funding from money.treasury_fundings
  where provider = p_provider and provider_transfer_id = p_provider_transfer_id
  for update;
  if v_funding.id is null then
    raise exception 'settled funding does not exist yet for provider return' using errcode = 'P0002';
  end if;
  if v_funding.amount_micros <> p_amount_micros or v_funding.asset_code <> p_asset_code then
    raise exception 'funding return does not match original settled amount' using errcode = '22023';
  end if;
  if v_funding.state = 'returned' then
    update money.treasury_provider_events set outcome = 'duplicate'
    where provider = p_provider and provider_event_id = p_provider_event_id and not v_event_replay;
    select * into v_transfer from money.transfers
    where seq = v_funding.return_transfer_seq;
    select id into v_receipt_id from money.receipts
    where transfer_seq = v_funding.return_transfer_seq;
    select available_micros into v_balance from money.balances
    where account_id = v_funding.user_id and asset_code = p_asset_code;
    return query select 'returned', true, v_funding.id,
      v_transfer.id, v_receipt_id, v_balance, 0::bigint;
    return;
  end if;

  select available_micros into v_pre_balance from money.balances
  where account_id = v_funding.user_id and asset_code = p_asset_code
  for update;
  v_pre_balance := coalesce(v_pre_balance, 0);
  v_key := 'fret_' || encode(public.digest(p_provider || ':' || p_provider_transfer_id, 'sha256'), 'hex');
  select * into v_post from money_private.post_treasury_transfer(
    'external:funding', 'funding_return', v_key,
    v_funding.user_id, 'external:funding', p_asset_code, p_amount_micros,
    'provider funding return', jsonb_build_object(
      'provider', p_provider, 'providerTransferId', p_provider_transfer_id,
      'providerEventId', p_provider_event_id, 'fundingId', v_funding.id,
      'reason', p_reason
    )
  );
  if v_post.status <> 'posted' then
    raise exception 'funding return journal command was denied: %', v_post.denial_code using errcode = '55000';
  end if;
  update money.treasury_fundings set
    state = 'returned', return_transfer_seq = v_post.transfer_seq,
    returned_event_id = p_provider_event_id, returned_at = p_occurred_at,
    updated_at = clock_timestamp()
  where id = v_funding.id
  returning * into v_funding;

  v_exposure := greatest(p_amount_micros - greatest(v_pre_balance, 0), 0);
  if v_exposure > 0 then
    insert into money.treasury_exposures(user_id, funding_id, amount_micros, reason)
    values (v_funding.user_id, v_funding.id, v_exposure, p_reason);
  end if;

  -- Record only accounts this command actually changes from active to frozen.
  -- A later release therefore cannot thaw an independently frozen account.
  insert into money.treasury_freezes(user_id, account_id, funding_id, reason)
  select v_funding.user_id, a.id, v_funding.id, p_reason
  from money.accounts a
  where (a.id = v_funding.user_id or a.owner_id = v_funding.user_id)
    and a.status = 'active'
  on conflict (account_id) where released_at is null do nothing;
  update money.accounts a set status = 'frozen', updated_at = clock_timestamp()
  where exists (
    select 1 from money.treasury_freezes f
    where f.account_id = a.id and f.user_id = v_funding.user_id and f.released_at is null
  );

  select coalesce(sum(amount_micros - recovered_micros), 0)::bigint into v_total_exposure
  from money.treasury_exposures where state = 'open';
  if exists (
    select 1 from money.treasury_controls
    where singleton and v_total_exposure > max_open_exposure_micros
  ) then
    perform money_private.trip_treasury_breaker(
      'open funding-return exposure exceeded configured maximum'
    );
  end if;

  select available_micros into v_balance from money.balances
  where account_id = v_funding.user_id and asset_code = p_asset_code;
  return query select 'returned', v_event_replay or v_post.replayed, v_funding.id,
    v_post.transfer_id, v_post.receipt_id, v_balance, v_exposure;
end;
$$;

create or replace function money_private.request_treasury_payout(
  p_source_account_id text,
  p_idempotency_key text,
  p_destination_id uuid,
  p_asset_code text,
  p_amount_micros bigint
)
returns table (
  result_status text, replayed boolean, payout_id uuid,
  transfer_id uuid, receipt_id uuid, denial_code text, reason text,
  source_balance_micros bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control money.treasury_controls%rowtype;
  v_destination money.treasury_destinations%rowtype;
  v_source money.accounts%rowtype;
  v_post record;
  v_payout money.treasury_payouts%rowtype;
  v_pending bigint;
begin
  if char_length(p_idempotency_key) not between 1 and 128 or p_amount_micros is null or p_amount_micros <= 0 or
     p_amount_micros % 10000 <> 0 then
    raise exception 'payout must be positive whole cents with a valid idempotency key' using errcode = '22023';
  end if;
  select * into v_control from money.treasury_controls where singleton for update;

  -- Serialize on the control row, then replay a completed reservation before
  -- evaluating mutable breaker/cap/destination state. A retry must return the
  -- original result even when operations disabled payouts afterward.
  if exists (
    select 1 from money.idempotency_keys k
    where k.actor_id = p_source_account_id and k.operation = 'payout_hold'
      and k.idempotency_key = p_idempotency_key
  ) then
    select * into v_destination from money.treasury_destinations
    where id = p_destination_id;
    select * into v_post from money_private.post_treasury_transfer(
      p_source_account_id, 'payout_hold', p_idempotency_key,
      p_source_account_id, 'external:payout', p_asset_code, p_amount_micros,
      'customer payout reserve', jsonb_build_object(
        'destinationId', p_destination_id, 'provider', v_destination.provider
      )
    );
    if v_post.status = 'denied' then
      return query select 'denied', true, null::uuid, null::uuid, null::uuid,
        v_post.denial_code, v_post.reason, v_post.from_balance_micros;
      return;
    end if;
    select * into v_payout from money.treasury_payouts
    where source_account_id = p_source_account_id and idempotency_key = p_idempotency_key;
    if v_payout.id is null then
      raise exception 'payout journal replay has no lifecycle row' using errcode = '55000';
    end if;
    return query select v_payout.state, true, v_payout.id,
      v_post.transfer_id, v_post.receipt_id, null::text, null::text,
      v_post.from_balance_micros;
    return;
  end if;

  if not v_control.payouts_enabled then
    raise exception 'treasury payout circuit breaker is open' using errcode = '55000';
  end if;
  if p_amount_micros > v_control.max_payout_micros then
    return query select 'denied', false, null::uuid, null::uuid, null::uuid,
      'payout_cap', 'payout exceeds the configured per-request maximum', null::bigint;
    return;
  end if;
  select coalesce(sum(amount_micros), 0)::bigint into v_pending
  from money.treasury_payouts
  where state in ('queued', 'submitting', 'submitted', 'manual_review');
  if v_pending + p_amount_micros > v_control.max_pending_payout_micros then
    return query select 'denied', false, null::uuid, null::uuid, null::uuid,
      'payout_capacity', 'aggregate pending payouts exceed the configured maximum', null::bigint;
    return;
  end if;

  select * into v_source from money.accounts where id = p_source_account_id for update;
  if v_source.id is null or v_source.kind not in ('user', 'provider') or v_source.status <> 'active' then
    raise exception 'payout source must be an active user or provider' using errcode = '42501';
  end if;
  select * into v_destination from money.treasury_destinations
  where id = p_destination_id for update;
  if v_destination.id is null or v_destination.account_id <> p_source_account_id or v_destination.status <> 'verified' then
    raise exception 'verified payout destination is not owned by the source account' using errcode = '42501';
  end if;

  select * into v_post from money_private.post_treasury_transfer(
    p_source_account_id, 'payout_hold', p_idempotency_key,
    p_source_account_id, 'external:payout', p_asset_code, p_amount_micros,
    'customer payout reserve', jsonb_build_object(
      'destinationId', p_destination_id, 'provider', v_destination.provider
    )
  );
  if v_post.status = 'denied' then
    return query select 'denied', v_post.replayed, null::uuid, null::uuid, null::uuid,
      v_post.denial_code, v_post.reason, v_post.from_balance_micros;
    return;
  end if;

  if v_post.replayed then
    select * into v_payout from money.treasury_payouts
    where source_account_id = p_source_account_id and idempotency_key = p_idempotency_key;
    if v_payout.id is null then
      raise exception 'payout journal replay has no lifecycle row' using errcode = '55000';
    end if;
  else
    insert into money.treasury_payouts(
      source_account_id, destination_id, provider, asset_code,
      amount_micros, idempotency_key, hold_transfer_seq
    ) values (
      p_source_account_id, p_destination_id, v_destination.provider, p_asset_code,
      p_amount_micros, p_idempotency_key, v_post.transfer_seq
    ) returning * into v_payout;
  end if;
  return query select v_payout.state, v_post.replayed, v_payout.id,
    v_post.transfer_id, v_post.receipt_id, null::text, null::text,
    v_post.from_balance_micros;
end;
$$;

create or replace function money_private.cancel_treasury_payout(
  p_source_account_id text,
  p_payout_id uuid
)
returns table (
  result_status text, replayed boolean, payout_id uuid,
  reversal_transfer_id uuid, receipt_id uuid, denial_code text, reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout money.treasury_payouts%rowtype;
  v_post record;
  v_transfer_id uuid;
  v_receipt_id uuid;
begin
  select * into v_payout from money.treasury_payouts
  where id = p_payout_id and source_account_id = p_source_account_id
  for update;
  if v_payout.id is null then
    raise exception 'treasury payout not found' using errcode = 'P0002';
  end if;
  if v_payout.state = 'cancelled' then
    select t.id, r.id into v_transfer_id, v_receipt_id
    from money.transfers t join money.receipts r on r.transfer_seq = t.seq
    where t.seq = v_payout.reversal_transfer_seq;
    return query select 'cancelled', true, v_payout.id, v_transfer_id, v_receipt_id,
      null::text, null::text;
    return;
  end if;
  if v_payout.state <> 'queued' or v_payout.attempts <> 0 then
    return query select 'denied', false, v_payout.id, null::uuid, null::uuid,
      'payout_not_cancellable', 'payout has already entered provider submission', null::text;
    return;
  end if;
  select * into v_post from money_private.post_treasury_transfer(
    'external:payout', 'payout_reversal', 'pcan_' || v_payout.id::text,
    'external:payout', v_payout.source_account_id, v_payout.asset_code, v_payout.amount_micros,
    'cancelled customer payout', jsonb_build_object('payoutId', v_payout.id, 'reason', 'customer_cancelled')
  );
  if v_post.status <> 'posted' then
    raise exception 'payout cancellation reversal was denied: %', v_post.denial_code using errcode = '55000';
  end if;
  update money.treasury_payouts set
    state = 'cancelled', reversal_transfer_seq = v_post.transfer_seq,
    terminal_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_payout.id;
  return query select 'cancelled', v_post.replayed, v_payout.id,
    v_post.transfer_id, v_post.receipt_id, null::text, null::text;
end;
$$;

create or replace function money_private.claim_treasury_payouts(
  p_worker_id text,
  p_limit integer
)
returns table (
  payout_id uuid, provider text, provider_ref text, source_account_id text,
  asset_code text, amount_micros bigint, attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare v_stale integer;
begin
  if char_length(p_worker_id) not between 1 and 128 or p_limit not between 1 and 1000 then
    raise exception 'invalid treasury payout worker claim' using errcode = '22023';
  end if;
  -- A request whose provider idempotency key may have expired is never
  -- blindly retried. It enters manual review and opens every spend breaker.
  with stale as (
    update money.treasury_payouts p set
      state = 'manual_review', locked_at = null, locked_by = null,
      last_error = 'provider outcome unknown beyond idempotency retention window',
      updated_at = clock_timestamp()
    where p.state = 'submitting' and p.attempts > 0
      and p.first_attempt_at < clock_timestamp() - interval '29 days'
      and p.locked_at < clock_timestamp() - interval '2 minutes'
    returning 1
  ) select count(*) into v_stale from stale;
  if v_stale > 0 then
    perform money_private.trip_treasury_breaker(
      'payout provider outcome exceeded idempotency retention window'
    );
  end if;

  update money.treasury_payouts p set
    state = 'queued', locked_at = null, locked_by = null,
    available_at = clock_timestamp(), last_error = 'payout worker lease expired',
    updated_at = clock_timestamp()
  where p.state = 'submitting' and p.locked_at < clock_timestamp() - interval '2 minutes'
    and (p.first_attempt_at is null or p.first_attempt_at >= clock_timestamp() - interval '29 days');

  -- Finish lease recovery above even while stopped, but never hand new work
  -- to a bank-facing process while the payout breaker is open.
  perform 1 from money.treasury_controls where singleton and payouts_enabled for update;
  if not found then return; end if;

  return query
    with claims as (
      select p.id from money.treasury_payouts p
      join money.treasury_destinations d on d.id = p.destination_id and d.status = 'verified'
      where p.state = 'queued' and p.available_at <= clock_timestamp()
      order by p.available_at, p.requested_at, p.id
      limit p_limit
      for update skip locked
    ), updated as (
      update money.treasury_payouts p set
        state = 'submitting', locked_at = clock_timestamp(), locked_by = p_worker_id,
        attempts = p.attempts + 1,
        first_attempt_at = coalesce(p.first_attempt_at, clock_timestamp()),
        updated_at = clock_timestamp()
      from claims where p.id = claims.id
      returning p.*
    )
    select u.id, u.provider, d.provider_ref, u.source_account_id,
      u.asset_code, u.amount_micros, u.attempts
    from updated u join money.treasury_destinations d on d.id = u.destination_id
    order by u.requested_at, u.id;
end;
$$;

create or replace function money_private.release_treasury_payout_claim(
  p_worker_id text,
  p_payout_id uuid,
  p_error text,
  p_retry_after_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if char_length(p_error) not between 1 and 1000 or p_retry_after_seconds not between 0 and 86400 then
    raise exception 'invalid payout provider failure' using errcode = '22023';
  end if;
  update money.treasury_payouts set
    state = 'queued', locked_at = null, locked_by = null, last_error = p_error,
    available_at = clock_timestamp() + make_interval(secs => p_retry_after_seconds),
    updated_at = clock_timestamp()
  where id = p_payout_id and state = 'submitting' and locked_by = p_worker_id;
  if not found then
    raise exception 'payout worker does not own this claim' using errcode = '42501';
  end if;
  return true;
end;
$$;

create or replace function money_private.fail_treasury_payout_submission(
  p_worker_id text,
  p_payout_id uuid,
  p_error text
)
returns table (payout_id uuid, state text, reversal_transfer_id uuid, receipt_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout money.treasury_payouts%rowtype;
  v_post record;
begin
  if char_length(p_error) not between 1 and 1000 then
    raise exception 'invalid definitive payout failure' using errcode = '22023';
  end if;
  select * into v_payout from money.treasury_payouts
  where id = p_payout_id for update;
  if v_payout.id is null then raise exception 'treasury payout not found' using errcode = 'P0002'; end if;
  if v_payout.state = 'failed' then
    return query
      select v_payout.id, v_payout.state, t.id, r.id
      from money.transfers t join money.receipts r on r.transfer_seq = t.seq
      where t.seq = v_payout.reversal_transfer_seq;
    return;
  end if;
  if v_payout.state <> 'submitting' or v_payout.locked_by <> p_worker_id then
    raise exception 'payout worker does not own this failed submission' using errcode = '42501';
  end if;
  select * into v_post from money_private.post_treasury_transfer(
    'external:payout', 'payout_reversal', 'pfail_' || v_payout.id::text,
    'external:payout', v_payout.source_account_id, v_payout.asset_code, v_payout.amount_micros,
    'definitive provider payout rejection', jsonb_build_object(
      'payoutId', v_payout.id, 'reason', p_error
    )
  );
  if v_post.status <> 'posted' then
    raise exception 'failed payout reversal was denied: %', v_post.denial_code using errcode = '55000';
  end if;
  update money.treasury_payouts set
    state = 'failed', reversal_transfer_seq = v_post.transfer_seq,
    locked_at = null, locked_by = null, last_error = p_error,
    terminal_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_payout.id;
  return query select v_payout.id, 'failed'::text, v_post.transfer_id, v_post.receipt_id;
end;
$$;

create or replace function money_private.mark_treasury_payout_manual_review(
  p_worker_id text,
  p_payout_id uuid,
  p_provider_transfer_id text,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (p_provider_transfer_id is not null and char_length(p_provider_transfer_id) not between 3 and 255) or
     char_length(p_error) not between 1 and 1000 then
    raise exception 'invalid payout manual review evidence' using errcode = '22023';
  end if;
  update money.treasury_payouts set
    state = 'manual_review', provider_transfer_id = coalesce(p_provider_transfer_id, provider_transfer_id),
    locked_at = null, locked_by = null, last_error = p_error,
    updated_at = clock_timestamp()
  where id = p_payout_id and state = 'submitting' and locked_by = p_worker_id;
  if not found then
    raise exception 'payout worker does not own this manual review submission' using errcode = '42501';
  end if;
  perform money_private.trip_treasury_breaker(
    'ambiguous payout provider outcome for ' || p_payout_id::text
  );
  return true;
end;
$$;

create or replace function money_private.resolve_treasury_payout_review(
  p_payout_id uuid,
  p_resolved_state text,
  p_provider_transfer_id text,
  p_review_reference text,
  p_reason text
)
returns table (
  payout_id uuid, state text, replayed boolean,
  reversal_transfer_id uuid, receipt_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout money.treasury_payouts%rowtype;
  v_review money.treasury_payout_reviews%rowtype;
  v_provider_transfer_id text;
  v_post record;
  v_transfer_id uuid;
  v_receipt_id uuid;
begin
  if p_resolved_state not in ('submitted', 'settled', 'failed', 'returned', 'cancelled') or
     (p_provider_transfer_id is not null and char_length(p_provider_transfer_id) not between 3 and 255) or
     char_length(p_review_reference) not between 3 and 100 or
     char_length(p_reason) not between 3 and 500 then
    raise exception 'invalid payout review resolution' using errcode = '22023';
  end if;

  select * into v_payout from money.treasury_payouts where id = p_payout_id for update;
  if v_payout.id is null then raise exception 'treasury payout not found' using errcode = 'P0002'; end if;
  select * into v_review from money.treasury_payout_reviews where money.treasury_payout_reviews.payout_id = p_payout_id;
  if v_review.id is not null then
    if v_review.resolved_state <> p_resolved_state or
       (p_provider_transfer_id is not null and v_review.provider_transfer_id is distinct from p_provider_transfer_id) or
       v_review.review_reference <> p_review_reference or v_review.reason <> p_reason then
      raise exception 'payout review was already resolved with different terms' using errcode = '22023';
    end if;
    if v_review.reversal_transfer_seq is not null then
      select t.id, r.id into v_transfer_id, v_receipt_id
      from money.transfers t join money.receipts r on r.transfer_seq = t.seq
      where t.seq = v_review.reversal_transfer_seq;
    end if;
    return query select v_payout.id, v_payout.state, true, v_transfer_id, v_receipt_id;
    return;
  end if;
  if v_payout.state <> 'manual_review' then
    raise exception 'payout is not awaiting manual review' using errcode = '55000';
  end if;
  if exists (
    select 1 from money.treasury_controls
    where singleton and (funding_enabled or payouts_enabled or external_spend_enabled)
  ) then
    raise exception 'all treasury breakers must remain open during payout review' using errcode = '55000';
  end if;
  if v_payout.provider_transfer_id is not null and p_provider_transfer_id is not null and
     v_payout.provider_transfer_id <> p_provider_transfer_id then
    raise exception 'reviewed provider transfer id does not match existing evidence' using errcode = '22023';
  end if;
  v_provider_transfer_id := coalesce(p_provider_transfer_id, v_payout.provider_transfer_id);
  if p_resolved_state in ('submitted', 'settled', 'returned', 'cancelled') and v_provider_transfer_id is null then
    raise exception 'review resolution requires the verified provider transfer id' using errcode = '22023';
  end if;

  if p_resolved_state in ('failed', 'returned', 'cancelled') then
    select * into v_post from money_private.post_treasury_transfer(
      'external:payout', 'payout_reversal', 'preview_' || v_payout.id::text,
      'external:payout', v_payout.source_account_id, v_payout.asset_code, v_payout.amount_micros,
      'reviewed payout reversal', jsonb_build_object(
        'payoutId', v_payout.id, 'providerTransferId', v_provider_transfer_id,
        'resolvedState', p_resolved_state, 'reviewReference', p_review_reference,
        'reason', p_reason
      )
    );
    if v_post.status <> 'posted' then
      raise exception 'reviewed payout reversal was denied: %', v_post.denial_code using errcode = '55000';
    end if;
    update money.treasury_payouts set
      provider_transfer_id = v_provider_transfer_id, state = p_resolved_state,
      reversal_transfer_seq = v_post.transfer_seq, terminal_at = clock_timestamp(),
      last_error = p_reason, updated_at = clock_timestamp()
    where id = v_payout.id
    returning * into v_payout;
    v_transfer_id := v_post.transfer_id;
    v_receipt_id := v_post.receipt_id;
  else
    update money.treasury_payouts set
      provider_transfer_id = v_provider_transfer_id, state = p_resolved_state,
      submitted_at = coalesce(submitted_at, clock_timestamp()),
      settled_at = case when p_resolved_state = 'settled' then clock_timestamp() else null end,
      terminal_at = case when p_resolved_state = 'settled' then clock_timestamp() else null end,
      last_error = null, updated_at = clock_timestamp()
    where id = v_payout.id
    returning * into v_payout;
  end if;

  insert into money.treasury_payout_reviews(
    payout_id, resolved_state, provider_transfer_id, review_reference,
    reason, reversal_transfer_seq
  ) values (
    v_payout.id, p_resolved_state, v_provider_transfer_id, p_review_reference,
    p_reason, v_payout.reversal_transfer_seq
  );
  return query select v_payout.id, v_payout.state, false, v_transfer_id, v_receipt_id;
end;
$$;

create or replace function money_private.record_treasury_payout_submission(
  p_worker_id text,
  p_payout_id uuid,
  p_provider_transfer_id text,
  p_provider_state text
)
returns table (
  payout_id uuid, state text, replayed boolean,
  reversal_transfer_id uuid, receipt_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout money.treasury_payouts%rowtype;
  v_post record;
  v_terminal text;
begin
  if char_length(p_provider_transfer_id) not between 3 and 255 or
     p_provider_state not in ('submitted', 'settled', 'failed', 'returned', 'cancelled', 'manual_review') then
    raise exception 'invalid provider payout submission result' using errcode = '22023';
  end if;
  select * into v_payout from money.treasury_payouts where id = p_payout_id for update;
  if v_payout.id is null then raise exception 'treasury payout not found' using errcode = 'P0002'; end if;
  if v_payout.state <> 'submitting' or v_payout.locked_by <> p_worker_id then
    if v_payout.provider_transfer_id = p_provider_transfer_id then
      return query select v_payout.id, v_payout.state, true, null::uuid, null::uuid;
      return;
    end if;
    raise exception 'payout worker does not own this submission' using errcode = '42501';
  end if;

  if p_provider_state in ('failed', 'returned', 'cancelled') then
    select * into v_post from money_private.post_treasury_transfer(
      'external:payout', 'payout_reversal', 'prev_' || v_payout.id::text,
      'external:payout', v_payout.source_account_id, v_payout.asset_code, v_payout.amount_micros,
      'provider payout reversal', jsonb_build_object(
        'payoutId', v_payout.id, 'providerTransferId', p_provider_transfer_id,
        'providerState', p_provider_state
      )
    );
    if v_post.status <> 'posted' then
      raise exception 'provider payout reversal was denied: %', v_post.denial_code using errcode = '55000';
    end if;
    v_terminal := p_provider_state;
    update money.treasury_payouts set
      provider_transfer_id = p_provider_transfer_id, state = v_terminal,
      reversal_transfer_seq = v_post.transfer_seq,
      submitted_at = clock_timestamp(), terminal_at = clock_timestamp(),
      locked_at = null, locked_by = null, last_error = null, updated_at = clock_timestamp()
    where id = v_payout.id;
    return query select v_payout.id, v_terminal, false, v_post.transfer_id, v_post.receipt_id;
    return;
  end if;

  update money.treasury_payouts set
    provider_transfer_id = p_provider_transfer_id,
    state = p_provider_state,
    submitted_at = clock_timestamp(),
    settled_at = case when p_provider_state = 'settled' then clock_timestamp() else null end,
    terminal_at = case when p_provider_state = 'settled' then clock_timestamp() else null end,
    locked_at = null, locked_by = null, last_error = null, updated_at = clock_timestamp()
  where id = v_payout.id;
  if p_provider_state = 'manual_review' then
    perform money_private.trip_treasury_breaker(
      'provider placed payout into manual review for ' || v_payout.id::text
    );
  end if;
  return query select v_payout.id, p_provider_state, false, null::uuid, null::uuid;
end;
$$;

create or replace function money_private.transition_treasury_payout(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_provider_transfer_id text,
  p_provider_state text,
  p_asset_code text,
  p_amount_micros bigint,
  p_occurred_at timestamptz,
  p_payload_hash bytea,
  p_canonical_payload jsonb
)
returns table (
  result_status text, replayed boolean, payout_id uuid,
  reversal_transfer_id uuid, receipt_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_replay boolean;
  v_payout money.treasury_payouts%rowtype;
  v_post record;
begin
  if p_provider <> 'column' or p_event_type !~ '^ach\.outgoing_transfer\.' or p_asset_code <> 'USD' or
     p_provider_state not in ('submitted', 'settled', 'failed', 'returned', 'cancelled', 'manual_review') or
     p_amount_micros is null or p_amount_micros <= 0 or p_amount_micros % 10000 <> 0 or p_occurred_at is null or
     p_occurred_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid normalized payout transition' using errcode = '22023';
  end if;
  v_event_replay := money_private.record_treasury_provider_event(
    p_provider, p_provider_event_id, p_event_type, p_provider_transfer_id,
    p_payload_hash, p_canonical_payload
  );
  select * into v_payout from money.treasury_payouts
  where provider = p_provider and provider_transfer_id = p_provider_transfer_id
  for update;
  if v_payout.id is null then
    raise exception 'submitted payout does not exist yet for provider event' using errcode = 'P0002';
  end if;
  if v_payout.asset_code <> p_asset_code or v_payout.amount_micros <> p_amount_micros then
    raise exception 'provider payout transition does not match reserved payout' using errcode = '22023';
  end if;
  if v_event_replay then
    return query select v_payout.state, true, v_payout.id, null::uuid, null::uuid;
    return;
  end if;

  if v_payout.state in ('failed', 'returned', 'cancelled') then
    update money.treasury_provider_events set outcome = 'duplicate'
    where provider = p_provider and provider_event_id = p_provider_event_id;
    return query select v_payout.state, true, v_payout.id, null::uuid, null::uuid;
    return;
  end if;
  if v_payout.state = 'settled' and p_provider_state <> 'returned' then
    update money.treasury_provider_events set outcome = 'ignored'
    where provider = p_provider and provider_event_id = p_provider_event_id;
    return query select v_payout.state, false, v_payout.id, null::uuid, null::uuid;
    return;
  end if;

  if p_provider_state in ('failed', 'returned', 'cancelled') then
    select * into v_post from money_private.post_treasury_transfer(
      'external:payout', 'payout_reversal', 'prev_' || v_payout.id::text,
      'external:payout', v_payout.source_account_id, v_payout.asset_code, v_payout.amount_micros,
      'provider payout reversal', jsonb_build_object(
        'payoutId', v_payout.id, 'providerTransferId', p_provider_transfer_id,
        'providerEventId', p_provider_event_id, 'providerState', p_provider_state
      )
    );
    if v_post.status <> 'posted' then
      raise exception 'provider payout reversal was denied: %', v_post.denial_code using errcode = '55000';
    end if;
    update money.treasury_payouts set
      state = p_provider_state, reversal_transfer_seq = v_post.transfer_seq,
      locked_at = null, locked_by = null, terminal_at = p_occurred_at,
      last_error = null, updated_at = clock_timestamp()
    where id = v_payout.id;
    return query select p_provider_state, v_post.replayed, v_payout.id,
      v_post.transfer_id, v_post.receipt_id;
    return;
  end if;

  update money.treasury_payouts set
    state = p_provider_state,
    submitted_at = coalesce(submitted_at, p_occurred_at),
    settled_at = case when p_provider_state = 'settled' then p_occurred_at else settled_at end,
    terminal_at = case when p_provider_state = 'settled' then p_occurred_at else terminal_at end,
    locked_at = null, locked_by = null, last_error = null, updated_at = clock_timestamp()
  where id = v_payout.id;
  if p_provider_state = 'manual_review' then
    perform money_private.trip_treasury_breaker(
      'provider event placed payout into manual review for ' || v_payout.id::text
    );
  end if;
  return query select p_provider_state, false, v_payout.id, null::uuid, null::uuid;
end;
$$;

create or replace function money_private.configure_treasury_controls(
  p_funding_enabled boolean,
  p_payouts_enabled boolean,
  p_external_spend_enabled boolean,
  p_max_payout_micros bigint,
  p_max_pending_payout_micros bigint,
  p_max_open_exposure_micros bigint,
  p_max_reconciliation_variance_micros bigint,
  p_reason text
)
returns table (
  funding_enabled boolean, payouts_enabled boolean, external_spend_enabled boolean,
  max_payout_micros bigint, max_pending_payout_micros bigint,
  max_open_exposure_micros bigint, max_reconciliation_variance_micros bigint,
  breaker_reason text, updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_funding_enabled is null or p_payouts_enabled is null or p_external_spend_enabled is null or
     p_max_payout_micros <= 0 or p_max_pending_payout_micros <= 0 or
     p_max_open_exposure_micros <= 0 or p_max_reconciliation_variance_micros < 0 or
     char_length(p_reason) not between 1 and 500 then
    raise exception 'invalid treasury controls' using errcode = '22023';
  end if;
  return query
    update money.treasury_controls c set
      funding_enabled = p_funding_enabled,
      payouts_enabled = p_payouts_enabled,
      external_spend_enabled = p_external_spend_enabled,
      max_payout_micros = p_max_payout_micros,
      max_pending_payout_micros = p_max_pending_payout_micros,
      max_open_exposure_micros = p_max_open_exposure_micros,
      max_reconciliation_variance_micros = p_max_reconciliation_variance_micros,
      breaker_reason = case
        when p_funding_enabled and p_payouts_enabled and p_external_spend_enabled then null else p_reason end,
      updated_at = clock_timestamp()
    where singleton
    returning c.funding_enabled, c.payouts_enabled, c.external_spend_enabled,
      c.max_payout_micros, c.max_pending_payout_micros,
      c.max_open_exposure_micros, c.max_reconciliation_variance_micros,
      c.breaker_reason, c.updated_at;
  insert into money.treasury_control_events(
    action, funding_enabled, payouts_enabled, external_spend_enabled,
    max_payout_micros, max_pending_payout_micros, max_open_exposure_micros,
    max_reconciliation_variance_micros, reason, database_actor
  ) values (
    'configured', p_funding_enabled, p_payouts_enabled, p_external_spend_enabled,
    p_max_payout_micros, p_max_pending_payout_micros, p_max_open_exposure_micros,
    p_max_reconciliation_variance_micros, p_reason, session_user
  );
end;
$$;

create or replace function money_private.trip_treasury_breaker(p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control money.treasury_controls%rowtype;
  v_changed boolean;
begin
  if char_length(p_reason) not between 1 and 500 then
    raise exception 'invalid treasury breaker reason' using errcode = '22023';
  end if;
  select * into v_control from money.treasury_controls where singleton for update;
  v_changed := v_control.funding_enabled or v_control.payouts_enabled or
    v_control.external_spend_enabled or v_control.breaker_reason is distinct from p_reason;
  update money.treasury_controls set
    funding_enabled = false, payouts_enabled = false, external_spend_enabled = false,
    breaker_reason = p_reason, updated_at = clock_timestamp()
  where singleton;
  if v_changed then
    insert into money.treasury_control_events(
      action, funding_enabled, payouts_enabled, external_spend_enabled,
      max_payout_micros, max_pending_payout_micros, max_open_exposure_micros,
      max_reconciliation_variance_micros, reason, database_actor
    )
    select 'tripped', funding_enabled, payouts_enabled, external_spend_enabled,
      max_payout_micros, max_pending_payout_micros, max_open_exposure_micros,
      max_reconciliation_variance_micros, p_reason, session_user
    from money.treasury_controls where singleton;
  end if;
  return v_changed;
end;
$$;

create or replace function money_private.restore_treasury_controls(p_reason text)
returns table (
  funding_enabled boolean, payouts_enabled boolean, external_spend_enabled boolean,
  max_payout_micros bigint, max_pending_payout_micros bigint,
  max_open_exposure_micros bigint, max_reconciliation_variance_micros bigint,
  breaker_reason text, updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control money.treasury_controls%rowtype;
  v_health_count integer;
  v_health_ok boolean;
  v_open_exposure bigint;
begin
  if char_length(p_reason) not between 3 and 500 then
    raise exception 'restore requires a reviewed reason/reference' using errcode = '22023';
  end if;
  select * into v_control from money.treasury_controls where singleton for update;
  if exists (select 1 from money.treasury_event_inbox where state = 'dead') or
     exists (select 1 from money.treasury_payouts where state = 'manual_review') or
     exists (
       select 1 from money.treasury_payouts p
       join money.treasury_destinations d on d.id = p.destination_id
       where p.state = 'queued' and d.status <> 'verified'
     ) then
    raise exception 'treasury review queues must be clear before restore' using errcode = '55000';
  end if;
  select count(*)::integer, coalesce(bool_and(h.within_tolerance), false)
    into v_health_count, v_health_ok
  from money_private.treasury_health() h;
  if v_health_count = 0 or not v_health_ok then
    raise exception 'fresh in-tolerance treasury reconciliation is required before restore' using errcode = '55000';
  end if;
  select coalesce(sum(amount_micros - recovered_micros), 0)::bigint into v_open_exposure
  from money.treasury_exposures where state = 'open';
  if v_open_exposure > v_control.max_open_exposure_micros then
    raise exception 'open treasury exposure exceeds the restore limit' using errcode = '55000';
  end if;
  return query select * from money_private.configure_treasury_controls(
    true, true, true,
    v_control.max_payout_micros, v_control.max_pending_payout_micros,
    v_control.max_open_exposure_micros, v_control.max_reconciliation_variance_micros,
    p_reason
  );
end;
$$;

create or replace function money_private.release_treasury_freeze(
  p_user_id text,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_count integer;
begin
  if char_length(p_reason) not between 1 and 500 then
    raise exception 'invalid treasury freeze release reason' using errcode = '22023';
  end if;
  perform 1 from money.accounts where id = p_user_id and kind = 'user' for update;
  if not found then raise exception 'treasury user not found' using errcode = 'P0002'; end if;
  select available_micros into v_balance from money.balances
  where account_id = p_user_id and asset_code = 'USD' for update;
  if coalesce(v_balance, 0) < 0 or exists (
    select 1 from money.treasury_exposures where user_id = p_user_id and state = 'open'
  ) then
    raise exception 'treasury exposure must be fully recovered before release' using errcode = '55000';
  end if;
  with released as (
    update money.treasury_freezes set
      released_at = clock_timestamp(), release_reason = p_reason
    where user_id = p_user_id and released_at is null
    returning account_id
  ), thawed as (
    update money.accounts a set status = 'active', updated_at = clock_timestamp()
    where a.id in (select account_id from released) and a.status = 'frozen'
    returning 1
  ) select count(*) into v_count from thawed;
  return v_count;
end;
$$;

create or replace function money_private.list_treasury_destinations(p_requester_id text)
returns table (
  id uuid, provider text, label text, status text,
  verified_at timestamptz, created_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select d.id, d.provider, d.label, d.status, d.verified_at, d.created_at
  from money.treasury_destinations d
  where d.account_id = p_requester_id
  order by d.created_at desc, d.id desc
$$;

create or replace function money_private.list_treasury_deposit_routes(p_requester_id text)
returns table (id uuid, provider text, label text, status text, created_at timestamptz)
language sql
security definer
set search_path = ''
stable
as $$
  select r.id, r.provider, r.label, r.status, r.created_at
  from money.treasury_deposit_routes r
  where r.user_id = p_requester_id
  order by r.created_at desc, r.id desc
$$;

create or replace function money_private.list_treasury_payouts(p_requester_id text, p_limit integer default 100)
returns table (
  id uuid, destination_id uuid, provider text, asset_code text, amount_micros bigint,
  state text, attempts integer, provider_transfer_id text, last_error text,
  requested_at timestamptz, submitted_at timestamptz, settled_at timestamptz, terminal_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if p_limit not between 1 and 500 then raise exception 'invalid treasury payout list limit' using errcode = '22023'; end if;
  return query
    select p.id, p.destination_id, p.provider, p.asset_code, p.amount_micros,
      p.state, p.attempts, p.provider_transfer_id, p.last_error,
      p.requested_at, p.submitted_at, p.settled_at, p.terminal_at
    from money.treasury_payouts p
    where p.source_account_id = p_requester_id
    order by p.requested_at desc, p.id desc
    limit p_limit;
end;
$$;

create or replace function money_private.get_treasury_payout(
  p_requester_id text,
  p_payout_id uuid
)
returns table (
  id uuid, destination_id uuid, provider text, asset_code text, amount_micros bigint,
  state text, attempts integer, provider_transfer_id text, last_error text,
  requested_at timestamptz, submitted_at timestamptz, settled_at timestamptz, terminal_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select p.id, p.destination_id, p.provider, p.asset_code, p.amount_micros,
    p.state, p.attempts, p.provider_transfer_id, p.last_error,
    p.requested_at, p.submitted_at, p.settled_at, p.terminal_at
  from money.treasury_payouts p
  where p.source_account_id = p_requester_id and p.id = p_payout_id
$$;

create or replace function money_private.list_treasury_fundings(p_requester_id text, p_limit integer default 100)
returns table (
  id uuid, provider text, asset_code text, amount_micros bigint, state text,
  settled_at timestamptz, returned_at timestamptz, created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if p_limit not between 1 and 500 then raise exception 'invalid treasury funding list limit' using errcode = '22023'; end if;
  return query
    select f.id, f.provider, f.asset_code, f.amount_micros, f.state,
      f.settled_at, f.returned_at, f.created_at
    from money.treasury_fundings f
    where f.user_id = p_requester_id
    order by f.created_at desc, f.id desc
    limit p_limit;
end;
$$;

create or replace function money_private.list_treasury_exposures(p_requester_id text, p_limit integer default 100)
returns table (
  id uuid, funding_id uuid, amount_micros bigint, recovered_micros bigint,
  state text, reason text, created_at timestamptz, resolved_at timestamptz
)
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if p_limit not between 1 and 500 then raise exception 'invalid treasury exposure list limit' using errcode = '22023'; end if;
  return query
    select e.id, e.funding_id, e.amount_micros, e.recovered_micros,
      e.state, e.reason, e.created_at, e.resolved_at
    from money.treasury_exposures e
    where e.user_id = p_requester_id
    order by e.created_at desc, e.id desc
    limit p_limit;
end;
$$;

create or replace function money_private.treasury_control_state()
returns table (
  funding_enabled boolean, payouts_enabled boolean, external_spend_enabled boolean,
  max_payout_micros bigint, max_pending_payout_micros bigint,
  max_open_exposure_micros bigint, max_reconciliation_variance_micros bigint,
  breaker_reason text, updated_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  select c.funding_enabled, c.payouts_enabled, c.external_spend_enabled,
    c.max_payout_micros, c.max_pending_payout_micros,
    c.max_open_exposure_micros, c.max_reconciliation_variance_micros,
    c.breaker_reason, c.updated_at
  from money.treasury_controls c where singleton
$$;

create or replace function money_private.treasury_health()
returns table (
  asset_code text,
  expected_asset_micros bigint,
  observed_asset_micros bigint,
  uncertain_outflow_micros bigint,
  shortfall_micros bigint,
  excess_micros bigint,
  open_exposure_micros bigint,
  active_asset_accounts integer,
  observed_asset_accounts integer,
  oldest_observed_at timestamptz,
  snapshot_complete boolean,
  within_tolerance boolean
)
language sql
security definer
set search_path = ''
stable
as $$
  with assets as (
    select code as asset_code from money.assets where enabled
  ), external_balance as (
    select b.asset_code, coalesce(sum(b.available_micros), 0)::bigint as external_micros
    from money.balances b join money.accounts a on a.id = b.account_id
    where a.kind = 'external'
    group by b.asset_code
  ), active_accounts as (
    select a.asset_code, count(*)::integer as account_count
    from money.treasury_asset_accounts a where a.active
    group by a.asset_code
  ), latest_snapshot as (
    select distinct on (s.asset_account_id)
      s.asset_account_id, s.asset_code, s.book_micros, s.observed_at
    from money.treasury_asset_snapshots s
    join money.treasury_asset_accounts a on a.id = s.asset_account_id and a.active
    order by s.asset_account_id, s.observed_at desc, s.id desc
  ), observed as (
    select asset_code, sum(book_micros)::bigint as observed_micros,
      count(*)::integer as observed_count, min(observed_at) as oldest_observed_at
    from latest_snapshot group by asset_code
  ), payout_uncertainty as (
    select asset_code, coalesce(sum(amount_micros), 0)::bigint as amount_micros
    from money.treasury_payouts
    where state in ('queued', 'submitting', 'submitted', 'manual_review')
    group by asset_code
  ), x402_uncertainty as (
    select 'USD'::text as asset_code, coalesce(sum(amount_micros), 0)::bigint as amount_micros
    from money.external_payments where state = 'pending'
  ), exposures as (
    select 'USD'::text as asset_code,
      coalesce(sum(amount_micros - recovered_micros), 0)::bigint as amount_micros
    from money.treasury_exposures where state = 'open'
  ), values_by_asset as (
    select a.asset_code,
      greatest(-coalesce(e.external_micros, 0), 0)::bigint as expected_micros,
      coalesce(o.observed_micros, 0)::bigint as observed_micros,
      (coalesce(p.amount_micros, 0) + coalesce(x.amount_micros, 0))::bigint as uncertain_micros,
      coalesce(ex.amount_micros, 0)::bigint as exposure_micros,
      coalesce(aa.account_count, 0)::integer as active_count,
      coalesce(o.observed_count, 0)::integer as observed_count,
      o.oldest_observed_at,
      c.max_reconciliation_variance_micros
    from assets a
    cross join money.treasury_controls c
    left join external_balance e on e.asset_code = a.asset_code
    left join observed o on o.asset_code = a.asset_code
    left join active_accounts aa on aa.asset_code = a.asset_code
    left join payout_uncertainty p on p.asset_code = a.asset_code
    left join x402_uncertainty x on x.asset_code = a.asset_code
    left join exposures ex on ex.asset_code = a.asset_code
    where c.singleton
  )
  select v.asset_code, v.expected_micros, v.observed_micros, v.uncertain_micros,
    greatest(v.expected_micros - v.observed_micros, 0)::bigint as shortfall_micros,
    greatest(v.observed_micros - (v.expected_micros + v.uncertain_micros), 0)::bigint as excess_micros,
    v.exposure_micros, v.active_count, v.observed_count, v.oldest_observed_at,
    (v.active_count > 0 and v.active_count = v.observed_count) as snapshot_complete,
    (
      v.active_count > 0 and v.active_count = v.observed_count and
      v.oldest_observed_at >= clock_timestamp() - interval '5 minutes' and
      greatest(
        greatest(v.expected_micros - v.observed_micros, 0),
        greatest(v.observed_micros - (v.expected_micros + v.uncertain_micros), 0)
      ) <= v.max_reconciliation_variance_micros
    ) as within_tolerance
  from values_by_asset v
  where v.expected_micros <> 0 or v.observed_micros <> 0 or v.active_count <> 0 or
    v.uncertain_micros <> 0 or v.exposure_micros <> 0
  order by v.asset_code
$$;

create or replace function money_private.record_treasury_asset_snapshot(
  p_provider text,
  p_provider_account_ref text,
  p_asset_code text,
  p_book_micros bigint,
  p_available_micros bigint,
  p_holding_micros bigint,
  p_locked_micros bigint,
  p_pending_micros bigint,
  p_provider_observation_id text,
  p_observed_at timestamptz
)
returns table (snapshot_id bigint, replayed boolean, within_tolerance boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account money.treasury_asset_accounts%rowtype;
  v_snapshot money.treasury_asset_snapshots%rowtype;
  v_health record;
begin
  if p_book_micros < 0 or p_available_micros < 0 or p_holding_micros < 0 or
     p_locked_micros < 0 or p_pending_micros < 0 or
     char_length(p_provider_observation_id) not between 1 and 255 or
     p_observed_at is null or p_observed_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid treasury asset snapshot' using errcode = '22023';
  end if;
  select * into v_account from money.treasury_asset_accounts
  where provider = p_provider and provider_account_ref = p_provider_account_ref
    and asset_code = p_asset_code and active
  for update;
  if v_account.id is null then
    raise exception 'treasury asset account is unknown or inactive' using errcode = 'P0002';
  end if;
  insert into money.treasury_asset_snapshots(
    asset_account_id, asset_code, book_micros, available_micros,
    holding_micros, locked_micros, pending_micros,
    provider_observation_id, observed_at
  ) values (
    v_account.id, p_asset_code, p_book_micros, p_available_micros,
    p_holding_micros, p_locked_micros, p_pending_micros,
    p_provider_observation_id, p_observed_at
  ) on conflict on constraint treasury_asset_snapshot_observation_uq do nothing
  returning * into v_snapshot;
  if v_snapshot.id is null then
    select * into v_snapshot from money.treasury_asset_snapshots
    where asset_account_id = v_account.id and provider_observation_id = p_provider_observation_id;
    if v_snapshot.book_micros <> p_book_micros or v_snapshot.available_micros <> p_available_micros or
       v_snapshot.holding_micros <> p_holding_micros or v_snapshot.locked_micros <> p_locked_micros or
       v_snapshot.pending_micros <> p_pending_micros or v_snapshot.observed_at <> p_observed_at then
      raise exception 'provider observation id was reused with different balances' using errcode = '22023';
    end if;
    select * into v_health from money_private.treasury_health() where asset_code = p_asset_code;
    return query select v_snapshot.id, true, coalesce(v_health.within_tolerance, false);
    return;
  end if;

  select * into v_health from money_private.treasury_health() where asset_code = p_asset_code;
  if coalesce(v_health.snapshot_complete, false) and not coalesce(v_health.within_tolerance, false) and
     v_health.oldest_observed_at >= clock_timestamp() - interval '5 minutes' then
    perform money_private.trip_treasury_breaker(
      'treasury asset reconciliation exceeded tolerance for ' || p_asset_code
    );
  end if;
  return query select v_snapshot.id, false, coalesce(v_health.within_tolerance, false);
end;
$$;

create or replace function money_private.enforce_treasury_external_spend_control()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'pending' and (tg_op = 'INSERT' or old.state is distinct from 'pending') and not exists (
    select 1 from money.treasury_controls where singleton and external_spend_enabled
  ) then
    raise exception 'treasury external-spend circuit breaker is open' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger external_payments_treasury_control
before insert or update of state on money.external_payments
for each row execute function money_private.enforce_treasury_external_spend_control();

-- Default-deny every treasury object and command. db/roles.sql grants only
-- the narrow surfaces needed by each process identity.
revoke all on table money.treasury_controls, money.treasury_control_events, money.treasury_deposit_routes,
  money.treasury_destinations, money.treasury_event_inbox, money.treasury_event_reviews,
  money.treasury_provider_events, money.treasury_fundings,
  money.treasury_exposures, money.treasury_freezes, money.treasury_payouts,
  money.treasury_payout_reviews,
  money.treasury_asset_accounts, money.treasury_asset_snapshots,
  money.treasury_poll_cursors from public;

revoke all on function
  money_private.register_treasury_deposit_route(text,text,text,text),
  money_private.register_treasury_destination(text,text,text,text),
  money_private.set_treasury_destination_status(text,uuid,text),
  money_private.register_treasury_asset_account(text,text,text,text),
  money_private.enqueue_treasury_provider_event(text,text,text,bytea),
  money_private.claim_treasury_provider_events(text,integer),
  money_private.complete_treasury_provider_event(text,bigint,text),
  money_private.fail_treasury_provider_event(text,bigint,text,integer,boolean),
  money_private.resolve_treasury_event_review(bigint,text,text,text),
  money_private.get_treasury_poll_cursor(text),
  money_private.set_treasury_poll_cursor(text,timestamptz),
  money_private.record_treasury_provider_event(text,text,text,text,bytea,jsonb),
  money_private.settle_treasury_funding(text,text,text,text,text,text,bigint,timestamptz,bytea,jsonb),
  money_private.return_treasury_funding(text,text,text,text,text,bigint,text,timestamptz,bytea,jsonb),
  money_private.request_treasury_payout(text,text,uuid,text,bigint),
  money_private.cancel_treasury_payout(text,uuid),
  money_private.claim_treasury_payouts(text,integer),
  money_private.release_treasury_payout_claim(text,uuid,text,integer),
  money_private.fail_treasury_payout_submission(text,uuid,text),
  money_private.mark_treasury_payout_manual_review(text,uuid,text,text),
  money_private.resolve_treasury_payout_review(uuid,text,text,text,text),
  money_private.record_treasury_payout_submission(text,uuid,text,text),
  money_private.transition_treasury_payout(text,text,text,text,text,text,bigint,timestamptz,bytea,jsonb),
  money_private.configure_treasury_controls(boolean,boolean,boolean,bigint,bigint,bigint,bigint,text),
  money_private.trip_treasury_breaker(text),
  money_private.restore_treasury_controls(text),
  money_private.release_treasury_freeze(text,text),
  money_private.list_treasury_destinations(text),
  money_private.list_treasury_deposit_routes(text),
  money_private.list_treasury_payouts(text,integer),
  money_private.get_treasury_payout(text,uuid),
  money_private.list_treasury_fundings(text,integer),
  money_private.list_treasury_exposures(text,integer),
  money_private.treasury_control_state(),
  money_private.treasury_health(),
  money_private.record_treasury_asset_snapshot(text,text,text,bigint,bigint,bigint,bigint,bigint,text,timestamptz)
from public;
