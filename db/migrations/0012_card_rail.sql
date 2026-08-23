-- Card issuing rail. A card is a reserved, capped, merchant-lockable permit under one
-- mandate. Issuing a card reserves its full cap from the agent's funds (one
-- card_reserve transfer, one receipt, at most one exact-tuple owner approval).
-- Authorizations are decided synchronously against that reserve by a role that can
-- only consume it; clearings, voids and refunds are ingested like treasury events by
-- a worker that re-fetches evidence from the issuer before any ledger command. The
-- unspent remainder returns to the agent's funds when the card closes; mandate
-- authority is never restored. No card number is ever stored in this database.

insert into money.accounts (id, kind, name)
values ('external:card', 'external', 'External card issuing settlement boundary')
on conflict (id) do nothing;

insert into money.balances (account_id, asset_code)
values ('external:card', 'USD')
on conflict (account_id, asset_code) do nothing;

alter table money.treasury_controls
  add column card_spend_enabled boolean not null default false;

alter table money.treasury_control_events
  add column card_spend_enabled boolean not null default false;

alter table money.treasury_control_events
  drop constraint treasury_control_events_action_check;

alter table money.treasury_control_events
  add constraint treasury_control_events_action_check
    check (action in ('configured', 'tripped', 'card_spend_configured'));

