-- money production ledger kernel
--
-- The journal is the source of truth. balances is a transactionally updated
-- cache that makes authorization a single indexed row read. Every transfer is
-- exactly two signed entries in one asset, enforced again by a deferred
-- constraint trigger at commit.

create extension if not exists pgcrypto;

create schema if not exists money;
create schema if not exists money_private;

revoke all on schema money_private from public;

create table money.assets (
  code text primary key,
  decimals smallint not null check (decimals between 0 and 18),
  name text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp()
);

insert into money.assets (code, decimals, name)
values ('USD', 6, 'US dollar micros')
on conflict (code) do nothing;

create table money.accounts (
  id text primary key,
  kind text not null check (kind in ('user', 'agent', 'provider', 'external')),
  owner_id text references money.accounts(id),
  name text not null check (char_length(name) between 1 and 200),
  handle text unique,
  public_key text,
  status text not null default 'active' check (status in ('active', 'frozen', 'closed')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (handle is null or handle ~ '^[a-z][a-z0-9_-]{2,31}$'),
  check (
    (kind in ('agent', 'provider') and owner_id is not null) or
    (kind in ('user', 'external') and owner_id is null)
  )
);

create index accounts_owner_id_idx on money.accounts(owner_id) where owner_id is not null;

create table money.balances (
  account_id text not null references money.accounts(id),
  asset_code text not null references money.assets(code),
  available_micros bigint not null default 0,
  pending_micros bigint not null default 0 check (pending_micros >= 0),
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (account_id, asset_code)
);

create table money.idempotency_keys (
  id bigint generated always as identity primary key,
  actor_id text not null references money.accounts(id),
  operation text not null check (operation ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  request_hash bytea not null check (octet_length(request_hash) = 32),
  state text not null default 'in_progress' check (state in ('in_progress', 'completed')),
  result_kind text,
  result_id text,
  result jsonb,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (actor_id, operation, idempotency_key),
  check (
    (state = 'in_progress' and completed_at is null) or
    (state = 'completed' and completed_at is not null and result_kind is not null)
  )
);

create table money.transfers (
  seq bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid() unique,
  actor_id text not null references money.accounts(id),
  operation text not null,
  idempotency_key text not null,
  request_hash bytea not null check (octet_length(request_hash) = 32),
  from_account_id text not null references money.accounts(id),
  to_account_id text not null references money.accounts(id),
  asset_code text not null references money.assets(code),
  amount_micros bigint not null check (amount_micros > 0),
  memo text not null default '' check (char_length(memo) <= 500),
  mandate_id uuid,
  external_payee text,
  refund_of uuid,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (actor_id, operation, idempotency_key),
  check (from_account_id <> to_account_id)
);

create index transfers_from_created_idx on money.transfers(from_account_id, created_at desc, seq desc);
create index transfers_to_created_idx on money.transfers(to_account_id, created_at desc, seq desc);
create index transfers_mandate_idx on money.transfers(mandate_id) where mandate_id is not null;
create index transfers_refund_idx on money.transfers(refund_of) where refund_of is not null;

create table money.ledger_entries (
  transfer_seq bigint not null references money.transfers(seq),
  account_id text not null references money.accounts(id),
  asset_code text not null references money.assets(code),
  amount_micros bigint not null check (amount_micros <> 0),
  created_at timestamptz not null default clock_timestamp(),
  primary key (transfer_seq, account_id)
);

create index ledger_entries_account_asset_created_idx
  on money.ledger_entries(account_id, asset_code, created_at desc, transfer_seq desc);

create table money.receipts (
  seq bigint generated always as identity primary key,
  id uuid not null default gen_random_uuid() unique,
  transfer_seq bigint not null unique references money.transfers(seq),
  evidence_hash bytea not null check (octet_length(evidence_hash) = 32),
  anchor_batch_id bigint,
  created_at timestamptz not null default clock_timestamp()
);

create table money.mandates (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references money.accounts(id),
  agent_id text not null references money.accounts(id),
  asset_code text not null references money.assets(code),
  budget_micros bigint not null check (budget_micros >= 0),
  per_tx_cap_micros bigint not null check (per_tx_cap_micros >= 0),
  daily_cap_micros bigint not null check (daily_cap_micros >= 0),
  escalate_above_micros bigint not null check (escalate_above_micros >= 0),
  new_payee_cap_micros bigint not null check (new_payee_cap_micros >= 0),
  payee_allowlist text[],
  spent_micros bigint not null default 0 check (spent_micros >= 0),
  spent_today_micros bigint not null default 0 check (spent_today_micros >= 0),
  spend_day date not null default (current_timestamp at time zone 'utc')::date,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, idempotency_key),
  check (spent_micros <= budget_micros)
);

create unique index mandates_one_active_agent_asset_idx
  on money.mandates(agent_id, asset_code)
  where revoked_at is null;
create index mandates_user_created_idx on money.mandates(user_id, created_at desc);

alter table money.transfers
  add constraint transfers_mandate_id_fkey
  foreign key (mandate_id) references money.mandates(id);

create table money.mandate_seen_payees (
  mandate_id uuid not null references money.mandates(id),
  payee_id text not null,
  first_seen_at timestamptz not null default clock_timestamp(),
  primary key (mandate_id, payee_id)
);

create table money.approvals (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references money.accounts(id),
  mandate_id uuid not null references money.mandates(id),
  agent_id text not null references money.accounts(id),
  to_account_id text not null references money.accounts(id),
  asset_code text not null references money.assets(code),
  amount_micros bigint not null check (amount_micros > 0),
  memo text not null default '' check (char_length(memo) <= 500),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'failed')),
  expires_at timestamptz not null,
  resolved_at timestamptz,
  receipt_id uuid references money.receipts(id),
  reason text check (reason is null or char_length(reason) <= 500),
  created_at timestamptz not null default clock_timestamp(),
  unique (agent_id, idempotency_key),
  check (agent_id <> to_account_id),
  check (
    (status = 'pending' and resolved_at is null and receipt_id is null) or
    (status = 'approved' and resolved_at is not null and receipt_id is not null) or
    (status in ('rejected', 'expired', 'failed') and resolved_at is not null and receipt_id is null)
  )
);