create table money.cards (
  id uuid primary key,
  agent_id text not null references money.accounts(id),
  mandate_id uuid not null references money.mandates(id),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  state text not null check (state in ('prepared', 'approval_required', 'cancelled', 'pending', 'confirmed', 'reversed')),
  cap_micros bigint not null check (cap_micros > 0 and cap_micros <= 10000000000),
  held_micros bigint not null default 0 check (held_micros >= 0),
  settled_micros bigint not null default 0 check (settled_micros >= 0),
  single_use boolean not null default true,
  merchant_hint text not null check (merchant_hint ~ '^[a-z0-9][a-z0-9.-]{0,99}$'),
  policy_payee text not null check (policy_payee = 'card:hint:' || merchant_hint),
  locked_payee text check (locked_payee is null or locked_payee ~ '^card:[0-9]{4}:[a-z0-9_.-]{1,64}$'),
  mcc_allowlist text[] check (mcc_allowlist is null or array_length(mcc_allowlist, 1) between 1 and 32),
  expires_at timestamptz not null,
  reverse_after timestamptz,
  approval_id uuid references money.approvals(id),
  transfer_seq bigint references money.transfers(seq),
  receipt_id uuid references money.receipts(id),
  release_transfer_seq bigint references money.transfers(seq),
  provider text check (provider is null or provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_card_ref text check (provider_card_ref is null or char_length(provider_card_ref) between 3 and 255),
  last4 text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  exp_month smallint check (exp_month is null or exp_month between 1 and 12),
  exp_year smallint check (exp_year is null or exp_year between 2026 and 2100),
  reveal_count integer not null default 0 check (reveal_count between 0 and 3),
  close_requested_at timestamptz,
  close_reason text check (close_reason is null or char_length(close_reason) <= 500),
  issuer_closed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint cards_agent_idempotency_unique unique (agent_id, idempotency_key),
  constraint cards_reserve_accounting_check check (held_micros + settled_micros <= cap_micros),
  constraint cards_provider_material_check check (
    (provider is null and provider_card_ref is null and last4 is null and exp_month is null and exp_year is null) or
    (provider is not null and provider_card_ref is not null and last4 is not null and exp_month is not null and exp_year is not null)
  ),
  constraint cards_issuer_close_check check (issuer_closed_at is null or provider_card_ref is not null),
  constraint cards_lifecycle_check check (
    (state = 'prepared' and approval_id is null and transfer_seq is null and receipt_id is null
       and provider_card_ref is null and release_transfer_seq is null and reverse_after is null
       and held_micros = 0 and settled_micros = 0) or
    (state in ('approval_required', 'cancelled') and transfer_seq is null and receipt_id is null
       and release_transfer_seq is null and reverse_after is null and held_micros = 0 and settled_micros = 0
       and (state <> 'approval_required' or (approval_id is not null and provider_card_ref is null))) or
    (state = 'pending' and transfer_seq is not null and receipt_id is not null and provider is not null
       and provider_card_ref is not null and last4 is not null and reverse_after is not null
       and release_transfer_seq is null) or
    (state = 'confirmed' and transfer_seq is not null and receipt_id is not null and provider_card_ref is not null
       and reverse_after is not null and held_micros = 0 and settled_micros > 0
       and (settled_micros = cap_micros or release_transfer_seq is not null)) or
    (state = 'reversed' and transfer_seq is not null and receipt_id is not null and provider_card_ref is not null
       and reverse_after is not null and held_micros = 0 and settled_micros = 0 and release_transfer_seq is not null)
  )
);

create unique index cards_provider_ref_unique
  on money.cards(provider, provider_card_ref)
  where provider_card_ref is not null;
create unique index cards_approval_idx
  on money.cards(approval_id)
  where approval_id is not null;
create index cards_agent_state_created_idx
  on money.cards(agent_id, state, created_at desc);
create index cards_live_mandate_idx
  on money.cards(mandate_id, state)
  where state in ('prepared', 'approval_required', 'pending');
create index cards_sweep_idx
  on money.cards(reverse_after)
  where state = 'pending';
create index cards_issuer_close_idx
  on money.cards(updated_at)
  where provider_card_ref is not null and issuer_closed_at is null;

create table money.card_authorizations (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references money.cards(id),
  agent_id text not null references money.accounts(id),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_event_id text not null check (char_length(provider_event_id) between 3 and 255),
  provider_authorization_ref text not null check (char_length(provider_authorization_ref) between 3 and 255),
  policy_payee text not null check (policy_payee ~ '^card:[0-9]{4}:[a-z0-9_.-]{1,64}$'),
  merchant_descriptor text not null check (char_length(merchant_descriptor) between 1 and 100),
  merchant_mcc text not null check (merchant_mcc ~ '^[0-9]{4}$'),
  merchant_network_id text check (merchant_network_id is null or char_length(merchant_network_id) between 1 and 64),
  merchant_country text check (merchant_country is null or merchant_country ~ '^[A-Z]{2,3}$'),
  amount_micros bigint not null check (amount_micros >= 0),
  -- Account-verification authorizations (<= $1) never consume single-use or the
  -- new-payee throttle; they still hold against the cap until cleared or voided.
  is_verification boolean not null default false,
  settled_micros bigint check (settled_micros is null or settled_micros >= 0),
  state text not null check (state in ('declined', 'pending', 'confirmed', 'reversed')),
  decline_code text check (decline_code is null or decline_code ~ '^[a-z_]{1,40}$'),
  reverse_after timestamptz,
  settled_event_id text check (settled_event_id is null or char_length(settled_event_id) between 3 and 255),
  voided_event_id text check (voided_event_id is null or char_length(voided_event_id) between 3 and 255),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint card_authorizations_provider_event_uq unique (provider, provider_event_id),
  constraint card_authorizations_lifecycle_check check (
    (state = 'declined' and decline_code is not null and settled_micros is null and reverse_after is null
       and settled_event_id is null and voided_event_id is null) or
    (state = 'pending' and decline_code is null and settled_micros is null and reverse_after is not null
       and settled_event_id is null and voided_event_id is null) or
    (state = 'confirmed' and decline_code is null and settled_micros is not null and settled_event_id is not null
       and reverse_after is not null and voided_event_id is null) or
    (state = 'reversed' and decline_code is null and settled_micros is null and settled_event_id is null
       and reverse_after is not null and (voided_event_id is not null or reverse_after < updated_at))
  )
);

create unique index card_authorizations_provider_ref_uq
  on money.card_authorizations(provider, provider_authorization_ref)
  where state <> 'declined';
create index card_authorizations_card_state_idx
  on money.card_authorizations(card_id, state, created_at desc);
create index card_authorizations_sweep_idx
  on money.card_authorizations(reverse_after)
  where state = 'pending';

create table money.card_refunds (
  id uuid primary key default gen_random_uuid(),
  authorization_id uuid not null references money.card_authorizations(id),
  card_id uuid not null references money.cards(id),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_event_id text not null check (char_length(provider_event_id) between 3 and 255),
  provider_refund_ref text not null check (char_length(provider_refund_ref) between 3 and 255),
  amount_micros bigint not null check (amount_micros > 0),
  transfer_seq bigint not null unique references money.transfers(seq),
  created_at timestamptz not null default clock_timestamp(),
  constraint card_refunds_provider_ref_uq unique (provider, provider_refund_ref)
);

create index card_refunds_authorization_idx
  on money.card_refunds(authorization_id, created_at desc);

create table money.card_reveal_tokens (
  token_hash bytea primary key check (octet_length(token_hash) = 32),
  card_id uuid not null references money.cards(id),
  agent_id text not null references money.accounts(id),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

create index card_reveal_tokens_card_idx
  on money.card_reveal_tokens(card_id, created_at desc);

-- Written out explicitly (not LIKE) so constraint names are ours: same columns,
-- states and lease semantics as money.treasury_event_inbox.
create table money.card_event_inbox (
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
  constraint card_event_inbox_provider_event_uq unique (provider, provider_event_id),
  constraint card_event_inbox_lease_check check (
    (state = 'processing' and locked_at is not null and locked_by is not null and completed_at is null) or
    (state in ('queued') and locked_at is null and locked_by is null and completed_at is null) or
    (state in ('completed', 'ignored', 'dead') and locked_at is null and locked_by is null and completed_at is not null)
  )
);

create index card_event_inbox_ready_idx
  on money.card_event_inbox(available_at, id)
  where state = 'queued';

-- Operator review of dead-lettered issuer events. Mirrors
-- money.treasury_event_reviews: every resolution of a dead card event leaves
-- an append-only audit row naming the database actor and the reason.
create table money.card_event_reviews (
  id uuid primary key default gen_random_uuid(),
  inbox_id bigint not null references money.card_event_inbox(id),
  resolution text not null check (resolution in ('retry', 'ignore')),
  prior_error text check (prior_error is null or char_length(prior_error) <= 1000),
  review_reference text not null check (char_length(review_reference) between 3 and 100),
  reason text not null check (char_length(reason) between 3 and 500),
  database_actor text not null check (char_length(database_actor) between 1 and 255),
  created_at timestamptz not null default clock_timestamp()
);

create index card_event_reviews_inbox_created_idx
  on money.card_event_reviews(inbox_id, created_at desc, id desc);

-- Append-only evidence: the worker re-fetched this event and object from the
-- issuer with its own read credential before any ledger command ran.
create table money.card_provider_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_event_id text not null check (char_length(provider_event_id) between 3 and 255),
  event_type text not null check (char_length(event_type) between 3 and 255),
  provider_object_id text not null check (char_length(provider_object_id) between 3 and 255),
  payload_hash bytea not null check (octet_length(payload_hash) = 32),
  canonical_payload jsonb not null check (jsonb_typeof(canonical_payload) = 'object'),
  outcome text not null check (outcome in ('applied', 'duplicate', 'ignored')),
  created_at timestamptz not null default clock_timestamp(),
  constraint card_provider_event_provider_event_uq unique (provider, provider_event_id)
);

create index card_provider_events_object_idx
  on money.card_provider_events(provider, provider_object_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Policy helpers. Both are deterministic SQL so TypeScript can never choose the
-- payee key an authorization is judged by.
-- ---------------------------------------------------------------------------

create function money_private.card_policy_payee(
  p_mcc text,
  p_network_id text,
  p_descriptor text
)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select 'card:' || p_mcc || ':' || coalesce(
    nullif(left(regexp_replace(lower(p_network_id), '[^a-z0-9_.-]+', '-', 'g'), 64), ''),
    nullif(left(trim(both '-' from regexp_replace(lower(p_descriptor), '[^a-z0-9]+', '-', 'g')), 64), ''),
    'unknown'
  )
$$;

revoke all on function money_private.card_policy_payee(text, text, text) from public;

create function money_private.card_payee_allowed(
  p_allowlist text[],
  p_payee text,
  p_hint text
)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $$
  select p_allowlist is null
    or p_payee = any(p_allowlist)
    or ('card:' || split_part(p_payee, ':', 2) || ':*') = any(p_allowlist)
    or ('card:*:' || split_part(p_payee, ':', 3)) = any(p_allowlist)
    or (p_hint is not null and ('card:hint:' || p_hint) = any(p_allowlist))
$$;

revoke all on function money_private.card_payee_allowed(text[], text, text) from public;

-- ---------------------------------------------------------------------------
-- Rail kernel. Follows money_private.post_treasury_transfer and its compliance
-- wrapper, writes transfers.external_payee and the externalPayee receipt envelope
-- exactly as the x402 kernel does so ledger_health recomputes it. Never granted.
-- ---------------------------------------------------------------------------

create function money_private.post_card_transfer(
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
  v_card money.cards%rowtype;
  v_from_balance bigint;
  v_to_balance bigint;
  v_transfer_seq bigint;
  v_transfer_id uuid;
  v_receipt_id uuid;
  v_result jsonb;
  v_risk record;
  v_external_payee text := nullif(p_metadata->>'externalPayee', '');
  v_card_id text := nullif(p_metadata->>'cardId', '');
begin
  if p_actor_id is null or p_operation not in ('card_reserve', 'card_release', 'card_refund') then
    raise exception 'unsupported card transfer operation' using errcode = '22023';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key must contain 1-128 characters' using errcode = '22023';
  end if;
  if p_from_account_id is null or p_to_account_id is null or p_from_account_id = p_to_account_id then
    raise exception 'transfer endpoints must be distinct' using errcode = '22023';
  end if;
  if p_asset_code is distinct from 'USD' then
    raise exception 'card transfers settle in USD only' using errcode = '22023';
  end if;
  if p_amount_micros is null or p_amount_micros <= 0 then
    raise exception 'amount must be positive integer micros' using errcode = '22023';
  end if;
  if p_memo is null or char_length(p_memo) > 500 or p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'invalid card memo or metadata' using errcode = '22023';
  end if;
  if v_external_payee is null or v_external_payee !~ '^card:hint:[a-z0-9][a-z0-9.-]{0,99}$' or
     v_card_id is null or v_card_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'card transfers require the canonical card policy payee and card id' using errcode = '22023';
  end if;
  if p_operation = 'card_reserve' and (
    nullif(p_metadata->>'mandateId', '') is null or nullif(p_metadata->>'clientIdempotencyKey', '') is null
  ) then
    raise exception 'card reserve requires mandate and client idempotency evidence' using errcode = '22023';
  end if;
  if p_operation = 'card_release' and nullif(p_metadata->>'originalTransferSeq', '') is null then
    raise exception 'card release requires the original reserve transfer' using errcode = '22023';
  end if;
  if p_operation = 'card_refund' and nullif(p_metadata->>'authorizationId', '') is null then
    raise exception 'card refund requires the cleared authorization' using errcode = '22023';
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
        'idempotency_conflict', 'idempotency key was reused with different card terms',
        null::bigint, null::bigint;
      return;
    end if;
    if v_prior.state <> 'completed' then
      raise exception 'card idempotency reservation is unexpectedly incomplete' using errcode = '40001';
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
    raise exception 'unknown card transfer account' using errcode = '23503';
  end if;

  if p_operation = 'card_reserve' and not (
    p_actor_id = p_from_account_id and v_from.kind = 'agent' and v_from.status = 'active' and
    p_to_account_id = 'external:card' and v_to.kind = 'external' and v_to.status = 'active'
  ) then
    raise exception 'card reserve requires the actor agent to fund the card boundary' using errcode = '42501';
  elsif p_operation in ('card_release', 'card_refund') and not (
    p_actor_id = 'external:card' and p_from_account_id = 'external:card' and v_from.kind = 'external' and
    v_to.kind = 'agent' and v_to.status in ('active', 'frozen', 'closed')
  ) then
    raise exception 'card release and refund must return the card boundary to an agent' using errcode = '42501';
  end if;
  select c.* into v_card from money.cards c where c.id = v_card_id::uuid;
  if v_card.id is null or v_card.policy_payee <> v_external_payee or
     v_card.agent_id <> (case when p_operation = 'card_reserve' then p_from_account_id else p_to_account_id end) then
    raise exception 'card transfer evidence does not match the card' using errcode = '22023';
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

  if p_operation = 'card_reserve' and v_from_balance < p_amount_micros then
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

  -- Every reserve is a regulated outflow: it needs an atomic risk decision and a
  -- cleared card:hint counterparty. Release and refund return already-reserved
  -- value and carry no new exposure.
  if p_operation = 'card_reserve' then
    select * into v_risk from money_private.evaluate_transfer_risk(
      p_actor_id, p_operation, p_idempotency_key, v_hash,
      p_from_account_id, p_to_account_id, p_asset_code, p_amount_micros, p_metadata
    );
    if not v_risk.allowed then
      v_result := jsonb_build_object('denialCode', v_risk.denial_code, 'reason', v_risk.reason);
      update money.idempotency_keys set
        state = 'completed', result_kind = 'denied', result = v_result, completed_at = clock_timestamp()
      where id = v_key_id;
      return query select 'denied', false, null::bigint, null::uuid, null::uuid,
        v_risk.denial_code::text, v_risk.reason::text, null::bigint, null::bigint;
      return;
    end if;
    perform set_config('money.risk_decision_id', v_risk.decision_id::text, true);
  end if;

  insert into money.transfers(
    actor_id, operation, idempotency_key, request_hash,
    from_account_id, to_account_id, asset_code, amount_micros,
    memo, external_payee, metadata
  ) values (
    p_actor_id, p_operation, p_idempotency_key, v_hash,
    p_from_account_id, p_to_account_id, p_asset_code, p_amount_micros,
    p_memo, v_external_payee, p_metadata
  ) returning seq, id into v_transfer_seq, v_transfer_id;

  if p_operation = 'card_reserve' then
    perform set_config('money.risk_decision_id', '', true);
    insert into money.risk_transfer_links(decision_id, transfer_seq)
    values (v_risk.decision_id, v_transfer_seq) on conflict do nothing;
    if not exists (
      select 1 from money.risk_transfer_links l
      where l.decision_id = v_risk.decision_id and l.transfer_seq = v_transfer_seq
    ) then
      raise exception 'risk decision is linked to a different card transfer' using errcode = '55000';
    end if;
  end if;

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
  )::text, 'sha256'))
  returning id into v_receipt_id;

  insert into money.outbox_events(topic, aggregate_id, payload)
  values (
    case p_operation
      when 'card_reserve' then 'card.reserved'
      when 'card_release' then 'card.release_posted'
      else 'card.refund_posted'
    end,
    v_transfer_id::text,
    jsonb_build_object(
      'transferId', v_transfer_id, 'receiptId', v_receipt_id,
      'actorId', p_actor_id, 'operation', p_operation,
      'from', p_from_account_id, 'to', p_to_account_id,
      'asset', p_asset_code, 'amountMicros', p_amount_micros::text,
      'externalPayee', v_external_payee, 'cardId', v_card_id
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

  return query select 'posted', false, v_transfer_seq, v_transfer_id, v_receipt_id,
    null::text, null::text, v_from_balance, v_to_balance;
end;
$$;

revoke all on function money_private.post_card_transfer(text,text,text,text,text,text,bigint,text,jsonb) from public;

-- ---------------------------------------------------------------------------
-- Compliance perimeter: card reserves are regulated external outflows. Both the
-- evaluator and the journal trigger are re-created with identical bodies plus
-- the card_reserve operation so a reserve can never bypass a risk decision.
-- ---------------------------------------------------------------------------

create or replace function money_private.assert_transfer_risk_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_subject_id text;
  v_destination_subject_id text;
  v_required boolean := false;
  v_setting text;
  v_decision money.risk_decisions%rowtype;
begin
  v_source_subject_id := money_private.compliance_subject_id(new.from_account_id);
  v_destination_subject_id := money_private.compliance_subject_id(new.to_account_id);
  v_required := new.operation in ('fund', 'external_debit', 'funding_settlement', 'payout_hold', 'card_reserve') or
    (new.operation = 'pay' and v_source_subject_id is distinct from v_destination_subject_id);
  if not v_required then return new; end if;
  v_setting := nullif(current_setting('money.risk_decision_id', true), '');
  if v_setting is null or v_setting !~ '^[0-9a-fA-F-]{36}$' then
    raise exception 'regulated transfer requires an atomic risk decision' using errcode = '42501';
  end if;
  select * into v_decision from money.risk_decisions where id = v_setting::uuid;
  if v_decision.id is null or v_decision.outcome <> 'allow' or
     v_decision.actor_id <> new.actor_id or v_decision.operation <> new.operation or
     v_decision.idempotency_key <> new.idempotency_key or
     v_decision.request_hash <> new.request_hash or
     v_decision.from_account_id <> new.from_account_id or
     v_decision.to_account_id <> new.to_account_id or
     v_decision.asset_code <> new.asset_code or v_decision.amount_micros <> new.amount_micros or
     exists (select 1 from money.risk_transfer_links l where l.decision_id = v_decision.id) then
    raise exception 'risk decision does not match regulated transfer' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function money_private.assert_transfer_risk_decision() from public;

create or replace function money_private.evaluate_transfer_risk(
  p_actor_id text,
  p_operation text,
  p_idempotency_key text,
  p_request_hash bytea,
  p_from_account_id text,
  p_to_account_id text,
  p_asset_code text,
  p_amount_micros bigint,
  p_metadata jsonb
)
returns table (
  allowed boolean, decision_id uuid, denial_code text, reason text, replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_subject_id text;
  v_destination_subject_id text;
  v_source money.compliance_subjects%rowtype;
  v_destination money.compliance_subjects%rowtype;
  v_counterparty money.compliance_counterparties%rowtype;
  v_limits money.risk_limits%rowtype;
  v_prior money.risk_decisions%rowtype;
  v_record record;
  v_category text;
  v_daily_limit bigint;
  v_daily_amount bigint := 0;
  v_rolling_amount bigint := 0;
  v_rule text;
  v_outcome text;
  v_reason text;
  v_code text;
  v_requires_source boolean := false;
  v_requires_destination boolean := false;
  v_requires_counterparty boolean := false;
  v_counterparty_hash bytea;
  v_destination_ref text;
begin
  select * into v_prior from money.risk_decisions
  where actor_id = p_actor_id and operation = p_operation and idempotency_key = p_idempotency_key;
  if v_prior.id is not null then
    if v_prior.request_hash <> p_request_hash or
       v_prior.from_account_id <> p_from_account_id or
       v_prior.to_account_id <> p_to_account_id or
       v_prior.asset_code <> p_asset_code or v_prior.amount_micros <> p_amount_micros then
      raise exception 'risk decision idempotency key was reused with different terms' using errcode = '22023';
    end if;
    return query select v_prior.outcome = 'allow', v_prior.id,
      case when v_prior.outcome = 'allow' then null::text
           when v_prior.rule_codes && array['per_transfer_limit','daily_limit','rolling_30d_limit']
             then 'risk_limit' else 'compliance_required' end,
      v_prior.reason, true;
    return;
  end if;

  v_source_subject_id := money_private.compliance_subject_id(p_from_account_id);
  v_destination_subject_id := money_private.compliance_subject_id(p_to_account_id);

  if p_operation = 'pay' and v_source_subject_id is distinct from v_destination_subject_id then
    v_requires_source := true;
    v_requires_destination := true;
    v_category := 'cross_user';
  elsif p_operation in ('fund', 'funding_settlement') then
    v_requires_destination := true;
  elsif p_operation = 'external_debit' then
    v_requires_source := true;
    v_requires_counterparty := true;
    v_category := 'external';
  elsif p_operation = 'card_reserve' then
    v_requires_source := true;
    v_requires_counterparty := true;
    v_category := 'external';
  elsif p_operation = 'payout_hold' then
    v_requires_source := true;
    v_requires_counterparty := true;
    v_category := 'payout';
  else
    return query select true, null::uuid, null::text, 'risk decision not required', false;
    return;
  end if;

  perform 1 from money.compliance_subjects
  where account_id in (v_source_subject_id, v_destination_subject_id)
  order by account_id for key share;
  if v_source_subject_id is not null then
    select * into v_source from money.compliance_subjects where account_id = v_source_subject_id;
  end if;
  if v_destination_subject_id is not null then
    select * into v_destination from money.compliance_subjects where account_id = v_destination_subject_id;
  end if;

  if v_requires_source and (
    v_source.account_id is null or v_source.state <> 'approved' or
    v_source.identity_expires_at <= clock_timestamp() or
    v_source.screening_state <> 'clear' or v_source.screening_expires_at <= clock_timestamp() or
    v_source.next_review_at <= clock_timestamp() or
    exists (select 1 from money.compliance_restrictions r
            where r.subject_account_id = v_source_subject_id and r.released_at is null)
  ) then
    v_rule := 'source_not_eligible';
    v_outcome := 'review';
    v_code := 'compliance_required';
    v_reason := 'account is not eligible for this transfer';
  elsif v_requires_destination and (
    v_destination.account_id is null or v_destination.state <> 'approved' or
    v_destination.identity_expires_at <= clock_timestamp() or
    v_destination.screening_state <> 'clear' or v_destination.screening_expires_at <= clock_timestamp() or
    v_destination.next_review_at <= clock_timestamp() or
    exists (select 1 from money.compliance_restrictions r
            where r.subject_account_id = v_destination_subject_id and r.released_at is null)
  ) then
    v_rule := 'destination_not_eligible';
    v_outcome := 'review';
    v_code := 'compliance_required';
    v_reason := 'account is not eligible for this transfer';
  end if;

  if v_rule is null and v_requires_counterparty then
    if p_operation in ('external_debit', 'card_reserve') then
      if nullif(p_metadata->>'externalPayee', '') is not null then
        v_counterparty_hash := public.digest(p_metadata->>'externalPayee', 'sha256');
        select * into v_counterparty from money.compliance_counterparties
        where canonical_ref_hash = v_counterparty_hash for key share;
      end if;
    else
      v_destination_ref := nullif(p_metadata->>'destinationId', '');
      if v_destination_ref ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
        select cp.* into v_counterparty
        from money.treasury_destinations d
        join money.compliance_counterparties cp on cp.id = d.compliance_counterparty_id
        where d.id = v_destination_ref::uuid for key share of cp;
      end if;
    end if;
    if v_counterparty.id is null or v_counterparty.state <> 'clear' or
       v_counterparty.expires_at <= clock_timestamp() then
      v_rule := 'counterparty_not_clear';
      v_outcome := 'review';
      v_code := 'compliance_required';
      v_reason := 'counterparty screening is required for this transfer';
    end if;
  end if;

  if v_rule is not null then
    select * into v_record from money_private.record_risk_decision(
      p_actor_id, p_operation, p_idempotency_key, p_request_hash,
      p_from_account_id, p_to_account_id, v_source_subject_id, v_destination_subject_id,
      v_counterparty.id, p_asset_code, p_amount_micros,
      coalesce(v_source.risk_tier, v_destination.risk_tier), v_outcome, array[v_rule], v_reason
    );
    return query select v_record.decision_outcome = 'allow', v_record.decision_id,
      case when v_record.decision_outcome = 'allow' then null::text else v_code end,
      v_record.decision_reason, v_record.replayed;
    return;
  end if;

  if v_category is not null then
    select * into v_limits from money.risk_limits where risk_tier = v_source.risk_tier;
    if v_limits.risk_tier is null then
      v_rule := 'risk_tier_unconfigured';
      v_outcome := 'review';
      v_code := 'compliance_required';
      v_reason := 'account risk limits are not configured';
    elsif p_amount_micros > v_limits.per_transfer_micros then
      v_rule := 'per_transfer_limit';
      v_outcome := 'deny';
      v_code := 'risk_limit';
      v_reason := 'transfer exceeds the account risk limit';
    else
      v_daily_limit := case v_category
        when 'cross_user' then v_limits.daily_cross_user_micros
        when 'external' then v_limits.daily_external_micros
        else v_limits.daily_payout_micros end;
      insert into money.risk_velocity_buckets(subject_account_id, bucket_day, category)
      select v_source_subject_id, current_date, pending.category
      from unnest(array[v_category, 'all_outflow']) as pending(category)
      order by pending.category
      on conflict (subject_account_id, bucket_day, category) do nothing;
      perform 1 from money.risk_velocity_buckets
      where subject_account_id = v_source_subject_id and bucket_day = current_date
        and category in (v_category, 'all_outflow')
      order by category for update;
      select amount_micros into v_daily_amount from money.risk_velocity_buckets
      where subject_account_id = v_source_subject_id and bucket_day = current_date
        and category = v_category;
      select coalesce(sum(amount_micros), 0)::bigint into v_rolling_amount
      from money.risk_velocity_buckets
      where subject_account_id = v_source_subject_id and category = 'all_outflow'
        and bucket_day between current_date - 29 and current_date;
      if v_daily_amount + p_amount_micros > v_daily_limit then
        v_rule := 'daily_limit';
        v_outcome := 'deny';
        v_code := 'risk_limit';
        v_reason := 'transfer exceeds the account risk limit';
      elsif v_rolling_amount + p_amount_micros > v_limits.rolling_30d_outflow_micros then
        v_rule := 'rolling_30d_limit';
        v_outcome := 'deny';
        v_code := 'risk_limit';
        v_reason := 'transfer exceeds the account risk limit';
      end if;
    end if;
  end if;

  if v_rule is not null then
    select * into v_record from money_private.record_risk_decision(
      p_actor_id, p_operation, p_idempotency_key, p_request_hash,
      p_from_account_id, p_to_account_id, v_source_subject_id, v_destination_subject_id,
      v_counterparty.id, p_asset_code, p_amount_micros,
      coalesce(v_source.risk_tier, v_destination.risk_tier), v_outcome, array[v_rule], v_reason
    );
    return query select v_record.decision_outcome = 'allow', v_record.decision_id,
      case when v_record.decision_outcome = 'allow' then null::text else v_code end,
      v_record.decision_reason, v_record.replayed;
    return;
  end if;

  select * into v_record from money_private.record_risk_decision(
    p_actor_id, p_operation, p_idempotency_key, p_request_hash,
    p_from_account_id, p_to_account_id, v_source_subject_id, v_destination_subject_id,
    v_counterparty.id, p_asset_code, p_amount_micros,
    coalesce(v_source.risk_tier, v_destination.risk_tier), 'allow',
    case when v_category is null then array['compliance_clear']
         else array['compliance_clear', 'risk_limits_clear'] end,
    'compliance and risk checks passed'
  );
  if v_record.decision_outcome <> 'allow' then
    return query select false, v_record.decision_id, 'compliance_required',
      v_record.decision_reason, v_record.replayed;
    return;
  end if;
  if v_category is not null and not v_record.replayed then
    update money.risk_velocity_buckets set
      amount_micros = amount_micros + p_amount_micros,
      transfer_count = transfer_count + 1, updated_at = clock_timestamp()
    where subject_account_id = v_source_subject_id and bucket_day = current_date
      and category in (v_category, 'all_outflow');
  end if;
  return query select true, v_record.decision_id, null::text,
    v_record.decision_reason, v_record.replayed;
end;
$$;

revoke all on function money_private.evaluate_transfer_risk(
  text,text,text,bytea,text,text,text,bigint,jsonb
) from public;

-- ---------------------------------------------------------------------------
-- Treasury controls: the card-spend flag joins the breaker family. Tripping the
-- breaker clears it; restore leaves it false so an operator re-enables card spend
-- explicitly after review.
-- ---------------------------------------------------------------------------

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
    action, funding_enabled, payouts_enabled, external_spend_enabled, card_spend_enabled,
    max_payout_micros, max_pending_payout_micros, max_open_exposure_micros,
    max_reconciliation_variance_micros, reason, database_actor
  )
  select 'configured', p_funding_enabled, p_payouts_enabled, p_external_spend_enabled, c.card_spend_enabled,
    p_max_payout_micros, p_max_pending_payout_micros, p_max_open_exposure_micros,
    p_max_reconciliation_variance_micros, p_reason, session_user
  from money.treasury_controls c where c.singleton;
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
    v_control.external_spend_enabled or v_control.card_spend_enabled or
    v_control.breaker_reason is distinct from p_reason;
  update money.treasury_controls set
    funding_enabled = false, payouts_enabled = false, external_spend_enabled = false,
    card_spend_enabled = false,
    breaker_reason = p_reason, updated_at = clock_timestamp()
  where singleton;
  if v_changed then
    insert into money.treasury_control_events(
      action, funding_enabled, payouts_enabled, external_spend_enabled, card_spend_enabled,
      max_payout_micros, max_pending_payout_micros, max_open_exposure_micros,
      max_reconciliation_variance_micros, reason, database_actor
    )
    select 'tripped', funding_enabled, payouts_enabled, external_spend_enabled, card_spend_enabled,
      max_payout_micros, max_pending_payout_micros, max_open_exposure_micros,
      max_reconciliation_variance_micros, p_reason, session_user
    from money.treasury_controls where singleton;
  end if;
  return v_changed;
end;
$$;

create function money_private.set_card_spend_enabled(p_enabled boolean, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control money.treasury_controls%rowtype;
begin
  if p_enabled is null or p_reason is null or char_length(p_reason) not between 1 and 500 then
    raise exception 'invalid card spend control' using errcode = '22023';
  end if;
  select * into v_control from money.treasury_controls where singleton for update;
  -- A dead-lettered issuer event is unapplied evidence about card spend.
  -- Card spend cannot resume until an operator resolves it through
  -- resolve_card_provider_event, which leaves an audit row.
  if p_enabled and exists (select 1 from money.card_event_inbox where state = 'dead') then
    raise exception 'dead-lettered card events must be resolved before re-enabling card spend' using errcode = '55000';
  end if;
  -- Tripping the breaker clears card spend; a single treasury call must not
  -- undo that without the restore_treasury_controls review gates.
  if p_enabled and v_control.breaker_reason is not null then
    raise exception 'treasury breaker must be restored before re-enabling card spend' using errcode = '55000';
  end if;
  update money.treasury_controls set
    card_spend_enabled = p_enabled, updated_at = clock_timestamp()
  where singleton;
  insert into money.treasury_control_events(
    action, funding_enabled, payouts_enabled, external_spend_enabled, card_spend_enabled,
    max_payout_micros, max_pending_payout_micros, max_open_exposure_micros,
    max_reconciliation_variance_micros, reason, database_actor
  )
  select 'card_spend_configured', funding_enabled, payouts_enabled, external_spend_enabled, card_spend_enabled,
    max_payout_micros, max_pending_payout_micros, max_open_exposure_micros,
    max_reconciliation_variance_micros, p_reason, session_user
  from money.treasury_controls where singleton;
  return v_control.card_spend_enabled is distinct from p_enabled;
end;
$$;

revoke all on function money_private.set_card_spend_enabled(boolean, text) from public;

-- treasury_control_state() keeps its 0007 shape and its existing grants:
-- create or replace cannot widen a returns-table, and dropping it would leave
-- money_app without the external-spend gate until db/roles.sql is reapplied.
-- The card flag is read through its own function instead; callers without
-- the new grant fail closed to "card spend disabled".
create function money_private.card_spend_control_state()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce((select c.card_spend_enabled from money.treasury_controls c where c.singleton), false)
$$;

revoke all on function money_private.card_spend_control_state() from public;

-- ---------------------------------------------------------------------------
-- Card request lifecycle: prepare -> (approval) -> activate (reserve) -> pending.
-- ---------------------------------------------------------------------------

create function money_private.render_card_command(
  p_command_id bigint,
  p_replayed boolean
)
returns table (
  status text, replayed boolean, card_id uuid, card_state text,
  transfer_id uuid, receipt_id uuid, approval_id uuid, denial_code text, reason text,
  from_balance_micros bigint, to_balance_micros bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command money.idempotency_keys%rowtype;
  v_card money.cards%rowtype;
  v_approval money.approvals%rowtype;
begin
  select k.* into v_command from money.idempotency_keys k where k.id = p_command_id;
  if v_command.id is null or v_command.state <> 'completed' then
    raise exception 'card command is missing or incomplete' using errcode = '40001';
  end if;
  if v_command.result_kind = 'denied' then
    return query select
      'denied', p_replayed, nullif(v_command.result_id, '')::uuid, null::text, null::uuid, null::uuid, null::uuid,
      v_command.result->>'denialCode', v_command.result->>'reason',
      nullif(v_command.result->>'fromBalanceMicros', '')::bigint,
      nullif(v_command.result->>'toBalanceMicros', '')::bigint;
    return;
  end if;
  if v_command.result_kind <> 'card' then
    raise exception 'card command has unknown result kind %', v_command.result_kind using errcode = 'XX000';
  end if;
  select c.* into v_card from money.cards c where c.id::text = v_command.result_id;
  if v_card.id is null then raise exception 'card command references a missing card' using errcode = 'XX000'; end if;

  if v_card.state = 'prepared' then
    return query select
      'prepared', p_replayed, v_card.id, v_card.state,
      null::uuid, null::uuid, null::uuid, null::text, null::text,
      null::bigint, null::bigint;
    return;
  end if;

  if v_card.state in ('approval_required', 'cancelled') and v_card.approval_id is not null then
    update money.approvals a set
      status = 'expired', resolved_at = clock_timestamp(), reason = 'card approval expired'
    where a.id = v_card.approval_id and a.status = 'pending' and a.expires_at <= clock_timestamp();
    select a.* into v_approval from money.approvals a where a.id = v_card.approval_id;
    if v_approval.id is null then raise exception 'card approval is missing' using errcode = 'XX000'; end if;
    if v_card.state = 'approval_required' and v_approval.status = 'pending' then
      return query select
        'approval_required', p_replayed, v_card.id, v_card.state,
        null::uuid, null::uuid, v_approval.id, null::text, null::text,
        null::bigint, null::bigint;
      return;
    end if;
    if v_card.state = 'approval_required' then
      update money.cards c set state = 'cancelled', updated_at = clock_timestamp()
      where c.id = v_card.id;
      v_card.state := 'cancelled';
    end if;
    return query select
      'denied', p_replayed, v_card.id, v_card.state,
      null::uuid, null::uuid, v_approval.id,
      case v_approval.status when 'expired' then 'approval_expired'
        when 'failed' then 'approval_failed' else 'approval_rejected' end,
      coalesce(v_approval.reason, 'approval ' || v_approval.status),
      null::bigint, null::bigint;
    return;
  end if;

  if v_card.state = 'cancelled' then
    return query select
      'denied', p_replayed, v_card.id, v_card.state,
      null::uuid, null::uuid, null::uuid,
      'permit_invalid', coalesce(v_card.close_reason, 'card request is no longer activatable'),
      null::bigint, null::bigint;
    return;
  end if;

  return query
    select 'posted', p_replayed, v_card.id, v_card.state,
      t.id, r.id, v_card.approval_id, null::text, null::text,
      fb.available_micros, tb.available_micros
    from money.transfers t
    join money.receipts r on r.transfer_seq = t.seq
    join money.balances fb on fb.account_id = t.from_account_id and fb.asset_code = t.asset_code
    join money.balances tb on tb.account_id = t.to_account_id and tb.asset_code = t.asset_code
    where t.seq = v_card.transfer_seq and r.id = v_card.receipt_id;
end;
$$;

revoke all on function money_private.render_card_command(bigint, boolean) from public;

create function money_private.assert_card_provider_material(
  p_provider text,
  p_provider_card_ref text,
  p_last4 text,
  p_exp_month smallint,
  p_exp_year smallint,
  p_auth_ttl_seconds integer
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_-]{1,31}$' or
     p_provider_card_ref is null or char_length(p_provider_card_ref) not between 3 and 255 or
     p_last4 is null or p_last4 !~ '^[0-9]{4}$' or
     p_exp_month is null or p_exp_month not between 1 and 12 or
     p_exp_year is null or p_exp_year not between 2026 and 2100 then
    raise exception 'invalid issuer card material' using errcode = '22023';
  end if;
  if p_auth_ttl_seconds is null or p_auth_ttl_seconds not between 1 and 2592000 then
    raise exception 'card authorization ttl must be between 1 second and 30 days' using errcode = '22023';
  end if;
end;
$$;

revoke all on function money_private.assert_card_provider_material(text, text, text, smallint, smallint, integer) from public;

create function money_private.prepare_card(
  p_card_id uuid,
  p_agent_id text,
  p_idempotency_key text,
  p_cap_micros bigint,
  p_single_use boolean,
  p_merchant_hint text,
  p_mcc_allowlist text[],
  p_expires_at timestamptz
)
returns table (
  status text, replayed boolean, card_id uuid, card_state text,
  transfer_id uuid, receipt_id uuid, approval_id uuid, denial_code text, reason text,
  from_balance_micros bigint, to_balance_micros bigint
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
  v_policy_payee text;
  v_allowlist text[];
  v_approval_key text;
begin
  if p_card_id is null then raise exception 'card id is required' using errcode = '22023'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key must contain 1-128 characters' using errcode = '22023';
  end if;
  if p_cap_micros is null or p_cap_micros <= 0 or p_cap_micros > 10000000000 then
    raise exception 'card cap must be between one micro and the hard cap' using errcode = '22023';
  end if;
  if p_single_use is null then raise exception 'single-use flag is required' using errcode = '22023'; end if;
  if p_merchant_hint is null or p_merchant_hint !~ '^[a-z0-9][a-z0-9.-]{0,99}$' then
    raise exception 'invalid merchant hint' using errcode = '22023';
  end if;
  if p_mcc_allowlist is not null then
    if array_length(p_mcc_allowlist, 1) is null or array_length(p_mcc_allowlist, 1) > 32 or exists (
      select 1 from unnest(p_mcc_allowlist) x where x is null or x !~ '^[0-9]{4}$'
    ) then
      raise exception 'invalid merchant category allowlist' using errcode = '22023';
    end if;
    select array_agg(distinct x order by x) into v_allowlist from unnest(p_mcc_allowlist) x;
  end if;
  if p_expires_at is null or p_expires_at <= clock_timestamp() or
     p_expires_at > clock_timestamp() + interval '30 days' then
    raise exception 'card expiry must be within the next 30 days' using errcode = '22023';
  end if;
  v_policy_payee := 'card:hint:' || p_merchant_hint;

  -- The expiry is deliberately outside the hash: an exact retry computed a few
  -- seconds later must replay the original card rather than conflict.
  v_hash := public.digest(jsonb_build_object(
    'agentId', p_agent_id, 'capMicros', p_cap_micros, 'singleUse', p_single_use,
    'merchantHint', p_merchant_hint, 'mccAllowlist', v_allowlist
  )::text, 'sha256');
  insert into money.idempotency_keys(actor_id, operation, idempotency_key, request_hash)
  values (p_agent_id, 'request_card', p_idempotency_key, v_hash)
  on conflict (actor_id, operation, idempotency_key) do nothing
  returning id into v_key_id;
  if v_key_id is null then
    select k.* into v_prior from money.idempotency_keys k
    where k.actor_id = p_agent_id and k.operation = 'request_card'
      and k.idempotency_key = p_idempotency_key for update;
    if v_prior.request_hash <> v_hash then
      return query select 'denied', true, null::uuid, null::text, null::uuid, null::uuid, null::uuid,
        'idempotency_conflict', 'idempotency key was reused with different card terms',
        null::bigint, null::bigint;
      return;
    end if;
    return query select * from money_private.render_card_command(v_prior.id, true);
    return;
  end if;

  perform 1 from money.accounts a where a.id in (p_agent_id, 'external:card') order by a.id for update;
  select a.* into v_agent from money.accounts a where a.id = p_agent_id;
  select a.* into v_boundary from money.accounts a where a.id = 'external:card';
  if v_agent.id is null or v_agent.kind <> 'agent' or v_agent.status <> 'active' then
    raise exception 'requesting agent is unknown or inactive' using errcode = '42501';
  end if;
  if v_boundary.id is null or v_boundary.kind <> 'external' or v_boundary.status <> 'active' then
    raise exception 'card boundary is unavailable' using errcode = '55000';
  end if;
  update money.approvals a set status = 'expired', resolved_at = clock_timestamp(), reason = 'approval request expired'
  where a.agent_id = p_agent_id and a.status = 'pending' and a.expires_at <= clock_timestamp();
  select m.* into v_mandate from money.mandates m
  where m.agent_id = p_agent_id and m.asset_code = 'USD' and m.revoked_at is null
  order by m.created_at desc limit 1 for update;

  if v_mandate.id is null then
    v_result := jsonb_build_object('denialCode', 'no_mandate', 'reason', 'agent has no active USD mandate');
  elsif clock_timestamp() > v_mandate.expires_at then
    v_result := jsonb_build_object('denialCode', 'mandate_expired', 'reason', 'mandate has expired');
  elsif not money_private.card_payee_allowed(v_mandate.payee_allowlist, v_policy_payee, p_merchant_hint) then
    v_result := jsonb_build_object('denialCode', 'payee_not_allowed', 'reason', 'merchant is not on the mandate allowlist');
  elsif v_mandate.spent_micros + p_cap_micros > v_mandate.budget_micros then
    v_result := jsonb_build_object('denialCode', 'budget', 'reason', 'card cap would exceed the total mandate budget');
  else
    v_spent_today := case when v_today > v_mandate.spend_day then 0 else v_mandate.spent_today_micros end;
    if v_spent_today + p_cap_micros > v_mandate.daily_cap_micros then
      v_result := jsonb_build_object('denialCode', 'daily_cap', 'reason', 'card cap would exceed the mandate daily cap');
    end if;
  end if;
  if v_result is not null then
    update money.idempotency_keys set state = 'completed', result_kind = 'denied', result = v_result,
      completed_at = clock_timestamp() where id = v_key_id;
    return query select * from money_private.render_card_command(v_key_id, false);
    return;
  end if;

  v_memo := 'card:' || p_merchant_hint;
  if p_cap_micros > v_mandate.escalate_above_micros then
    select a.* into v_recent from money.cards c
    join money.approvals a on a.id = c.approval_id
    where c.agent_id = p_agent_id and c.policy_payee = v_policy_payee and c.cap_micros = p_cap_micros
      and a.status in ('rejected', 'failed', 'expired')
      and a.resolved_at > clock_timestamp() - interval '5 minutes'
    order by a.resolved_at desc limit 1;
    if v_recent.id is not null then
      v_result := jsonb_build_object(
        'denialCode', case when v_recent.status = 'expired' then 'approval_expired' else 'approval_rejected' end,
        'reason', coalesce(v_recent.reason, 'matching card approval was recently resolved') || ' (5 minute cooldown)'
      );
      update money.idempotency_keys set state = 'completed', result_kind = 'denied', result = v_result,
        completed_at = clock_timestamp() where id = v_key_id;
      return query select * from money_private.render_card_command(v_key_id, false);
      return;
    end if;
    select count(*) into v_pending_count from money.approvals a
    where a.agent_id = p_agent_id and a.status = 'pending';
    if v_pending_count >= 20 then
      v_result := jsonb_build_object('denialCode', 'approval_limit', 'reason', 'agent already has 20 pending approvals');
      update money.idempotency_keys set state = 'completed', result_kind = 'denied', result = v_result,
        completed_at = clock_timestamp() where id = v_key_id;
      return query select * from money_private.render_card_command(v_key_id, false);
      return;
    end if;
    v_approval_key := 'card_' || encode(public.digest((p_agent_id || ':' || p_idempotency_key)::text, 'sha256'), 'hex');
    insert into money.approvals(
      user_id, mandate_id, agent_id, to_account_id, asset_code,
      amount_micros, memo, idempotency_key, expires_at
    ) values (
      v_mandate.user_id, v_mandate.id, p_agent_id, 'external:card', 'USD',
      p_cap_micros, v_memo, v_approval_key,
      least(clock_timestamp() + interval '24 hours', v_mandate.expires_at, p_expires_at)
    ) returning * into v_approval;
    insert into money.cards(
      id, agent_id, mandate_id, idempotency_key, state, cap_micros, single_use,
      merchant_hint, policy_payee, mcc_allowlist, expires_at, approval_id
    ) values (
      p_card_id, p_agent_id, v_mandate.id, p_idempotency_key, 'approval_required', p_cap_micros, p_single_use,
      p_merchant_hint, v_policy_payee, v_allowlist, p_expires_at, v_approval.id
    );
    update money.idempotency_keys set state = 'completed', result_kind = 'card',
      result_id = p_card_id::text,
      result = jsonb_build_object('cardId', p_card_id, 'approvalId', v_approval.id),
      completed_at = clock_timestamp() where id = v_key_id;
    insert into money.outbox_events(topic, aggregate_id, payload)
    values ('card.approval_requested', p_card_id::text, jsonb_build_object(
      'cardId', p_card_id, 'approvalId', v_approval.id, 'agentId', p_agent_id,
      'userId', v_mandate.user_id, 'mandateId', v_mandate.id,
      'policyPayee', v_policy_payee, 'merchantHint', p_merchant_hint,
      'capMicros', p_cap_micros::text, 'singleUse', p_single_use, 'expiresAt', p_expires_at
    ));
    return query select * from money_private.render_card_command(v_key_id, false);
    return;
  end if;

  if p_cap_micros > v_mandate.per_tx_cap_micros then
    v_result := jsonb_build_object('denialCode', 'per_tx_cap', 'reason', 'card cap exceeds the mandate per-transaction cap');
  else
    select exists(select 1 from money.mandate_seen_payees s
      where s.mandate_id = v_mandate.id and s.payee_id = v_policy_payee) into v_seen;
    if not v_seen and p_cap_micros > v_mandate.new_payee_cap_micros then
      v_result := jsonb_build_object('denialCode', 'new_payee_cap', 'reason', 'first card for this merchant exceeds the new-payee cap');
    end if;
  end if;
  if v_result is not null then
    update money.idempotency_keys set state = 'completed', result_kind = 'denied', result = v_result,
      completed_at = clock_timestamp() where id = v_key_id;
    return query select * from money_private.render_card_command(v_key_id, false);
    return;
  end if;

  insert into money.cards(
    id, agent_id, mandate_id, idempotency_key, state, cap_micros, single_use,
    merchant_hint, policy_payee, mcc_allowlist, expires_at
  ) values (
    p_card_id, p_agent_id, v_mandate.id, p_idempotency_key, 'prepared', p_cap_micros, p_single_use,
    p_merchant_hint, v_policy_payee, v_allowlist, p_expires_at
  );
  update money.idempotency_keys set state = 'completed', result_kind = 'card',
    result_id = p_card_id::text, result = jsonb_build_object('cardId', p_card_id),
    completed_at = clock_timestamp() where id = v_key_id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('card.prepared', p_card_id::text, jsonb_build_object(
    'cardId', p_card_id, 'agentId', p_agent_id, 'mandateId', v_mandate.id,
    'policyPayee', v_policy_payee, 'merchantHint', p_merchant_hint,
    'capMicros', p_cap_micros::text, 'singleUse', p_single_use, 'expiresAt', p_expires_at
  ));
  return query select * from money_private.render_card_command(v_key_id, false);
end;
$$;

revoke all on function money_private.prepare_card(uuid, text, text, bigint, boolean, text, text[], timestamptz) from public;

-- Shared failure path: a card that can no longer be reserved keeps any issuer
-- material it already received so the issuer-close drain cancels the orphan card.
create function money_private.cancel_card_request(
  p_card_id uuid,
  p_reason text,
  p_provider text,
  p_provider_card_ref text,
  p_last4 text,
  p_exp_month smallint,
  p_exp_year smallint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update money.cards c set
    state = 'cancelled',
    provider = coalesce(c.provider, p_provider),
    provider_card_ref = coalesce(c.provider_card_ref, p_provider_card_ref),
    last4 = coalesce(c.last4, p_last4),
    exp_month = coalesce(c.exp_month, p_exp_month),
    exp_year = coalesce(c.exp_year, p_exp_year),
    close_requested_at = coalesce(c.close_requested_at, clock_timestamp()),
    close_reason = coalesce(c.close_reason, left(p_reason, 500)),
    updated_at = clock_timestamp()
  where c.id = p_card_id;
end;
$$;

revoke all on function money_private.cancel_card_request(uuid, text, text, text, text, smallint, smallint) from public;

create function money_private.activate_card(
  p_agent_id text,
  p_card_id uuid,
  p_provider text,
  p_provider_card_ref text,
  p_last4 text,
  p_exp_month smallint,
  p_exp_year smallint,
  p_auth_ttl_seconds integer default 604800
)
returns table (
  status text, replayed boolean, card_id uuid, card_state text,
  transfer_id uuid, receipt_id uuid, approval_id uuid, denial_code text, reason text,
  from_balance_micros bigint, to_balance_micros bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card money.cards%rowtype;
  v_mandate money.mandates%rowtype;
  v_command_id bigint;
  v_today date := (clock_timestamp() at time zone 'utc')::date;
  v_spent_today bigint;
  v_seen boolean;
  v_reason text;
  v_post record;
begin
  perform money_private.assert_card_provider_material(
    p_provider, p_provider_card_ref, p_last4, p_exp_month, p_exp_year, p_auth_ttl_seconds
  );
  select k.id into v_command_id from money.idempotency_keys k
  join money.cards c on c.id::text = k.result_id
  where c.id = p_card_id and k.actor_id = p_agent_id and k.operation = 'request_card' for update;
  if v_command_id is null then raise exception 'card activation command not found' using errcode = 'P0002'; end if;
  perform 1 from money.accounts a where a.id in (p_agent_id, 'external:card') order by a.id for update;
  select c.* into v_card from money.cards c where c.id = p_card_id for update;
  if v_card.agent_id <> p_agent_id then raise exception 'card belongs to another agent' using errcode = '42501'; end if;
  if v_card.state <> 'prepared' then
    if v_card.provider_card_ref is not null and
       (v_card.provider <> p_provider or v_card.provider_card_ref <> p_provider_card_ref) then
      raise exception 'card is already bound to a different issuer card' using errcode = '55000';
    end if;
    if v_card.provider_card_ref is null then
      -- The request was cancelled (owner close, mandate revoke) while the API
      -- was creating the issuer card. Persist the material on the cancelled row
      -- so list_cards_awaiting_issuer_close drains it instead of leaving a live
      -- issuer card nobody tracks. Any other material-less state is not
      -- activatable through this path and fails closed.
      if v_card.state <> 'cancelled' then
        raise exception 'card is not awaiting activation' using errcode = '55000';
      end if;
      perform money_private.cancel_card_request(
        v_card.id, coalesce(v_card.close_reason, 'issuer card bound after cancellation'),
        p_provider, p_provider_card_ref, p_last4, p_exp_month, p_exp_year
      );
    end if;
    return query select * from money_private.render_card_command(v_command_id, true);
    return;
  end if;
  select m.* into v_mandate from money.mandates m where m.id = v_card.mandate_id for update;
  if v_mandate.id is null or v_mandate.agent_id <> p_agent_id or v_mandate.revoked_at is not null then
    v_reason := 'mandate was revoked or replaced before card activation';
  elsif clock_timestamp() > v_mandate.expires_at then
    v_reason := 'mandate expired before card activation';
  elsif clock_timestamp() > v_card.expires_at then
    v_reason := 'card request expired before activation';
  elsif not money_private.card_payee_allowed(v_mandate.payee_allowlist, v_card.policy_payee, v_card.merchant_hint) then
    v_reason := 'merchant is no longer allowed by the mandate';
  elsif v_card.cap_micros > v_mandate.escalate_above_micros then
    v_reason := 'card now requires owner approval';
  elsif v_card.cap_micros > v_mandate.per_tx_cap_micros then
    v_reason := 'card cap exceeds the per-transaction cap';
  elsif v_mandate.spent_micros + v_card.cap_micros > v_mandate.budget_micros then
    v_reason := 'card cap exceeds the remaining mandate budget';
  else
    v_spent_today := case when v_today > v_mandate.spend_day then 0 else v_mandate.spent_today_micros end;
    if v_spent_today + v_card.cap_micros > v_mandate.daily_cap_micros then
      v_reason := 'card cap exceeds the remaining daily cap';
    else
      select exists(select 1 from money.mandate_seen_payees s
        where s.mandate_id = v_mandate.id and s.payee_id = v_card.policy_payee) into v_seen;
      if not v_seen and v_card.cap_micros > v_mandate.new_payee_cap_micros then
        v_reason := 'card cap exceeds the first-payment cap for this merchant';
      end if;
    end if;
  end if;
  if v_reason is not null then
    perform money_private.cancel_card_request(
      v_card.id, v_reason, p_provider, p_provider_card_ref, p_last4, p_exp_month, p_exp_year
    );
    update money.idempotency_keys set result_kind = 'denied',
      result = jsonb_build_object('denialCode', 'permit_invalid', 'reason', v_reason),
      completed_at = clock_timestamp() where id = v_command_id;
    return query select * from money_private.render_card_command(v_command_id, false);
    return;
  end if;
  if not exists (select 1 from money.treasury_controls where singleton and card_spend_enabled) then
    raise exception 'treasury card-spend circuit breaker is open' using errcode = '55000';
  end if;

  select * into v_post from money_private.post_card_transfer(
    v_card.agent_id, 'card_reserve', v_card.id::text,
    v_card.agent_id, 'external:card', 'USD', v_card.cap_micros,
    'card:' || v_card.merchant_hint,
    jsonb_build_object(
      'mandateId', v_mandate.id, 'cardId', v_card.id,
      'clientIdempotencyKey', v_card.idempotency_key, 'externalPayee', v_card.policy_payee
    )
  );
  if v_post.status = 'denied' then
    perform money_private.cancel_card_request(
      v_card.id, coalesce(v_post.reason, 'card reserve was denied'),
      p_provider, p_provider_card_ref, p_last4, p_exp_month, p_exp_year
    );
    update money.idempotency_keys set result_kind = 'denied',
      result = jsonb_build_object(
        'denialCode', v_post.denial_code, 'reason', v_post.reason,
        'fromBalanceMicros', v_post.from_balance_micros, 'toBalanceMicros', v_post.to_balance_micros
      ), completed_at = clock_timestamp() where id = v_command_id;
    return query select * from money_private.render_card_command(v_command_id, false);
    return;
  end if;
  perform money_private.commit_transfer_authorization(
    v_post.transfer_id, v_mandate.id, v_card.policy_payee, v_card.cap_micros, 'autonomous', null
  );
  update money.cards c set
    transfer_seq = v_post.transfer_seq, receipt_id = v_post.receipt_id,
    provider = p_provider, provider_card_ref = p_provider_card_ref,
    last4 = p_last4, exp_month = p_exp_month, exp_year = p_exp_year,
    reverse_after = c.expires_at + make_interval(secs => p_auth_ttl_seconds),
    state = 'pending', updated_at = clock_timestamp()
  where c.id = v_card.id;
  update money.idempotency_keys set result = jsonb_build_object(
    'cardId', v_card.id, 'transferId', v_post.transfer_id, 'receiptId', v_post.receipt_id
  ) where id = v_command_id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('card.pending', v_card.id::text, jsonb_build_object(
    'cardId', v_card.id, 'agentId', v_card.agent_id, 'mandateId', v_mandate.id,
    'transferId', v_post.transfer_id, 'receiptId', v_post.receipt_id,
    'policyPayee', v_card.policy_payee, 'capMicros', v_card.cap_micros::text,
    'provider', p_provider, 'last4', p_last4, 'expiresAt', v_card.expires_at
  ));
  return query select * from money_private.render_card_command(v_command_id, false);
end;
$$;

revoke all on function money_private.activate_card(text, uuid, text, text, text, smallint, smallint, integer) from public;

create function money_private.resolve_card_approval(
  p_user_id text,
  p_approval_id uuid,
  p_action text,
  p_reason text default null,
  p_provider text default null,
  p_provider_card_ref text default null,
  p_last4 text default null,
  p_exp_month smallint default null,
  p_exp_year smallint default null,
  p_auth_ttl_seconds integer default 604800
)
returns table (
  status text, replayed boolean, card_id uuid, card_state text,
  transfer_id uuid, receipt_id uuid, approval_id uuid, denial_code text, reason text,
  from_balance_micros bigint, to_balance_micros bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hint money.cards%rowtype;
  v_card money.cards%rowtype;
  v_approval money.approvals%rowtype;
  v_mandate money.mandates%rowtype;
  v_command_id bigint;
  v_today date := (clock_timestamp() at time zone 'utc')::date;
  v_spent_today bigint;
  v_failure text;
  v_post record;
begin
  if p_action not in ('approve', 'reject') then raise exception 'action must be approve or reject' using errcode = '22023'; end if;
  if p_reason is not null and char_length(p_reason) > 500 then raise exception 'reason is too long' using errcode = '22023'; end if;
  if p_action = 'reject' and (p_provider is not null or p_provider_card_ref is not null or
        p_last4 is not null or p_exp_month is not null or p_exp_year is not null) then
    raise exception 'rejection must not carry issuer card material' using errcode = '22023';
  end if;
  select c.* into v_hint from money.cards c where c.approval_id = p_approval_id;
  if v_hint.id is null then raise exception 'card approval not found' using errcode = 'P0002'; end if;
  select k.id into v_command_id from money.idempotency_keys k
  where k.actor_id = v_hint.agent_id and k.operation = 'request_card'
    and k.idempotency_key = v_hint.idempotency_key for update;
  if v_command_id is null then raise exception 'card approval command is missing' using errcode = 'XX000'; end if;
  perform 1 from money.accounts a where a.id in (v_hint.agent_id, 'external:card') order by a.id for update;
  select c.* into v_card from money.cards c where c.id = v_hint.id for update;
  select a.* into v_approval from money.approvals a where a.id = p_approval_id for update;
  if v_approval.id is null or v_approval.user_id <> p_user_id then
    raise exception 'card approval belongs to another owner' using errcode = '42501';
  end if;
  if v_approval.status = 'pending' and v_approval.expires_at <= clock_timestamp() then
    update money.approvals set status = 'expired', resolved_at = clock_timestamp(),
      reason = 'card approval expired' where id = p_approval_id;
    -- Issuer material supplied with an approve that arrives after expiry is
    -- persisted on the cancelled row so the issuer-close drain retires it.
    if p_provider_card_ref is not null then
      perform money_private.assert_card_provider_material(
        p_provider, p_provider_card_ref, p_last4, p_exp_month, p_exp_year, p_auth_ttl_seconds
      );
    end if;
    perform money_private.cancel_card_request(
      v_card.id, 'card approval expired', p_provider, p_provider_card_ref, p_last4, p_exp_month, p_exp_year
    );
    return query select * from money_private.render_card_command(v_command_id, true);
    return;
  end if;
  if v_approval.status <> 'pending' then
    if v_card.provider_card_ref is not null and p_provider_card_ref is not null and
       (v_card.provider <> p_provider or v_card.provider_card_ref <> p_provider_card_ref) then
      raise exception 'card is already bound to a different issuer card' using errcode = '55000';
    end if;
    if v_card.provider_card_ref is null and p_provider_card_ref is not null then
      -- The approval was resolved or failed (rejection, mandate revoke) while
      -- the API was creating the issuer card. Bind the material to the
      -- cancelled row so list_cards_awaiting_issuer_close drains it.
      if v_card.state <> 'cancelled' then
        raise exception 'card is not awaiting activation' using errcode = '55000';
      end if;
      perform money_private.assert_card_provider_material(
        p_provider, p_provider_card_ref, p_last4, p_exp_month, p_exp_year, p_auth_ttl_seconds
      );
      perform money_private.cancel_card_request(
        v_card.id, coalesce(v_card.close_reason, 'issuer card bound after cancellation'),
        p_provider, p_provider_card_ref, p_last4, p_exp_month, p_exp_year
      );
    end if;
    return query select * from money_private.render_card_command(v_command_id, true);
    return;
  end if;
  if p_action = 'reject' then
    update money.approvals set status = 'rejected', resolved_at = clock_timestamp(),
      reason = coalesce(nullif(p_reason, ''), 'rejected by owner') where id = p_approval_id;
    perform money_private.cancel_card_request(
      v_card.id, coalesce(nullif(p_reason, ''), 'rejected by owner'), null, null, null, null, null
    );
    return query select * from money_private.render_card_command(v_command_id, false);
    return;
  end if;

  -- Only a still-pending approval consumes issuer card material. Exact retries
  -- of an already resolved approval above never bind a second issuer card.
  perform money_private.assert_card_provider_material(
    p_provider, p_provider_card_ref, p_last4, p_exp_month, p_exp_year, p_auth_ttl_seconds
  );

  select m.* into v_mandate from money.mandates m where m.id = v_card.mandate_id for update;
  if v_card.state <> 'approval_required' then
    v_failure := 'card is no longer awaiting approval';
  elsif v_mandate.id is null or v_mandate.user_id <> p_user_id or v_mandate.agent_id <> v_approval.agent_id then
    v_failure := 'approval mandate is missing or mismatched';
  elsif v_mandate.revoked_at is not null then
    v_failure := 'mandate was revoked before approval';
  elsif clock_timestamp() > v_mandate.expires_at then
    v_failure := 'mandate expired before approval';
  elsif clock_timestamp() > v_card.expires_at then
    v_failure := 'card request expired before approval';
  elsif not money_private.card_payee_allowed(v_mandate.payee_allowlist, v_card.policy_payee, v_card.merchant_hint) then
    v_failure := 'merchant is no longer allowed by the mandate';
  elsif v_mandate.spent_micros + v_card.cap_micros > v_mandate.budget_micros then
    v_failure := 'approval would exceed the remaining mandate budget';
  else
    v_spent_today := case when v_today > v_mandate.spend_day then 0 else v_mandate.spent_today_micros end;
    if v_spent_today + v_card.cap_micros > v_mandate.daily_cap_micros then
      v_failure := 'approval would exceed the remaining daily cap';
    end if;
  end if;
  if v_failure is not null then
    update money.approvals set status = 'failed', resolved_at = clock_timestamp(), reason = left(v_failure, 500)
    where id = p_approval_id;
    perform money_private.cancel_card_request(
      v_card.id, v_failure, p_provider, p_provider_card_ref, p_last4, p_exp_month, p_exp_year
    );
    return query select * from money_private.render_card_command(v_command_id, false);
    return;
  end if;
  if not exists (select 1 from money.treasury_controls where singleton and card_spend_enabled) then
    raise exception 'treasury card-spend circuit breaker is open' using errcode = '55000';
  end if;

  select * into v_post from money_private.post_card_transfer(
    v_card.agent_id, 'card_reserve', v_card.id::text,
    v_card.agent_id, 'external:card', 'USD', v_card.cap_micros, v_approval.memo,
    jsonb_build_object(
      'mandateId', v_mandate.id, 'approvalId', v_approval.id, 'cardId', v_card.id,
      'clientIdempotencyKey', v_card.idempotency_key, 'externalPayee', v_card.policy_payee
    )
  );
  if v_post.status = 'denied' then
    update money.approvals set status = 'failed', resolved_at = clock_timestamp(),
      reason = left(coalesce(v_post.reason, 'card reserve failed'), 500) where id = p_approval_id;
    perform money_private.cancel_card_request(
      v_card.id, coalesce(v_post.reason, 'card reserve failed'),
      p_provider, p_provider_card_ref, p_last4, p_exp_month, p_exp_year
    );
    return query select * from money_private.render_card_command(v_command_id, false);
    return;
  end if;
  perform money_private.commit_transfer_authorization(
    v_post.transfer_id, v_mandate.id, v_card.policy_payee,
    v_card.cap_micros, 'human_approved', v_approval.id
  );
  update money.cards c set
    transfer_seq = v_post.transfer_seq, receipt_id = v_post.receipt_id,
    provider = p_provider, provider_card_ref = p_provider_card_ref,
    last4 = p_last4, exp_month = p_exp_month, exp_year = p_exp_year,
    reverse_after = c.expires_at + make_interval(secs => p_auth_ttl_seconds),
    state = 'pending', updated_at = clock_timestamp()
  where c.id = v_card.id;
  update money.approvals set status = 'approved', resolved_at = clock_timestamp(),
    receipt_id = v_post.receipt_id, reason = null where id = p_approval_id;
  update money.idempotency_keys set result = jsonb_build_object(
    'cardId', v_card.id, 'transferId', v_post.transfer_id,
    'receiptId', v_post.receipt_id, 'approvalId', v_approval.id
  ) where id = v_command_id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('card.pending', v_card.id::text, jsonb_build_object(
    'cardId', v_card.id, 'agentId', v_card.agent_id, 'mandateId', v_mandate.id,
    'transferId', v_post.transfer_id, 'receiptId', v_post.receipt_id, 'approvalId', v_approval.id,
    'policyPayee', v_card.policy_payee, 'capMicros', v_card.cap_micros::text,
    'provider', p_provider, 'last4', p_last4, 'expiresAt', v_card.expires_at
  ));
  return query select * from money_private.render_card_command(v_command_id, false);
end;
$$;

revoke all on function money_private.resolve_card_approval(
  text, uuid, text, text, text, text, text, smallint, smallint, integer
) from public;

-- ---------------------------------------------------------------------------
-- Synchronous authorization decision. Locks exactly one cards row, uses integer
-- arithmetic only, and never touches accounts, balances, or transfers; it can
-- only consume authority the reserve already set aside.
-- ---------------------------------------------------------------------------

create function money_private.decide_card_authorization(
  p_provider text,
  p_provider_event_id text,
  p_provider_authorization_ref text,
  p_provider_card_ref text,
  p_amount_micros bigint,
  p_merchant_descriptor text,
  p_merchant_mcc text,
  p_merchant_network_id text,
  p_merchant_country text,
  p_auth_ttl_seconds integer default 604800
)
returns table (decision text, decline_code text, authorization_id uuid, card_id uuid, replayed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card money.cards%rowtype;
  v_mandate money.mandates%rowtype;
  v_prior money.card_authorizations%rowtype;
  v_payee text;
  v_verification boolean;
  v_code text;
  v_seen boolean;
  v_id uuid;
begin
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_-]{1,31}$' or
     p_provider_event_id is null or char_length(p_provider_event_id) not between 3 and 255 or
     p_provider_authorization_ref is null or char_length(p_provider_authorization_ref) not between 3 and 255 or
     p_provider_card_ref is null or char_length(p_provider_card_ref) not between 3 and 255 or
     p_amount_micros is null or p_amount_micros < 0 or
     p_merchant_descriptor is null or char_length(p_merchant_descriptor) not between 1 and 100 or
     p_merchant_mcc is null or p_merchant_mcc !~ '^[0-9]{4}$' or
     (p_merchant_network_id is not null and char_length(p_merchant_network_id) not between 1 and 64) or
     (p_merchant_country is not null and p_merchant_country !~ '^[A-Z]{2,3}$') or
     p_auth_ttl_seconds is null or p_auth_ttl_seconds not between 1 and 2592000 then
    raise exception 'invalid card authorization request' using errcode = '22023';
  end if;
  v_payee := money_private.card_policy_payee(p_merchant_mcc, p_merchant_network_id, p_merchant_descriptor);
  v_verification := p_amount_micros <= 1000000;

  select a.* into v_prior from money.card_authorizations a
  where a.provider = p_provider and a.provider_event_id = p_provider_event_id;
  if v_prior.id is not null then
    return query select case when v_prior.state = 'declined' then 'declined' else 'approved' end,
      v_prior.decline_code, v_prior.id, v_prior.card_id, true;
    return;
  end if;

  select c.* into v_card from money.cards c
  where c.provider = p_provider and c.provider_card_ref = p_provider_card_ref
  for update;
  if v_card.id is null then
    return query select 'declined', 'card_not_active', null::uuid, null::uuid, false;
    return;
  end if;
  select a.* into v_prior from money.card_authorizations a
  where a.provider = p_provider and a.provider_event_id = p_provider_event_id;
  if v_prior.id is not null then
    return query select case when v_prior.state = 'declined' then 'declined' else 'approved' end,
      v_prior.decline_code, v_prior.id, v_prior.card_id, true;
    return;
  end if;
  select m.* into v_mandate from money.mandates m where m.id = v_card.mandate_id for key share;

  if v_card.state <> 'pending' or v_card.close_requested_at is not null then
    v_code := 'card_not_active';
  elsif clock_timestamp() > v_card.expires_at then
    v_code := 'card_expired';
  elsif not exists (select 1 from money.treasury_controls where singleton and card_spend_enabled) then
    v_code := 'treasury_breaker';
  elsif v_mandate.id is null or v_mandate.revoked_at is not null or v_mandate.agent_id <> v_card.agent_id then
    v_code := 'mandate_revoked';
  elsif clock_timestamp() > v_mandate.expires_at then
    v_code := 'mandate_expired';
  elsif exists (
    select 1 from money.card_authorizations a
    where a.provider = p_provider and a.provider_authorization_ref = p_provider_authorization_ref
      and a.state <> 'declined'
  ) then
    v_code := 'duplicate_authorization';
  elsif v_card.mcc_allowlist is not null and not (p_merchant_mcc = any(v_card.mcc_allowlist)) then
    v_code := 'mcc_not_allowed';
  elsif not money_private.card_payee_allowed(v_mandate.payee_allowlist, v_payee, v_card.merchant_hint) then
    v_code := 'payee_not_allowed';
  elsif v_card.locked_payee is not null and v_card.locked_payee <> v_payee then
    v_code := 'merchant_lock';
  elsif v_card.single_use and not v_verification and exists (
    select 1 from money.card_authorizations a
    where a.card_id = v_card.id and a.state in ('pending', 'confirmed') and not a.is_verification
  ) then
    v_code := 'single_use';
  else
    select exists(select 1 from money.mandate_seen_payees s
      where s.mandate_id = v_mandate.id and s.payee_id = v_payee) into v_seen;
    if not v_verification and not v_seen and p_amount_micros > v_mandate.new_payee_cap_micros then
      v_code := 'new_payee_cap';
    elsif v_card.held_micros + v_card.settled_micros + p_amount_micros > v_card.cap_micros then
      v_code := 'card_cap';
    end if;
  end if;

  if v_code is not null then
    insert into money.card_authorizations(
      card_id, agent_id, provider, provider_event_id, provider_authorization_ref,
      policy_payee, merchant_descriptor, merchant_mcc, merchant_network_id, merchant_country,
      amount_micros, is_verification, state, decline_code
    ) values (
      v_card.id, v_card.agent_id, p_provider, p_provider_event_id, p_provider_authorization_ref,
      v_payee, p_merchant_descriptor, p_merchant_mcc, p_merchant_network_id, p_merchant_country,
      p_amount_micros, v_verification, 'declined', v_code
    ) returning id into v_id;
    insert into money.outbox_events(topic, aggregate_id, payload)
    values ('card.declined', v_card.id::text, jsonb_build_object(
      'cardId', v_card.id, 'agentId', v_card.agent_id, 'authorizationId', v_id,
      'declineCode', v_code, 'policyPayee', v_payee,
      'merchantDescriptor', p_merchant_descriptor, 'merchantMcc', p_merchant_mcc,
      'amountMicros', p_amount_micros::text, 'isVerification', v_verification
    ));
    return query select 'declined', v_code, v_id, v_card.id, false;
    return;
  end if;

  insert into money.card_authorizations(
    card_id, agent_id, provider, provider_event_id, provider_authorization_ref,
    policy_payee, merchant_descriptor, merchant_mcc, merchant_network_id, merchant_country,
    amount_micros, is_verification, state, reverse_after
  ) values (
    v_card.id, v_card.agent_id, p_provider, p_provider_event_id, p_provider_authorization_ref,
    v_payee, p_merchant_descriptor, p_merchant_mcc, p_merchant_network_id, p_merchant_country,
    p_amount_micros, v_verification, 'pending', clock_timestamp() + make_interval(secs => p_auth_ttl_seconds)
  ) returning id into v_id;
  -- A sub-$1 verification proves the card exists, not that the owner spends
  -- there: it neither locks the card to the merchant nor marks the merchant
  -- seen, so the new-payee throttle still binds on the first real purchase.
  update money.cards c set
    held_micros = c.held_micros + p_amount_micros,
    locked_payee = case when v_verification then c.locked_payee else coalesce(c.locked_payee, v_payee) end,
    updated_at = clock_timestamp()
  where c.id = v_card.id;
  if not v_verification then
    insert into money.mandate_seen_payees(mandate_id, payee_id)
    values (v_mandate.id, v_payee)
    on conflict (mandate_id, payee_id) do nothing;
  end if;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('card.authorized', v_card.id::text, jsonb_build_object(
    'cardId', v_card.id, 'agentId', v_card.agent_id, 'authorizationId', v_id,
    'policyPayee', v_payee, 'merchantDescriptor', p_merchant_descriptor, 'merchantMcc', p_merchant_mcc,
    'amountMicros', p_amount_micros::text, 'isVerification', v_verification,
    'heldMicros', (v_card.held_micros + p_amount_micros)::text
  ));
  return query select 'approved', null::text, v_id, v_card.id, false;
end;
$$;

revoke all on function money_private.decide_card_authorization(
  text, text, text, text, bigint, text, text, text, text, integer
) from public;

-- ---------------------------------------------------------------------------
-- Durable issuer-event ingestion: copies of the treasury inbox commands.
-- ---------------------------------------------------------------------------

create function money_private.enqueue_card_provider_event(
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
  v_row money.card_event_inbox%rowtype;
begin
  if p_provider !~ '^[a-z][a-z0-9_-]{1,31}$' or char_length(p_provider_event_id) not between 3 and 255 or
     char_length(p_endpoint_id) not between 1 and 255 or octet_length(p_delivery_hash) <> 32 then
    raise exception 'invalid card provider event envelope' using errcode = '22023';
  end if;
  insert into money.card_event_inbox(provider, provider_event_id, endpoint_id, delivery_hash)
  values (p_provider, p_provider_event_id, p_endpoint_id, p_delivery_hash)
  on conflict on constraint card_event_inbox_provider_event_uq do nothing
  returning * into v_row;
  if v_row.id is not null then
    return query select v_row.id, false, v_row.state;
    return;
  end if;
  select * into v_row from money.card_event_inbox
  where provider = p_provider and provider_event_id = p_provider_event_id;
  return query select v_row.id, true, v_row.state;
end;
$$;

create function money_private.claim_card_provider_events(
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
    raise exception 'invalid card event worker claim' using errcode = '22023';
  end if;
  -- Expired leases return to the queue. The update and claim stay in one short
  -- transaction and no issuer HTTP call occurs under these locks.
  update money.card_event_inbox set
    state = 'queued', locked_at = null, locked_by = null,
    available_at = clock_timestamp(), last_error = 'worker lease expired'
  where state = 'processing' and locked_at < clock_timestamp() - interval '2 minutes';

  return query
    with claims as (
      select i.id from money.card_event_inbox i
      where i.state = 'queued' and i.available_at <= clock_timestamp()
      order by i.available_at, i.id
      limit p_limit
      for update skip locked
    )
    update money.card_event_inbox i set
      state = 'processing', locked_at = clock_timestamp(), locked_by = p_worker_id,
      attempts = i.attempts + 1
    from claims where i.id = claims.id
    returning i.id, i.provider, i.provider_event_id, i.attempts;
end;
$$;

create function money_private.complete_card_provider_event(
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
    raise exception 'invalid card provider event outcome' using errcode = '22023';
  end if;
  update money.card_event_inbox set
    state = p_outcome, locked_at = null, locked_by = null,
    last_error = null, completed_at = clock_timestamp()
  where id = p_inbox_id and state = 'processing' and locked_by = p_worker_id;
  if not found then
    raise exception 'card event worker does not own this claim' using errcode = '42501';
  end if;
  return true;
end;
$$;

create function money_private.fail_card_provider_event(
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
    raise exception 'invalid card provider event failure' using errcode = '22023';
  end if;
  update money.card_event_inbox set
    state = case when p_dead then 'dead' else 'queued' end,
    locked_at = null, locked_by = null, last_error = p_error,
    available_at = clock_timestamp() + make_interval(secs => p_retry_after_seconds),
    completed_at = case when p_dead then clock_timestamp() else null end
  where id = p_inbox_id and state = 'processing' and locked_by = p_worker_id;
  if not found then
    raise exception 'card event worker does not own this claim' using errcode = '42501';
  end if;
  if p_dead then
    perform money_private.trip_treasury_breaker(
      'card event dead-lettered: inbox ' || p_inbox_id::text
    );
  end if;
  return true;
end;
$$;

-- Operator resolution of a dead-lettered card event. 'retry' requeues it for
-- the worker with a fresh attempt budget; 'ignore' retires it. Card spend must
-- still be off while the review happens (the dead letter tripped the breaker),
-- and the resolution is audited in money.card_event_reviews.
create function money_private.resolve_card_provider_event(
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
  v_event money.card_event_inbox%rowtype;
  v_state text;
begin
  if p_resolution not in ('retry', 'ignore') or
     char_length(p_review_reference) not between 3 and 100 or
     char_length(p_reason) not between 3 and 500 then
    raise exception 'invalid card event review resolution' using errcode = '22023';
  end if;
  select * into v_event from money.card_event_inbox where id = p_inbox_id for update;
  if v_event.id is null then raise exception 'card provider event not found' using errcode = 'P0002'; end if;
  if v_event.state <> 'dead' then
    raise exception 'card provider event is not awaiting review' using errcode = '55000';
  end if;
  if exists (select 1 from money.treasury_controls where singleton and card_spend_enabled) then
    raise exception 'card spend must remain disabled during card event review' using errcode = '55000';
  end if;
  insert into money.card_event_reviews(
    inbox_id, resolution, prior_error, review_reference, reason, database_actor
  ) values (
    v_event.id, p_resolution, v_event.last_error, p_review_reference, p_reason, session_user
  );
  if p_resolution = 'retry' then
    update money.card_event_inbox set
      state = 'queued', attempts = 0, available_at = clock_timestamp(),
      locked_at = null, locked_by = null,
      last_error = 'reviewed retry: ' || p_reason, completed_at = null
    where id = v_event.id
    returning state into v_state;
  else
    update money.card_event_inbox set
      state = 'ignored', locked_at = null, locked_by = null,
      last_error = 'reviewed ignore: ' || p_reason,
      completed_at = clock_timestamp()
    where id = v_event.id
    returning state into v_state;
  end if;
  return v_state;
end;
$$;

create function money_private.record_card_provider_event(
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
  v_prior money.card_provider_events%rowtype;
begin
  if p_provider !~ '^[a-z][a-z0-9_-]{1,31}$' or
     char_length(p_provider_event_id) not between 3 and 255 or
     char_length(p_event_type) not between 3 and 255 or
     char_length(p_provider_object_id) not between 3 and 255 or
     octet_length(p_payload_hash) <> 32 or jsonb_typeof(p_canonical_payload) <> 'object' then
    raise exception 'invalid normalized card provider event' using errcode = '22023';
  end if;
  insert into money.card_provider_events(
    provider, provider_event_id, event_type, provider_object_id,
    payload_hash, canonical_payload, outcome
  ) values (
    p_provider, p_provider_event_id, p_event_type, p_provider_object_id,
    p_payload_hash, p_canonical_payload, 'applied'
  ) on conflict on constraint card_provider_event_provider_event_uq do nothing
  returning id into v_id;
  if v_id is not null then return false; end if;
  select * into v_prior from money.card_provider_events
  where provider = p_provider and provider_event_id = p_provider_event_id;
  if v_prior.event_type <> p_event_type or v_prior.provider_object_id <> p_provider_object_id or
     v_prior.payload_hash <> p_payload_hash or v_prior.canonical_payload <> p_canonical_payload then
    raise exception 'provider event id was reused with different normalized evidence' using errcode = '22023';
  end if;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Closing and finalizing. finalize_card is internal (never granted): it releases
-- the unspent remainder to the agent's funds and settles the card's terminal state.
-- ---------------------------------------------------------------------------

create function money_private.finalize_card(p_card_id uuid)
returns table (finalized boolean, card_state text, release_transfer_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card money.cards%rowtype;
  v_remainder bigint;
  v_post record;
  v_release_id uuid;
  v_release_seq bigint;
  v_state text;
begin
  select c.* into v_card from money.cards c where c.id = p_card_id for update;
  if v_card.id is null then raise exception 'card not found' using errcode = 'P0002'; end if;
  if v_card.state in ('confirmed', 'reversed') then
    select t.id into v_release_id from money.transfers t where t.seq = v_card.release_transfer_seq;
    return query select true, v_card.state, v_release_id;
    return;
  end if;
  if v_card.state <> 'pending' or v_card.held_micros <> 0 or
     not (v_card.close_requested_at is not null or v_card.reverse_after < clock_timestamp()) then
    return query select false, v_card.state, null::uuid;
    return;
  end if;
  v_remainder := v_card.cap_micros - v_card.settled_micros;
  if v_remainder > 0 then
    select * into v_post from money_private.post_card_transfer(
      'external:card', 'card_release', 'crl_' || v_card.id::text,
      'external:card', v_card.agent_id, 'USD', v_remainder,
      left('release: card ' || v_card.id::text || ' unspent remainder', 500),
      jsonb_build_object(
        'cardId', v_card.id, 'originalTransferSeq', v_card.transfer_seq,
        'settledMicros', v_card.settled_micros, 'externalPayee', v_card.policy_payee
      )
    );
    if v_post.status <> 'posted' then
      raise exception 'card release posting failed: %', coalesce(v_post.reason, 'unknown') using errcode = 'XX000';
    end if;
    v_release_id := v_post.transfer_id;
    v_release_seq := v_post.transfer_seq;
  end if;
  v_state := case when v_card.settled_micros > 0 then 'confirmed' else 'reversed' end;
  update money.cards c set
    state = v_state,
    release_transfer_seq = v_release_seq,
    close_requested_at = coalesce(c.close_requested_at, clock_timestamp()),
    close_reason = coalesce(c.close_reason, 'card expired'),
    updated_at = clock_timestamp()
  where c.id = v_card.id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('card.' || v_state, v_card.id::text, jsonb_build_object(
    'cardId', v_card.id, 'agentId', v_card.agent_id,
    'capMicros', v_card.cap_micros::text, 'settledMicros', v_card.settled_micros::text,
    'releasedMicros', greatest(v_remainder, 0)::text, 'releaseTransferId', v_release_id,
    'originalTransferSeq', v_card.transfer_seq
  ));
  return query select true, v_state, v_release_id;
end;
$$;

revoke all on function money_private.finalize_card(uuid) from public;

create function money_private.close_card(
  p_requester_id text,
  p_card_id uuid,
  p_reason text default null
)
returns table (card_id uuid, card_state text, close_requested_at timestamptz, release_transfer_id uuid, replayed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card money.cards%rowtype;
  v_requester money.accounts%rowtype;
  v_agent money.accounts%rowtype;
  v_final record;
  v_reason text := coalesce(nullif(p_reason, ''), 'closed by ' || p_requester_id);
begin
  if p_reason is not null and char_length(p_reason) > 500 then
    raise exception 'close reason is too long' using errcode = '22023';
  end if;
  select c.* into v_card from money.cards c where c.id = p_card_id for update;
  if v_card.id is null then raise exception 'card not found' using errcode = 'P0002'; end if;
  select a.* into v_requester from money.accounts a where a.id = p_requester_id;
  select a.* into v_agent from money.accounts a where a.id = v_card.agent_id;
  if v_requester.id is null or v_requester.status <> 'active' or not (
    v_requester.id = v_card.agent_id or (v_requester.kind = 'user' and v_agent.owner_id = v_requester.id)
  ) then
    raise exception 'card belongs to another tenant' using errcode = '42501';
  end if;

  if v_card.state = 'prepared' then
    perform money_private.cancel_card_request(v_card.id, v_reason, null, null, null, null, null);
    insert into money.outbox_events(topic, aggregate_id, payload)
    values ('card.close_requested', v_card.id::text, jsonb_build_object(
      'cardId', v_card.id, 'agentId', v_card.agent_id, 'requesterId', p_requester_id, 'reason', v_reason
    ));
    return query select v_card.id, 'cancelled'::text, clock_timestamp(), null::uuid, false;
    return;
  end if;
  if v_card.state = 'approval_required' then
    update money.approvals a set status = 'failed', resolved_at = clock_timestamp(), reason = left(v_reason, 500)
    where a.id = v_card.approval_id and a.status = 'pending';
    perform money_private.cancel_card_request(v_card.id, v_reason, null, null, null, null, null);
    insert into money.outbox_events(topic, aggregate_id, payload)
    values ('card.close_requested', v_card.id::text, jsonb_build_object(
      'cardId', v_card.id, 'agentId', v_card.agent_id, 'requesterId', p_requester_id, 'reason', v_reason
    ));
    return query select v_card.id, 'cancelled'::text, clock_timestamp(), null::uuid, false;
    return;
  end if;
  if v_card.state <> 'pending' then
    select t.id into release_transfer_id from money.transfers t where t.seq = v_card.release_transfer_seq;
    return query select v_card.id, v_card.state, v_card.close_requested_at, release_transfer_id, true;
    return;
  end if;

  replayed := v_card.close_requested_at is not null;
  if not replayed then
    update money.cards c set
      close_requested_at = clock_timestamp(), close_reason = left(v_reason, 500), updated_at = clock_timestamp()
    where c.id = v_card.id;
    insert into money.outbox_events(topic, aggregate_id, payload)
    values ('card.close_requested', v_card.id::text, jsonb_build_object(
      'cardId', v_card.id, 'agentId', v_card.agent_id, 'requesterId', p_requester_id,
      'reason', v_reason, 'heldMicros', v_card.held_micros::text
    ));
  end if;
  select * into v_final from money_private.finalize_card(v_card.id);
  select c.* into v_card from money.cards c where c.id = p_card_id;
  return query select v_card.id, v_card.state, v_card.close_requested_at, v_final.release_transfer_id, replayed;
end;
$$;

revoke all on function money_private.close_card(text, uuid, text) from public;

-- ---------------------------------------------------------------------------
-- Worker commands: clearings, voids, refunds. Each records provider evidence
-- first, then locks the card before its authorization.
-- ---------------------------------------------------------------------------

create function money_private.settle_card_authorization(
  p_provider text,
  p_provider_event_id text,
  p_provider_authorization_ref text,
  p_settled_micros bigint,
  p_occurred_at timestamptz,
  p_payload_hash bytea,
  p_canonical_payload jsonb,
  p_overcapture_bps integer default 0
)
returns table (
  result_status text, replayed boolean, authorization_id uuid, card_id uuid, card_state text,
  held_micros bigint, settled_micros bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_replay boolean;
  v_auth money.card_authorizations%rowtype;
  v_card money.cards%rowtype;
  v_final record;
begin
  if p_settled_micros is null or p_settled_micros < 0 or
     p_occurred_at is null or p_occurred_at > clock_timestamp() + interval '5 minutes' or
     p_overcapture_bps is null or p_overcapture_bps not between 0 and 2500 then
    raise exception 'invalid card clearing evidence' using errcode = '22023';
  end if;
  v_event_replay := money_private.record_card_provider_event(
    p_provider, p_provider_event_id, 'card.clearing', p_provider_authorization_ref,
    p_payload_hash, p_canonical_payload
  );
  select a.* into v_auth from money.card_authorizations a
  where a.provider = p_provider and a.provider_authorization_ref = p_provider_authorization_ref
    and a.state <> 'declined';
  if v_auth.id is null then
    raise exception 'card authorization does not exist yet for this clearing' using errcode = 'P0002';
  end if;
  select c.* into v_card from money.cards c where c.id = v_auth.card_id for update;
  select a.* into v_auth from money.card_authorizations a where a.id = v_auth.id for update;

  if v_auth.state = 'confirmed' then
    -- Only a replay of the exact event that cleared this authorization is a
    -- duplicate. A second clearing under a new provider event id (multi-capture,
    -- amended amount) is unapplied issuer evidence and must surface to review
    -- rather than be silently dropped.
    if v_auth.settled_event_id <> p_provider_event_id then
      raise exception 'authorization was already cleared by a different provider event' using errcode = '22023';
    end if;
    if v_auth.settled_micros <> p_settled_micros then
      raise exception 'authorization was already cleared with a different amount' using errcode = '22023';
    end if;
    update money.card_provider_events set outcome = 'duplicate'
    where provider = p_provider and provider_event_id = p_provider_event_id and not v_event_replay;
    return query select 'confirmed', true, v_auth.id, v_card.id, v_card.state,
      v_card.held_micros, v_card.settled_micros;
    return;
  end if;
  if v_auth.state <> 'pending' then
    raise exception 'authorization was reversed before clearing' using errcode = '55000';
  end if;
  if p_settled_micros * 10000 > v_auth.amount_micros * (10000 + p_overcapture_bps) then
    raise exception 'clearing exceeds the authorized amount tolerance' using errcode = '22023';
  end if;
  if v_card.settled_micros + p_settled_micros > v_card.cap_micros - (v_card.held_micros - v_auth.amount_micros) then
    raise exception 'clearing exceeds the card reserve' using errcode = '22023';
  end if;

  update money.card_authorizations a set
    state = 'confirmed', settled_micros = p_settled_micros,
    settled_event_id = p_provider_event_id, updated_at = clock_timestamp()
  where a.id = v_auth.id;
  update money.cards c set
    held_micros = c.held_micros - v_auth.amount_micros,
    settled_micros = c.settled_micros + p_settled_micros,
    close_requested_at = case
      when c.single_use and not v_auth.is_verification then coalesce(c.close_requested_at, clock_timestamp())
      else c.close_requested_at end,
    close_reason = case
      when c.single_use and not v_auth.is_verification then coalesce(c.close_reason, 'single-use card cleared')
      else c.close_reason end,
    updated_at = clock_timestamp()
  where c.id = v_card.id
  returning * into v_card;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('card.authorization_confirmed', v_card.id::text, jsonb_build_object(
    'cardId', v_card.id, 'agentId', v_card.agent_id, 'authorizationId', v_auth.id,
    'policyPayee', v_auth.policy_payee, 'amountMicros', v_auth.amount_micros::text,
    'settledMicros', p_settled_micros::text, 'heldMicros', v_card.held_micros::text,
    'cardSettledMicros', v_card.settled_micros::text, 'occurredAt', p_occurred_at
  ));
  if v_card.held_micros = 0 and (v_card.close_requested_at is not null or v_card.reverse_after < clock_timestamp()) then
    select * into v_final from money_private.finalize_card(v_card.id);
    select c.* into v_card from money.cards c where c.id = v_card.id;
  end if;
  return query select 'confirmed', v_event_replay, v_auth.id, v_card.id, v_card.state,
    v_card.held_micros, v_card.settled_micros;
end;
$$;

create function money_private.void_card_authorization(
  p_provider text,
  p_provider_event_id text,
  p_provider_authorization_ref text,
  p_occurred_at timestamptz,
  p_payload_hash bytea,
  p_canonical_payload jsonb
)
returns table (
  result_status text, replayed boolean, authorization_id uuid, card_id uuid, card_state text,
  held_micros bigint, settled_micros bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_replay boolean;
  v_auth money.card_authorizations%rowtype;
  v_card money.cards%rowtype;
  v_final record;
begin
  if p_occurred_at is null or p_occurred_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid card void evidence' using errcode = '22023';
  end if;
  v_event_replay := money_private.record_card_provider_event(
    p_provider, p_provider_event_id, 'card.void', p_provider_authorization_ref,
    p_payload_hash, p_canonical_payload
  );
  select a.* into v_auth from money.card_authorizations a
  where a.provider = p_provider and a.provider_authorization_ref = p_provider_authorization_ref
    and a.state <> 'declined';
  if v_auth.id is null then
    raise exception 'card authorization does not exist yet for this void' using errcode = 'P0002';
  end if;
  select c.* into v_card from money.cards c where c.id = v_auth.card_id for update;
  select a.* into v_auth from money.card_authorizations a where a.id = v_auth.id for update;

  if v_auth.state = 'reversed' then
    update money.card_provider_events set outcome = 'duplicate'
    where provider = p_provider and provider_event_id = p_provider_event_id and not v_event_replay;
    return query select 'reversed', true, v_auth.id, v_card.id, v_card.state,
      v_card.held_micros, v_card.settled_micros;
    return;
  end if;
  if v_auth.state <> 'pending' then
    raise exception 'authorization was already cleared and cannot be voided' using errcode = '55000';
  end if;
  update money.card_authorizations a set
    state = 'reversed', voided_event_id = p_provider_event_id, updated_at = clock_timestamp()
  where a.id = v_auth.id;
  update money.cards c set
    held_micros = c.held_micros - v_auth.amount_micros, updated_at = clock_timestamp()
  where c.id = v_card.id
  returning * into v_card;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('card.authorization_reversed', v_card.id::text, jsonb_build_object(
    'cardId', v_card.id, 'agentId', v_card.agent_id, 'authorizationId', v_auth.id,
    'policyPayee', v_auth.policy_payee, 'amountMicros', v_auth.amount_micros::text,
    'heldMicros', v_card.held_micros::text, 'reason', 'voided', 'occurredAt', p_occurred_at
  ));
  if v_card.held_micros = 0 and (v_card.close_requested_at is not null or v_card.reverse_after < clock_timestamp()) then
    select * into v_final from money_private.finalize_card(v_card.id);
    select c.* into v_card from money.cards c where c.id = v_card.id;
  end if;
  return query select 'reversed', v_event_replay, v_auth.id, v_card.id, v_card.state,
    v_card.held_micros, v_card.settled_micros;
end;
$$;

create function money_private.refund_card_authorization(
  p_provider text,
  p_provider_event_id text,
  p_provider_refund_ref text,
  p_provider_authorization_ref text,
  p_amount_micros bigint,
  p_occurred_at timestamptz,
  p_payload_hash bytea,
  p_canonical_payload jsonb
)
returns table (
  result_status text, replayed boolean, refund_id uuid, authorization_id uuid, card_id uuid,
  transfer_id uuid, receipt_id uuid, agent_balance_micros bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event_replay boolean;
  v_auth money.card_authorizations%rowtype;
  v_card money.cards%rowtype;
  v_refund money.card_refunds%rowtype;
  v_refunded bigint;
  v_post record;
  v_transfer money.transfers%rowtype;
  v_receipt_id uuid;
  v_balance bigint;
  v_key text;
begin
  if p_amount_micros is null or p_amount_micros <= 0 or
     p_provider_refund_ref is null or char_length(p_provider_refund_ref) not between 3 and 255 or
     p_occurred_at is null or p_occurred_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid card refund evidence' using errcode = '22023';
  end if;
  v_event_replay := money_private.record_card_provider_event(
    p_provider, p_provider_event_id, 'card.refund', p_provider_refund_ref,
    p_payload_hash, p_canonical_payload
  );
  select a.* into v_auth from money.card_authorizations a
  where a.provider = p_provider and a.provider_authorization_ref = p_provider_authorization_ref
    and a.state <> 'declined';
  if v_auth.id is null then
    raise exception 'card authorization does not exist yet for this refund' using errcode = 'P0002';
  end if;
  select c.* into v_card from money.cards c where c.id = v_auth.card_id for update;
  select a.* into v_auth from money.card_authorizations a where a.id = v_auth.id for update;

  select f.* into v_refund from money.card_refunds f
  where f.provider = p_provider and f.provider_refund_ref = p_provider_refund_ref;
  if v_refund.id is not null then
    if v_refund.amount_micros <> p_amount_micros or v_refund.authorization_id <> v_auth.id then
      raise exception 'provider refund was reused with different refund terms' using errcode = '22023';
    end if;
    update money.card_provider_events set outcome = 'duplicate'
    where provider = p_provider and provider_event_id = p_provider_event_id and not v_event_replay;
    select t.* into v_transfer from money.transfers t where t.seq = v_refund.transfer_seq;
    select r.id into v_receipt_id from money.receipts r where r.transfer_seq = v_refund.transfer_seq;
    select b.available_micros into v_balance from money.balances b
    where b.account_id = v_card.agent_id and b.asset_code = 'USD';
    return query select 'refunded', true, v_refund.id, v_auth.id, v_card.id,
      v_transfer.id, v_receipt_id, v_balance;
    return;
  end if;
  if v_auth.state <> 'confirmed' then
    raise exception 'only a cleared authorization can be refunded' using errcode = '55000';
  end if;
  select coalesce(sum(f.amount_micros), 0)::bigint into v_refunded
  from money.card_refunds f where f.authorization_id = v_auth.id;
  if v_refunded + p_amount_micros > v_auth.settled_micros then
    raise exception 'refund exceeds the cleared amount of the authorization' using errcode = '22023';
  end if;

  v_key := 'crf_' || encode(public.digest(p_provider || ':' || p_provider_refund_ref, 'sha256'), 'hex');
  select * into v_post from money_private.post_card_transfer(
    'external:card', 'card_refund', v_key,
    'external:card', v_card.agent_id, 'USD', p_amount_micros,
    left('refund: card ' || v_card.id::text || ' authorization ' || v_auth.id::text, 500),
    jsonb_build_object(
      'cardId', v_card.id, 'authorizationId', v_auth.id,
      'providerRefundRef', p_provider_refund_ref, 'externalPayee', v_card.policy_payee
    )
  );
  if v_post.status <> 'posted' then
    raise exception 'card refund journal command was denied: %', coalesce(v_post.denial_code, 'unknown') using errcode = '55000';
  end if;
  insert into money.card_refunds(
    authorization_id, card_id, provider, provider_event_id, provider_refund_ref, amount_micros, transfer_seq
  ) values (
    v_auth.id, v_card.id, p_provider, p_provider_event_id, p_provider_refund_ref, p_amount_micros, v_post.transfer_seq
  ) returning * into v_refund;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('card.refunded', v_card.id::text, jsonb_build_object(
    'cardId', v_card.id, 'agentId', v_card.agent_id, 'authorizationId', v_auth.id,
    'refundId', v_refund.id, 'amountMicros', p_amount_micros::text,
    'transferId', v_post.transfer_id, 'receiptId', v_post.receipt_id, 'occurredAt', p_occurred_at
  ));
  return query select 'refunded', v_event_replay or v_post.replayed, v_refund.id, v_auth.id, v_card.id,
    v_post.transfer_id, v_post.receipt_id, v_post.to_balance_micros;
end;
$$;

create function money_private.list_cards_awaiting_issuer_close(p_limit integer default 100)
returns table (card_id uuid, agent_id text, provider text, provider_card_ref text, card_state text, close_requested_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_limit not between 1 and 1000 then
    raise exception 'issuer close limit must be between 1 and 1000' using errcode = '22023';
  end if;
  return query
    select c.id, c.agent_id, c.provider, c.provider_card_ref, c.state, c.close_requested_at
    from money.cards c
    where c.provider_card_ref is not null and c.issuer_closed_at is null and (
      c.state in ('confirmed', 'reversed', 'cancelled') or
      (c.state = 'pending' and c.close_requested_at is not null)
    )
    order by c.updated_at, c.id
    limit p_limit;
end;
$$;

-- Narrow worker reads: the event worker proves an issuer-side approval against
-- our own decision and resolves issuer card events to a card, without any table
-- access or tenant-facing detail.
create function money_private.get_card_authorization_by_ref(
  p_provider text,
  p_provider_authorization_ref text
)
returns table (
  authorization_id uuid, card_id uuid, agent_id text, state text, decline_code text,
  policy_payee text, amount_micros bigint, settled_micros bigint, is_verification boolean,
  reverse_after timestamptz, created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.card_id, a.agent_id, a.state, a.decline_code,
    a.policy_payee, a.amount_micros, a.settled_micros, a.is_verification,
    a.reverse_after, a.created_at
  from money.card_authorizations a
  where a.provider = p_provider and a.provider_authorization_ref = p_provider_authorization_ref
  order by (a.state <> 'declined') desc, a.created_at desc, a.id desc
  limit 1
$$;

create function money_private.get_card_by_provider_ref(
  p_provider text,
  p_provider_card_ref text
)
returns table (
  card_id uuid, agent_id text, card_state text, held_micros bigint, settled_micros bigint,
  cap_micros bigint, close_requested_at timestamptz, issuer_closed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.agent_id, c.state, c.held_micros, c.settled_micros,
    c.cap_micros, c.close_requested_at, c.issuer_closed_at
  from money.cards c
  where c.provider = p_provider and c.provider_card_ref = p_provider_card_ref
$$;

create function money_private.mark_card_issuer_closed(p_card_id uuid, p_provider_card_ref text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card money.cards%rowtype;
begin
  select c.* into v_card from money.cards c where c.id = p_card_id for update;
  if v_card.id is null then raise exception 'card not found' using errcode = 'P0002'; end if;
  if v_card.provider_card_ref is null or v_card.provider_card_ref <> p_provider_card_ref then
    raise exception 'issuer card reference does not match the card' using errcode = '22023';
  end if;
  if v_card.issuer_closed_at is not null then return false; end if;
  update money.cards c set issuer_closed_at = clock_timestamp(), updated_at = clock_timestamp()
  where c.id = v_card.id;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('card.issuer_closed', v_card.id::text, jsonb_build_object(
    'cardId', v_card.id, 'agentId', v_card.agent_id, 'provider', v_card.provider, 'state', v_card.state
  ));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- SKIP LOCKED sweeps. Cards are always locked before their authorizations so the
-- sweeps never cross the worker's lock order.
-- ---------------------------------------------------------------------------

create function money_private.sweep_card_authorizations(p_limit integer default 100)
returns table (authorization_id uuid, card_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card_id uuid;
  v_auth money.card_authorizations%rowtype;
begin
  if p_limit not between 1 and 1000 then
    raise exception 'sweep limit must be between 1 and 1000' using errcode = '22023';
  end if;
  for v_card_id in
    select c.id from money.cards c
    where c.state = 'pending' and exists (
      select 1 from money.card_authorizations a
      where a.card_id = c.id and a.state = 'pending' and a.reverse_after < clock_timestamp()
    )
    order by c.id
    limit p_limit
    for update skip locked
  loop
    for v_auth in
      select a.* from money.card_authorizations a
      where a.card_id = v_card_id and a.state = 'pending' and a.reverse_after < clock_timestamp()
      order by a.reverse_after, a.id
      for update
    loop
      update money.card_authorizations a set state = 'reversed', updated_at = clock_timestamp()
      where a.id = v_auth.id;
      update money.cards c set
        held_micros = c.held_micros - v_auth.amount_micros, updated_at = clock_timestamp()
      where c.id = v_card_id;
      insert into money.outbox_events(topic, aggregate_id, payload)
      values ('card.authorization_reversed', v_card_id::text, jsonb_build_object(
        'cardId', v_card_id, 'agentId', v_auth.agent_id, 'authorizationId', v_auth.id,
        'policyPayee', v_auth.policy_payee, 'amountMicros', v_auth.amount_micros::text,
        'reason', 'expired'
      ));
      authorization_id := v_auth.id;
      card_id := v_card_id;
      return next;
    end loop;
  end loop;
end;
$$;

create function money_private.sweep_cards(p_limit integer default 100)
returns table (card_id uuid, card_state text, release_transfer_id uuid)
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
    select c.id from money.cards c
    where c.state = 'pending' and c.held_micros = 0
      and (c.close_requested_at is not null or c.reverse_after < clock_timestamp())
    order by c.reverse_after, c.id
    limit p_limit
    for update skip locked
  loop
    select * into v_result from money_private.finalize_card(v_id);
    if v_result.finalized then
      card_id := v_id;
      card_state := v_result.card_state;
      release_transfer_id := v_result.release_transfer_id;
      return next;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reveal tokens: hash only, short-lived, single consume, bound to the card's
-- agent. The card number itself never enters this database.
-- ---------------------------------------------------------------------------

create function money_private.issue_card_reveal_token(
  p_agent_id text,
  p_card_id uuid,
  p_token_hash bytea,
  p_ttl_seconds integer
)
returns table (card_id uuid, expires_at timestamptz, reveal_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card money.cards%rowtype;
  v_expires_at timestamptz;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 or
     p_ttl_seconds is null or p_ttl_seconds not between 1 and 600 then
    raise exception 'invalid card reveal token' using errcode = '22023';
  end if;
  select c.* into v_card from money.cards c where c.id = p_card_id for update;
  if v_card.id is null then raise exception 'card not found' using errcode = 'P0002'; end if;
  if v_card.agent_id <> p_agent_id then raise exception 'card belongs to another agent' using errcode = '42501'; end if;
  if v_card.state <> 'pending' or v_card.close_requested_at is not null then
    raise exception 'card is not active' using errcode = '55000';
  end if;
  if v_card.reveal_count >= 3 then
    raise exception 'card reveal limit reached' using errcode = '55000';
  end if;
  v_expires_at := clock_timestamp() + make_interval(secs => p_ttl_seconds);
  insert into money.card_reveal_tokens(token_hash, card_id, agent_id, expires_at)
  values (p_token_hash, v_card.id, v_card.agent_id, v_expires_at);
  update money.cards c set reveal_count = c.reveal_count + 1, updated_at = clock_timestamp()
  where c.id = v_card.id
  returning c.reveal_count into reveal_count;
  return query select v_card.id, v_expires_at, reveal_count;
end;
$$;

create function money_private.consume_card_reveal_token(
  p_token_hash bytea,
  p_agent_id text,
  p_card_id uuid
)
returns table (card_id uuid, agent_id text, provider text, provider_card_ref text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token money.card_reveal_tokens%rowtype;
  v_card money.cards%rowtype;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'invalid card reveal token' using errcode = '22023';
  end if;
  -- The consumer is the signer of the reveal request and must be the agent the
  -- token was issued to. A missing consumer fails closed rather than skipping
  -- the binding.
  if p_agent_id is null or char_length(p_agent_id) = 0 then
    raise exception 'card reveal token consumer is required' using errcode = '22023';
  end if;
  -- The consume is also bound to the card the caller named. A mismatched card
  -- must fail closed BEFORE consumed_at is set: reveals are hard-bounded to
  -- three per card, so burning a token on a mistaken card id would silently
  -- waste one of them.
  if p_card_id is null then
    raise exception 'card reveal token card is required' using errcode = '22023';
  end if;
  select t.* into v_token from money.card_reveal_tokens t where t.token_hash = p_token_hash for update;
  if v_token.card_id is null then raise exception 'card reveal token not found' using errcode = 'P0002'; end if;
  if v_token.consumed_at is not null then raise exception 'card reveal token already used' using errcode = '55000'; end if;
  if v_token.expires_at <= clock_timestamp() then raise exception 'card reveal token expired' using errcode = '55000'; end if;
  if v_token.agent_id <> p_agent_id then
    raise exception 'card reveal token belongs to another agent' using errcode = '42501';
  end if;
  if v_token.card_id <> p_card_id then
    raise exception 'card reveal token was issued for a different card' using errcode = '55000';
  end if;
  select c.* into v_card from money.cards c where c.id = v_token.card_id for update;
  if v_card.state <> 'pending' or v_card.close_requested_at is not null or v_card.provider_card_ref is null then
    raise exception 'card is not active' using errcode = '55000';
  end if;
  update money.card_reveal_tokens t set consumed_at = clock_timestamp() where t.token_hash = p_token_hash;
  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('card.revealed', v_card.id::text, jsonb_build_object(
    'cardId', v_card.id, 'agentId', v_card.agent_id, 'revealCount', v_card.reveal_count
  ));
  return query select v_card.id, v_card.agent_id, v_card.provider, v_card.provider_card_ref;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tenant-scoped reads: the agent or its owning user, never another tenant.
-- ---------------------------------------------------------------------------

create function money_private.list_cards_for_requester(
  p_requester_id text,
  p_limit integer default 50
)
returns setof money.cards
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_limit not between 1 and 100 then
    raise exception 'card list limit must be between 1 and 100' using errcode = '22023';
  end if;
  return query
    select c.* from money.cards c
    join money.accounts agent on agent.id = c.agent_id
    join money.accounts requester on requester.id = p_requester_id and requester.status = 'active'
    where requester.id = c.agent_id or
      (requester.kind = 'user' and agent.owner_id = requester.id)
    order by c.created_at desc, c.id desc
    limit p_limit;
end;
$$;

create function money_private.get_card_for_requester(
  p_requester_id text,
  p_card_id uuid
)
returns setof money.cards
language sql
stable
security definer
set search_path = ''
as $$
  select c.* from money.cards c
  join money.accounts agent on agent.id = c.agent_id
  join money.accounts requester on requester.id = p_requester_id and requester.status = 'active'
  where c.id = p_card_id and (
    requester.id = c.agent_id or (requester.kind = 'user' and agent.owner_id = requester.id)
  )
$$;

create function money_private.get_card_for_agent_by_key(
  p_agent_id text,
  p_idempotency_key text
)
returns setof money.cards
language sql
stable
security definer
set search_path = ''
as $$
  select c.* from money.cards c
  join money.accounts a on a.id = p_agent_id and a.kind = 'agent' and a.status = 'active'
  where c.agent_id = p_agent_id and c.idempotency_key = p_idempotency_key
$$;

create function money_private.get_card_by_approval_for_owner(p_user_id text, p_approval_id uuid)
returns setof money.cards
language sql
stable
security definer
set search_path = ''
as $$
  select c.* from money.cards c
  join money.approvals a on a.id = c.approval_id
  where c.approval_id = p_approval_id and a.user_id = p_user_id
$$;

create function money_private.is_card_approval(p_user_id text, p_approval_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1 from money.cards c
    join money.accounts agent on agent.id = c.agent_id
    where c.approval_id = p_approval_id and agent.owner_id = p_user_id
  )
$$;

create function money_private.list_card_authorizations_for_requester(
  p_requester_id text,
  p_card_id uuid,
  p_limit integer default 20
)
returns setof money.card_authorizations
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_limit not between 1 and 100 then
    raise exception 'authorization list limit must be between 1 and 100' using errcode = '22023';
  end if;
  return query
    select a.* from money.card_authorizations a
    join money.cards c on c.id = a.card_id
    join money.accounts agent on agent.id = c.agent_id
    join money.accounts requester on requester.id = p_requester_id and requester.status = 'active'
    where a.card_id = p_card_id and (
      requester.id = c.agent_id or (requester.kind = 'user' and agent.owner_id = requester.id)
    )
    order by a.created_at desc, a.id desc
    limit p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers: immutable terms, write-once evidence, fixed transitions, breaker
-- enforcement, and propagation from approvals and mandates.
-- ---------------------------------------------------------------------------

create function money_private.protect_card_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.agent_id <> old.agent_id or new.mandate_id <> old.mandate_id or
     new.idempotency_key <> old.idempotency_key or new.cap_micros <> old.cap_micros or
     new.single_use <> old.single_use or new.merchant_hint <> old.merchant_hint or
     new.policy_payee <> old.policy_payee or new.mcc_allowlist is distinct from old.mcc_allowlist or
     new.expires_at <> old.expires_at or new.approval_id is distinct from old.approval_id or
     new.created_at <> old.created_at then
    raise exception 'card terms are immutable' using errcode = '55000';
  end if;
  if (old.provider is not null and new.provider is distinct from old.provider) or
     (old.provider_card_ref is not null and new.provider_card_ref is distinct from old.provider_card_ref) or
     (old.last4 is not null and new.last4 is distinct from old.last4) or
     (old.exp_month is not null and new.exp_month is distinct from old.exp_month) or
     (old.exp_year is not null and new.exp_year is distinct from old.exp_year) then
    raise exception 'issuer card material is write-once' using errcode = '55000';
  end if;
  if (old.transfer_seq is not null and new.transfer_seq is distinct from old.transfer_seq) or
     (old.receipt_id is not null and new.receipt_id is distinct from old.receipt_id) then
    raise exception 'card reserve evidence is immutable' using errcode = '55000';
  end if;
  if old.release_transfer_seq is not null and new.release_transfer_seq is distinct from old.release_transfer_seq then
    raise exception 'card release transfer is immutable' using errcode = '55000';
  end if;
  if old.locked_payee is not null and new.locked_payee is distinct from old.locked_payee then
    raise exception 'card merchant lock is write-once' using errcode = '55000';
  end if;
  if old.reverse_after is not null and new.reverse_after is distinct from old.reverse_after then
    raise exception 'card authorization window is immutable after activation' using errcode = '55000';
  end if;
  if (old.close_requested_at is not null and new.close_requested_at is distinct from old.close_requested_at) or
     (old.issuer_closed_at is not null and new.issuer_closed_at is distinct from old.issuer_closed_at) or
     new.reveal_count < old.reveal_count then
    raise exception 'card close evidence is write-once' using errcode = '55000';
  end if;
  if not (new.state = old.state or
    (old.state in ('prepared', 'approval_required') and new.state in ('cancelled', 'pending')) or
    (old.state = 'pending' and new.state in ('confirmed', 'reversed'))) then
    raise exception 'invalid card state transition % -> %', old.state, new.state using errcode = '55000';
  end if;
  if old.state <> 'pending' and (new.held_micros <> old.held_micros or new.settled_micros <> old.settled_micros) then
    raise exception 'card reserve accounting changes only while the card is pending' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function money_private.protect_card_transition() from public;

create trigger cards_protect_transition
before update on money.cards
for each row execute function money_private.protect_card_transition();

create function money_private.protect_card_authorization_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id or new.card_id <> old.card_id or new.agent_id <> old.agent_id or
     new.provider <> old.provider or new.provider_event_id <> old.provider_event_id or
     new.provider_authorization_ref <> old.provider_authorization_ref or
     new.policy_payee <> old.policy_payee or new.merchant_descriptor <> old.merchant_descriptor or
     new.merchant_mcc <> old.merchant_mcc or new.merchant_network_id is distinct from old.merchant_network_id or
     new.merchant_country is distinct from old.merchant_country or new.amount_micros <> old.amount_micros or
     new.is_verification <> old.is_verification or new.decline_code is distinct from old.decline_code or
     new.reverse_after is distinct from old.reverse_after or new.created_at <> old.created_at then
    raise exception 'card authorization terms are immutable' using errcode = '55000';
  end if;
  if old.state = 'declined' or not (new.state = old.state or
    (old.state = 'pending' and new.state in ('confirmed', 'reversed'))) then
    raise exception 'invalid card authorization transition % -> %', old.state, new.state using errcode = '55000';
  end if;
  if old.state = new.state and (
    new.settled_micros is distinct from old.settled_micros or
    new.settled_event_id is distinct from old.settled_event_id or
    new.voided_event_id is distinct from old.voided_event_id
  ) then
    raise exception 'card authorization evidence is write-once' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function money_private.protect_card_authorization_transition() from public;

create trigger card_authorizations_protect_transition
before update on money.card_authorizations
for each row execute function money_private.protect_card_authorization_transition();

create trigger cards_delete_forbidden
before delete on money.cards
for each row execute function money_private.forbid_immutable_mutation();

create trigger card_authorizations_delete_forbidden
before delete on money.card_authorizations
for each row execute function money_private.forbid_immutable_mutation();

create trigger card_refunds_append_only
before update or delete on money.card_refunds
for each row execute function money_private.forbid_immutable_mutation();

create trigger card_reveal_tokens_delete_forbidden
before delete on money.card_reveal_tokens
for each row execute function money_private.forbid_immutable_mutation();

create trigger card_event_inbox_delete_forbidden
before delete on money.card_event_inbox
for each row execute function money_private.forbid_immutable_mutation();

create trigger card_provider_events_delete_forbidden
before delete on money.card_provider_events
for each row execute function money_private.forbid_immutable_mutation();

create trigger card_event_reviews_update_forbidden
before update on money.card_event_reviews
for each row execute function money_private.forbid_immutable_mutation();

create trigger card_event_reviews_delete_forbidden
before delete on money.card_event_reviews
for each row execute function money_private.forbid_immutable_mutation();

create function money_private.enforce_card_reserve_treasury_control()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'pending' and (tg_op = 'INSERT' or old.state is distinct from 'pending') and not exists (
    select 1 from money.treasury_controls where singleton and card_spend_enabled
  ) then
    raise exception 'treasury card-spend circuit breaker is open' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function money_private.enforce_card_reserve_treasury_control() from public;

create trigger cards_reserve_treasury_control
before insert or update of state on money.cards
for each row execute function money_private.enforce_card_reserve_treasury_control();

create function money_private.cancel_card_with_approval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'pending' and new.status in ('rejected', 'expired', 'failed') then
    update money.cards c set
      state = 'cancelled',
      close_requested_at = coalesce(c.close_requested_at, clock_timestamp()),
      close_reason = coalesce(c.close_reason, left(coalesce(new.reason, 'approval ' || new.status), 500)),
      updated_at = clock_timestamp()
    where c.approval_id = new.id and c.state = 'approval_required';
  end if;
  return new;
end;
$$;

revoke all on function money_private.cancel_card_with_approval() from public;

create trigger approvals_cancel_card
after update of status on money.approvals
for each row execute function money_private.cancel_card_with_approval();

create function money_private.cancel_cards_for_mandate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    update money.cards c set
      state = 'cancelled',
      close_requested_at = coalesce(c.close_requested_at, clock_timestamp()),
      close_reason = coalesce(c.close_reason, 'mandate revoked'),
      updated_at = clock_timestamp()
    where c.mandate_id = new.id and c.state in ('prepared', 'approval_required');
    with requested as (
      update money.cards c set
        close_requested_at = clock_timestamp(), close_reason = 'mandate revoked', updated_at = clock_timestamp()
      where c.mandate_id = new.id and c.state = 'pending' and c.close_requested_at is null
      returning c.id, c.agent_id, c.held_micros
    )
    insert into money.outbox_events(topic, aggregate_id, payload)
    select 'card.close_requested', r.id::text, jsonb_build_object(
      'cardId', r.id, 'agentId', r.agent_id, 'requesterId', new.user_id,
      'reason', 'mandate revoked', 'heldMicros', r.held_micros::text
    ) from requested r;
  end if;
  return new;
end;
$$;

revoke all on function money_private.cancel_cards_for_mandate() from public;

create trigger mandates_cancel_cards
after update of revoked_at on money.mandates
for each row execute function money_private.cancel_cards_for_mandate();

-- ---------------------------------------------------------------------------
-- Ledger health: the 0005 body plus a cards clause. Every live card must trace
-- to exactly the reserve, approval, release, and authorization arithmetic that
-- produced it.
-- ---------------------------------------------------------------------------

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
    ) and not exists (
      select 1
      from money.cards c
      left join money.transfers reserve on reserve.seq = c.transfer_seq
      left join money.receipts receipt on receipt.id = c.receipt_id
      left join money.transfers release on release.seq = c.release_transfer_seq
      left join money.approvals approval on approval.id = c.approval_id
      where
        (c.state in ('pending', 'confirmed', 'reversed') and (
          reserve.seq is null or receipt.id is null or receipt.transfer_seq <> reserve.seq or
          reserve.actor_id <> c.agent_id or reserve.operation <> 'card_reserve' or
          reserve.from_account_id <> c.agent_id or reserve.to_account_id <> 'external:card' or
          reserve.asset_code <> 'USD' or reserve.amount_micros <> c.cap_micros or
          reserve.external_payee <> c.policy_payee or
          reserve.metadata->>'cardId' <> c.id::text or
          reserve.metadata->>'mandateId' <> c.mandate_id::text or
          reserve.metadata->>'clientIdempotencyKey' <> c.idempotency_key
        )) or
        (c.state not in ('pending', 'confirmed', 'reversed') and (
          c.transfer_seq is not null or c.receipt_id is not null or c.release_transfer_seq is not null
        )) or
        (c.approval_id is not null and (
          approval.id is null or approval.agent_id <> c.agent_id or
          approval.to_account_id <> 'external:card' or approval.asset_code <> 'USD' or
          approval.amount_micros <> c.cap_micros
        )) or
        (c.state in ('confirmed', 'reversed') and c.settled_micros < c.cap_micros and (
          release.seq is null or release.actor_id <> 'external:card' or
          release.operation <> 'card_release' or
          release.from_account_id <> 'external:card' or release.to_account_id <> c.agent_id or
          release.asset_code <> 'USD' or release.amount_micros <> c.cap_micros - c.settled_micros or
          release.external_payee <> c.policy_payee or
          release.metadata->>'cardId' <> c.id::text or
          release.metadata->>'originalTransferSeq' <> c.transfer_seq::text
        )) or
        (c.state in ('confirmed', 'reversed') and c.settled_micros = c.cap_micros and c.release_transfer_seq is not null) or
        (c.state = 'pending' and c.release_transfer_seq is not null) or
        c.held_micros <> (
          select coalesce(sum(a.amount_micros), 0) from money.card_authorizations a
          where a.card_id = c.id and a.state = 'pending'
        ) or
        c.settled_micros <> (
          select coalesce(sum(a.settled_micros), 0) from money.card_authorizations a
          where a.card_id = c.id and a.state = 'confirmed'
        )
    ) and not exists (
      select 1
      from money.card_authorizations a
      join money.cards c on c.id = a.card_id
      left join (
        select f.authorization_id, sum(f.amount_micros) as refunded_micros
        from money.card_refunds f group by f.authorization_id
      ) refunds on refunds.authorization_id = a.id
      where a.agent_id <> c.agent_id or
        (a.state <> 'declined' and c.state not in ('pending', 'confirmed', 'reversed')) or
        coalesce(refunds.refunded_micros, 0) > coalesce(a.settled_micros, 0)
    ) and not exists (
      select 1
      from money.card_refunds f
      join money.card_authorizations a on a.id = f.authorization_id
      left join money.transfers refund on refund.seq = f.transfer_seq
      left join money.receipts receipt on receipt.transfer_seq = f.transfer_seq
      where
        a.card_id <> f.card_id or a.state <> 'confirmed' or
        refund.seq is null or receipt.id is null or
        refund.actor_id <> 'external:card' or refund.operation <> 'card_refund' or
        refund.from_account_id <> 'external:card' or refund.to_account_id <> a.agent_id or
        refund.asset_code <> 'USD' or refund.amount_micros <> f.amount_micros or
        refund.metadata->>'cardId' <> f.card_id::text or
        refund.metadata->>'authorizationId' <> f.authorization_id::text
    )
$$;

-- Default-deny every card object and command. db/roles.sql grants only the
-- narrow surfaces needed by each process identity.
revoke all on table money.cards, money.card_authorizations, money.card_refunds,
  money.card_reveal_tokens, money.card_event_inbox, money.card_event_reviews,
  money.card_provider_events from public;

revoke all on function
  money_private.post_card_transfer(text,text,text,text,text,text,bigint,text,jsonb),
  money_private.card_policy_payee(text,text,text),
  money_private.card_payee_allowed(text[],text,text),
  money_private.assert_transfer_risk_decision(),
  money_private.evaluate_transfer_risk(text,text,text,bytea,text,text,text,bigint,jsonb),
  money_private.configure_treasury_controls(boolean,boolean,boolean,bigint,bigint,bigint,bigint,text),
  money_private.trip_treasury_breaker(text),
  money_private.set_card_spend_enabled(boolean,text),
  money_private.card_spend_control_state(),
  money_private.render_card_command(bigint,boolean),
  money_private.assert_card_provider_material(text,text,text,smallint,smallint,integer),
  money_private.prepare_card(uuid,text,text,bigint,boolean,text,text[],timestamptz),
  money_private.cancel_card_request(uuid,text,text,text,text,smallint,smallint),
  money_private.activate_card(text,uuid,text,text,text,smallint,smallint,integer),
  money_private.resolve_card_approval(text,uuid,text,text,text,text,text,smallint,smallint,integer),
  money_private.decide_card_authorization(text,text,text,text,bigint,text,text,text,text,integer),
  money_private.enqueue_card_provider_event(text,text,text,bytea),
  money_private.claim_card_provider_events(text,integer),
  money_private.complete_card_provider_event(text,bigint,text),
  money_private.fail_card_provider_event(text,bigint,text,integer,boolean),
  money_private.resolve_card_provider_event(bigint,text,text,text),
  money_private.record_card_provider_event(text,text,text,text,bytea,jsonb),
  money_private.finalize_card(uuid),
  money_private.close_card(text,uuid,text),
  money_private.settle_card_authorization(text,text,text,bigint,timestamptz,bytea,jsonb,integer),
  money_private.void_card_authorization(text,text,text,timestamptz,bytea,jsonb),
  money_private.refund_card_authorization(text,text,text,text,bigint,timestamptz,bytea,jsonb),
  money_private.list_cards_awaiting_issuer_close(integer),
  money_private.get_card_authorization_by_ref(text,text),
  money_private.get_card_by_provider_ref(text,text),
  money_private.mark_card_issuer_closed(uuid,text),
  money_private.sweep_card_authorizations(integer),
  money_private.sweep_cards(integer),
  money_private.issue_card_reveal_token(text,uuid,bytea,integer),
  money_private.consume_card_reveal_token(bytea,text,uuid),
  money_private.list_cards_for_requester(text,integer),
  money_private.get_card_for_requester(text,uuid),
  money_private.get_card_for_agent_by_key(text,text),
  money_private.get_card_by_approval_for_owner(text,uuid),
  money_private.is_card_approval(text,uuid),
  money_private.list_card_authorizations_for_requester(text,uuid,integer),
  money_private.protect_card_transition(),
  money_private.protect_card_authorization_transition(),
  money_private.enforce_card_reserve_treasury_control(),
  money_private.cancel_card_with_approval(),
  money_private.cancel_cards_for_mandate(),
  money_private.ledger_health()
from public;

comment on table money.cards
is 'Reserved cards: one card_reserve transfer per card, authority consumed by authorizations, remainder released on close. No card number is stored.';