create index approvals_owner_pending_idx on money.approvals(user_id, created_at)
  where status = 'pending';
create index approvals_agent_created_idx on money.approvals(agent_id, created_at desc);

create table money.services (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references money.accounts(id),
  slug text not null check (slug ~ '^[a-z][a-z0-9-]{1,47}$'),
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  endpoint_url text not null check (char_length(endpoint_url) <= 2048),
  asset_code text not null references money.assets(code),
  price_micros bigint not null check (price_micros > 0),
  active boolean not null default true,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (provider_id, slug),
  unique (provider_id, idempotency_key)
);

create table money.challenges (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references money.accounts(id),
  service_id uuid references money.services(id),
  asset_code text not null references money.assets(code),
  amount_micros bigint not null check (amount_micros > 0),
  resource text not null check (char_length(resource) <= 2048),
  paid_by text references money.accounts(id),
  receipt_id uuid references money.receipts(id),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check ((paid_by is null) = (receipt_id is null))
);

create index challenges_unpaid_expiry_idx on money.challenges(expires_at)
  where receipt_id is null;
create index challenges_provider_created_idx on money.challenges(provider_id, created_at desc);

create table money.external_payments (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references money.accounts(id),
  transfer_seq bigint not null unique references money.transfers(seq),
  receipt_id uuid not null unique references money.receipts(id),
  host text not null,
  pay_to text not null,
  settlement_asset text not null,
  settlement_network text not null,
  resource text not null,
  payment_header_ciphertext bytea not null,
  state text not null default 'pending' check (state in ('pending', 'confirmed', 'reversed')),
  reverse_after timestamptz not null,
  settled_tx text,
  reversal_transfer_seq bigint references money.transfers(seq),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index external_payments_pending_reverse_idx on money.external_payments(reverse_after)
  where state = 'pending';
create index external_payments_agent_created_idx on money.external_payments(agent_id, created_at desc);

create table money.owner_sessions (
  token_hash bytea primary key check (octet_length(token_hash) = 32),
  user_id text not null references money.accounts(id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

create index owner_sessions_user_active_idx on money.owner_sessions(user_id, created_at desc)
  where revoked_at is null;
create index owner_sessions_expiry_idx on money.owner_sessions(expires_at)
  where revoked_at is null;

create table money.outbox_events (
  id bigint generated always as identity primary key,
  topic text not null,
  aggregate_id text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  available_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  locked_at timestamptz,
  locked_by text,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default clock_timestamp()
);

create index outbox_ready_idx on money.outbox_events(available_at, id)
  where published_at is null;

-- External boundary accounts are the only accounts permitted to go negative.
insert into money.accounts (id, kind, name)
values
  ('external:funding', 'external', 'External funding boundary'),
  ('external:x402', 'external', 'External x402 settlement boundary')
on conflict (id) do nothing;

insert into money.balances (account_id, asset_code)
select id, 'USD' from money.accounts where kind = 'external'
on conflict (account_id, asset_code) do nothing;

create or replace function money_private.assert_balanced_transfer()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_transfer_seq bigint := coalesce(new.transfer_seq, old.transfer_seq);
  v_count integer;
  v_total numeric;
  v_assets integer;
  v_transfer_asset text;
begin
  select count(*), coalesce(sum(amount_micros::numeric), 0), count(distinct asset_code)
    into v_count, v_total, v_assets
  from money.ledger_entries
  where transfer_seq = v_transfer_seq;

  select asset_code into v_transfer_asset
  from money.transfers
  where seq = v_transfer_seq;

  if v_count <> 2 or v_total <> 0 or v_assets <> 1 or not exists (
    select 1 from money.ledger_entries
    where transfer_seq = v_transfer_seq and asset_code = v_transfer_asset
  ) then
    raise exception 'transfer % must contain exactly two zero-sum entries in its declared asset', v_transfer_seq
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger ledger_entries_balanced
after insert or update or delete on money.ledger_entries
deferrable initially deferred
for each row execute function money_private.assert_balanced_transfer();

create or replace function money_private.forbid_immutable_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end;
$$;

create trigger transfers_append_only
before update or delete on money.transfers
for each row execute function money_private.forbid_immutable_mutation();

create trigger ledger_entries_append_only
before update or delete on money.ledger_entries
for each row execute function money_private.forbid_immutable_mutation();

create trigger receipts_append_only
before update or delete on money.receipts
for each row execute function money_private.forbid_immutable_mutation();

create or replace function money_private.register_account(
  p_id text,
  p_kind text,
  p_name text,
  p_owner_id text default null,
  p_handle text default null,
  p_public_key text default null
)
returns money.accounts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner money.accounts%rowtype;
  v_account money.accounts%rowtype;
begin
  if p_kind not in ('user', 'agent', 'provider') then
    raise exception 'only user, agent, and provider identities can be registered' using errcode = '22023';
  end if;
  if p_id is null or p_id !~ (case p_kind
    when 'user' then '^usr_[A-Za-z0-9_-]{8,128}$'
    when 'agent' then '^agt_[A-Za-z0-9_-]{8,128}$'
    else '^prv_[A-Za-z0-9_-]{8,128}$'
  end) then
    raise exception 'account id does not match its kind' using errcode = '22023';
  end if;
  if p_name is null or char_length(p_name) not between 1 and 200 then
    raise exception 'account name must contain 1-200 characters' using errcode = '22023';
  end if;
  if p_handle is not null and p_handle !~ '^[a-z][a-z0-9_-]{2,31}$' then
    raise exception 'invalid public handle' using errcode = '22023';
  end if;

  if p_kind = 'user' then
    if p_owner_id is not null then
      raise exception 'user accounts cannot have an owner' using errcode = '22023';
    end if;
  else
    select * into v_owner from money.accounts where id = p_owner_id for key share;
    if v_owner.id is null or v_owner.kind <> 'user' or v_owner.status <> 'active' then
      raise exception 'agent/provider owner must be an active user' using errcode = '23503';
    end if;
  end if;

  insert into money.accounts (id, kind, owner_id, name, handle, public_key)
  values (p_id, p_kind, p_owner_id, p_name, p_handle, p_public_key)
  returning * into v_account;

  insert into money.balances (account_id, asset_code)
  select p_id, code from money.assets where enabled
  on conflict (account_id, asset_code) do nothing;

  insert into money.outbox_events (topic, aggregate_id, payload)
  values ('account.registered', p_id, jsonb_build_object(
    'accountId', p_id, 'kind', p_kind, 'ownerId', p_owner_id, 'handle', p_handle
  ));

  return v_account;
end;
$$;

revoke all on function money_private.register_account(text, text, text, text, text, text) from public;

-- The atomic posting primitive. It owns idempotency reservation, deterministic
-- account locking, balance checks, the two journal entries, receipt evidence,
-- and the outbox event. No HTTP or chain call belongs inside this transaction.
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

  v_hash := public.digest(jsonb_build_object(
    'actor', p_actor_id,
    'operation', p_operation,
    'from', p_from_account_id,
    'to', p_to_account_id,
    'asset', p_asset_code,
    'amount', p_amount_micros,
    'memo', p_memo,
    'metadata', p_metadata
  )::text, 'sha256');

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

  -- Lock identities in lexical order. Every posting path follows this order,
  -- eliminating the A->B / B->A deadlock pattern.
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

  -- Actor/operation authorization is enforced in the money kernel, not left
  -- to whichever API endpoint happened to call it.
  if p_operation = 'pay' and (p_actor_id <> p_from_account_id or v_from.kind <> 'agent' or v_to.kind = 'external') then
    raise exception 'pay requires the actor agent to be the sender and an internal recipient' using errcode = '42501';
  elsif p_operation = 'allocate' and (
    p_actor_id <> p_from_account_id or v_from.kind <> 'user' or v_to.kind <> 'agent' or v_to.owner_id <> p_actor_id
  ) then
    raise exception 'allocate requires an owner sending to its own agent' using errcode = '42501';
  elsif p_operation = 'fund' and (
    p_from_account_id <> 'external:funding' or p_actor_id <> p_to_account_id or v_to.kind <> 'user'
  ) then
    raise exception 'fund requires the external funding boundary to credit the actor user' using errcode = '42501';
  elsif p_operation not in ('pay', 'allocate', 'fund') then
    raise exception 'unsupported transfer operation' using errcode = '22023';
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
    from_account_id, to_account_id, asset_code, amount_micros, memo, metadata
  ) values (
    p_actor_id, p_operation, p_idempotency_key, v_hash,
    p_from_account_id, p_to_account_id, p_asset_code, p_amount_micros, p_memo, p_metadata
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
    public.digest(jsonb_build_object(
      'transferId', v_transfer_id,
      'actor', p_actor_id,
      'operation', p_operation,
      'from', p_from_account_id,
      'to', p_to_account_id,
      'asset', p_asset_code,
      'amount', p_amount_micros,
      'memo', p_memo,
      'requestHash', encode(v_hash, 'hex')
    )::text, 'sha256')
  ) returning id into v_receipt_id;

  insert into money.outbox_events (topic, aggregate_id, payload)
  values (
    'transfer.posted',
    v_transfer_id::text,
    jsonb_build_object(
      'transferId', v_transfer_id,
      'receiptId', v_receipt_id,
      'actorId', p_actor_id,
      'operation', p_operation,
      'from', p_from_account_id,
      'to', p_to_account_id,
      'asset', p_asset_code,
      'amountMicros', p_amount_micros::text
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

revoke all on function money_private.post_transfer(text, text, text, text, text, text, bigint, text, jsonb) from public;

create or replace function money_private.post_agent_payment(
  p_agent_id text,
  p_idempotency_key text,
  p_to_account_id text,
  p_asset_code text,
  p_amount_micros bigint,
  p_memo text default '',
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  status text, replayed boolean, transfer_id uuid, receipt_id uuid,
  denial_code text, reason text, from_balance_micros bigint, to_balance_micros bigint
)
language sql
security definer
set search_path = ''
as $$
  select * from money_private.post_transfer(
    p_agent_id, 'pay', p_idempotency_key, p_agent_id, p_to_account_id,
    p_asset_code, p_amount_micros, p_memo, p_metadata
  )
$$;

create or replace function money_private.post_owner_allocation(
  p_owner_id text,
  p_idempotency_key text,
  p_agent_id text,
  p_asset_code text,
  p_amount_micros bigint,
  p_memo text default '',
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  status text, replayed boolean, transfer_id uuid, receipt_id uuid,
  denial_code text, reason text, from_balance_micros bigint, to_balance_micros bigint
)
language sql
security definer
set search_path = ''
as $$
  select * from money_private.post_transfer(
    p_owner_id, 'allocate', p_idempotency_key, p_owner_id, p_agent_id,
    p_asset_code, p_amount_micros, p_memo, p_metadata
  )
$$;

create or replace function money_private.post_confirmed_funding(
  p_user_id text,
  p_settlement_id text,
  p_asset_code text,
  p_amount_micros bigint,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  status text, replayed boolean, transfer_id uuid, receipt_id uuid,
  denial_code text, reason text, from_balance_micros bigint, to_balance_micros bigint
)
language sql
security definer
set search_path = ''
as $$
  select * from money_private.post_transfer(
    p_user_id, 'fund', p_settlement_id, 'external:funding', p_user_id,
    p_asset_code, p_amount_micros, 'confirmed external funding', p_metadata
  )
$$;

revoke all on function money_private.post_agent_payment(text, text, text, text, bigint, text, jsonb) from public;
revoke all on function money_private.post_owner_allocation(text, text, text, text, bigint, text, jsonb) from public;
revoke all on function money_private.post_confirmed_funding(text, text, text, bigint, jsonb) from public;

comment on function money_private.post_transfer(text, text, text, text, text, text, bigint, text, jsonb)
is 'Atomic, actor-authorized, idempotent double-entry posting primitive. Grant EXECUTE only to the money application role.';

comment on table money.ledger_entries
is 'Immutable source-of-truth journal. Every transfer has exactly two zero-sum entries in one asset.';

comment on table money.balances
is 'Transactionally maintained authorization cache; reconcile continuously against ledger_entries.';
