-- Durable signed-request authentication and tenant-scoped control-plane reads.
-- The API verifies Ed25519 in-process, then records the verified envelope here.
-- Nonce uniqueness and freshness therefore remain correct across every API
-- replica, while payment policy stays in the same database as the ledger.

create unique index accounts_public_key_unique_idx
  on money.accounts(public_key)
  where public_key is not null;

create table money.signed_request_nonces (
  account_id text not null references money.accounts(id),
  nonce text not null check (char_length(nonce) between 8 and 200),
  request_hash bytea not null check (octet_length(request_hash) = 32),
  signed_at timestamptz not null,
  expires_at timestamptz not null,
  accepted_at timestamptz not null default clock_timestamp(),
  primary key (account_id, nonce),
  check (expires_at > signed_at)
);

create index signed_request_nonces_expiry_idx
  on money.signed_request_nonces(expires_at);

create or replace function money_private.consume_signed_request(
  p_account_id text,
  p_expected_kind text,
  p_expected_public_key text,
  p_nonce text,
  p_signed_at_ms bigint,
  p_request_hash bytea
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account money.accounts%rowtype;
  v_signed_at timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if p_expected_kind not in ('user', 'agent', 'provider') then
    raise exception 'invalid signed-request account kind' using errcode = '22023';
  end if;
  if p_nonce is null or char_length(p_nonce) not between 8 and 200 then
    raise exception 'invalid signature nonce' using errcode = '22023';
  end if;
  if p_request_hash is null or octet_length(p_request_hash) <> 32 then
    raise exception 'invalid signed-request hash' using errcode = '22023';
  end if;

  v_signed_at := to_timestamp(p_signed_at_ms::numeric / 1000);
  if v_signed_at < v_now - interval '2 minutes' or v_signed_at > v_now + interval '30 seconds' then
    raise exception 'signature timestamp outside the accepted window' using errcode = '28000';
  end if;

  select a.* into v_account from money.accounts a where a.id = p_account_id for update;
  if v_account.id is null or v_account.kind <> p_expected_kind or v_account.status <> 'active' then
    raise exception 'unknown or inactive signed-request account' using errcode = '28000';
  end if;
  if v_account.public_key is null or v_account.public_key <> p_expected_public_key then
    raise exception 'account key changed before request acceptance' using errcode = '28000';
  end if;

  delete from money.signed_request_nonces n
  where n.account_id = p_account_id and n.expires_at <= v_now;

  begin
    insert into money.signed_request_nonces(
      account_id, nonce, request_hash, signed_at, expires_at
    ) values (
      p_account_id, p_nonce, p_request_hash, v_signed_at, v_signed_at + interval '2 minutes'
    );
  exception when unique_violation then
    raise exception 'signature nonce already used' using errcode = '28000';
  end;
  return true;
end;
$$;

revoke all on function money_private.consume_signed_request(text, text, text, text, bigint, bytea) from public;

-- Public keys are natural retry identifiers for account onboarding. The
-- advisory lock closes the concurrent signup race before the unique index is
-- reached; changed terms with the same key are rejected.
create or replace function money_private.register_public_identity(
  p_actor_id text,
  p_id text,
  p_kind text,
  p_name text,
  p_owner_id text,
  p_handle text,
  p_public_key text
)
returns table (
  id text,
  kind text,
  owner_id text,
  name text,
  handle text,
  public_key text,
  status text,
  created_at timestamptz,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prior money.accounts%rowtype;
  v_account money.accounts%rowtype;
begin
  if p_public_key is null or char_length(p_public_key) not between 32 and 2048 then
    raise exception 'public key is required' using errcode = '22023';
  end if;
  if p_kind = 'user' then
    if p_actor_id is not null or p_owner_id is not null then
      raise exception 'user signup cannot claim an actor or owner' using errcode = '42501';
    end if;
  elsif p_kind in ('agent', 'provider') then
    if p_actor_id is null or p_actor_id <> p_owner_id then
      raise exception 'child identity must be created by its owner' using errcode = '42501';
    end if;
  else
    raise exception 'invalid public identity kind' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_public_key, 6_180_003));
  select a.* into v_prior from money.accounts a where a.public_key = p_public_key for update;
  if v_prior.id is not null then
    if v_prior.kind <> p_kind
      or v_prior.name <> p_name
      or v_prior.owner_id is distinct from p_owner_id
      or v_prior.handle is distinct from p_handle then
      raise exception 'public key is already registered with different identity terms' using errcode = '23505';
    end if;
    return query select
      v_prior.id, v_prior.kind, v_prior.owner_id, v_prior.name,
      v_prior.handle, v_prior.public_key, v_prior.status, v_prior.created_at, true;
    return;
  end if;

  select * into v_account from money_private.register_account(
    p_id, p_kind, p_name, p_owner_id, p_handle, p_public_key
  );
  return query select
    v_account.id, v_account.kind, v_account.owner_id, v_account.name,
    v_account.handle, v_account.public_key, v_account.status, v_account.created_at, false;
end;
$$;

revoke all on function money_private.register_public_identity(text, text, text, text, text, text, text) from public;

create or replace function money_private.rotate_public_key(
  p_owner_id text,
  p_target_id text,
  p_new_public_key text
)
returns table (account_id text, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner money.accounts%rowtype;
  v_target money.accounts%rowtype;
begin
  if p_new_public_key is null or char_length(p_new_public_key) not between 32 and 2048 then
    raise exception 'new public key is required' using errcode = '22023';
  end if;
  perform 1 from money.accounts a
  where a.id in (p_owner_id, p_target_id)
  order by a.id for update;
  select a.* into v_owner from money.accounts a where a.id = p_owner_id;
  select a.* into v_target from money.accounts a where a.id = p_target_id;
  if v_owner.id is null or v_owner.kind <> 'user' or v_owner.status <> 'active' then
    raise exception 'key rotation owner is invalid' using errcode = '42501';
  end if;
  if v_target.id is null or v_target.status <> 'active' then
    raise exception 'key rotation target is invalid' using errcode = 'P0002';
  end if;
  if v_target.id <> p_owner_id and not (
    v_target.kind in ('agent', 'provider') and v_target.owner_id = p_owner_id
  ) then
    raise exception 'owner cannot rotate this account' using errcode = '42501';
  end if;
  if v_target.public_key = p_new_public_key then
    return query select p_target_id, false;
    return;
  end if;

  update money.accounts a set
    public_key = p_new_public_key,
    updated_at = clock_timestamp()
  where a.id = p_target_id;

  if p_target_id = p_owner_id then
    update money.owner_sessions s set revoked_at = clock_timestamp()
    where s.user_id = p_owner_id and s.revoked_at is null;
  end if;

  insert into money.outbox_events(topic, aggregate_id, payload)
  values ('account.key_rotated', p_target_id, jsonb_build_object(
    'accountId', p_target_id, 'ownerId', p_owner_id
  ));
  return query select p_target_id, true;
end;
$$;

revoke all on function money_private.rotate_public_key(text, text, text) from public;

create or replace function money_private.create_owner_session(
  p_user_id text,
  p_token_hash bytea
)
returns table (expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user money.accounts%rowtype;
  v_count integer;
  v_expires timestamptz := clock_timestamp() + interval '8 hours';
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then
    raise exception 'invalid session token hash' using errcode = '22023';
  end if;
  select a.* into v_user from money.accounts a where a.id = p_user_id for update;
  if v_user.id is null or v_user.kind <> 'user' or v_user.status <> 'active' then
    raise exception 'owner session requires an active user' using errcode = '42501';
  end if;

  update money.owner_sessions s set revoked_at = clock_timestamp()
  where s.user_id = p_user_id and s.revoked_at is null and s.expires_at <= clock_timestamp();
  select count(*) into v_count from money.owner_sessions s
  where s.user_id = p_user_id and s.revoked_at is null and s.expires_at > clock_timestamp();
  if v_count >= 10 then
    update money.owner_sessions s set revoked_at = clock_timestamp()
    where s.token_hash in (
      select old.token_hash from money.owner_sessions old
      where old.user_id = p_user_id and old.revoked_at is null and old.expires_at > clock_timestamp()
      order by old.created_at, old.token_hash
      limit (v_count - 9)
    );
  end if;

  insert into money.owner_sessions(user_id, token_hash, expires_at)
  values (p_user_id, p_token_hash, v_expires);
  return query select v_expires;
end;
$$;

revoke all on function money_private.create_owner_session(text, bytea) from public;

create or replace function money_private.resolve_owner_session(p_token_hash bytea)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.user_id from money.owner_sessions s
  join money.accounts a on a.id = s.user_id
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.expires_at > clock_timestamp()
    and a.kind = 'user'
    and a.status = 'active'
$$;

revoke all on function money_private.resolve_owner_session(bytea) from public;

create or replace function money_private.revoke_owner_session(
  p_user_id text,
  p_token_hash bytea
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update money.owner_sessions s set revoked_at = clock_timestamp()
  where s.user_id = p_user_id and s.token_hash = p_token_hash and s.revoked_at is null;
  return found;
end;
$$;

revoke all on function money_private.revoke_owner_session(text, bytea) from public;

create or replace function money_private.resolve_public_account(p_reference text)
returns table (
  id text,
  kind text,
  owner_id text,
  name text,
  handle text,
  status text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.kind, a.owner_id, a.name, a.handle, a.status, a.created_at
  from money.accounts a
  where a.id = p_reference or (p_reference like '@%' and a.handle = substring(p_reference from 2))
  order by case when a.id = p_reference then 0 else 1 end
  limit 1
$$;

revoke all on function money_private.resolve_public_account(text) from public;

create or replace function money_private.account_state(
  p_requester_id text,
  p_asset_code text default 'USD'
)
returns table (
  id text,
  kind text,
  owner_id text,
  name text,
  handle text,
  status text,
  created_at timestamptz,
  balance_micros bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.kind, a.owner_id, a.name, a.handle, a.status, a.created_at,
    coalesce(b.available_micros, 0)
  from money.accounts requester
  join money.accounts a on (
    a.id = requester.id or (requester.kind = 'user' and a.owner_id = requester.id)
  )
  left join money.balances b on b.account_id = a.id and b.asset_code = p_asset_code
  where requester.id = p_requester_id and requester.status = 'active'
  order by a.created_at, a.id
$$;

revoke all on function money_private.account_state(text, text) from public;

create or replace function money_private.list_services_for_requester(p_requester_id text)
returns setof money.services
language sql
stable
security definer
set search_path = ''
as $$
  select s.* from money.services s
  join money.accounts provider on provider.id = s.provider_id
  join money.accounts requester on requester.id = p_requester_id and requester.status = 'active'
  where s.provider_id = requester.id
     or (requester.kind = 'user' and provider.owner_id = requester.id)
  order by s.created_at desc, s.id desc
$$;

revoke all on function money_private.list_services_for_requester(text) from public;

create or replace function money_private.payment_feed(
  p_requester_id text,
  p_limit integer default 25
)
returns table (
  receipt_id uuid,
  receipt_seq bigint,
  transfer_id uuid,
  from_account_id text,
  to_account_id text,
  asset_code text,
  amount_micros bigint,
  memo text,
  mandate_id uuid,
  operation text,
  idempotency_key text,
  created_at timestamptz,
  evidence_hash bytea
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_limit not between 1 and 100 then
    raise exception 'feed limit must be between 1 and 100' using errcode = '22023';
  end if;
  return query
    with accessible as (
      select a.id from money.accounts requester
      join money.accounts a on (
        a.id = requester.id or (requester.kind = 'user' and a.owner_id = requester.id)
      )
      where requester.id = p_requester_id and requester.status = 'active'
    )
    select r.id, r.seq, t.id, t.from_account_id, t.to_account_id,
      t.asset_code, t.amount_micros, t.memo,
      coalesce(t.mandate_id, ta.mandate_id), t.operation, t.idempotency_key, t.created_at, r.evidence_hash
    from money.receipts r
    join money.transfers t on t.seq = r.transfer_seq
    left join money.transfer_authorizations ta on ta.transfer_seq = t.seq
    where t.from_account_id in (select id from accessible)
       or t.to_account_id in (select id from accessible)
    order by t.created_at desc, t.seq desc
    limit p_limit;
end;
$$;

revoke all on function money_private.payment_feed(text, integer) from public;

create or replace function money_private.get_receipt(
  p_requester_id text,
  p_receipt_id uuid
)
returns table (
  receipt_id uuid,
  receipt_seq bigint,
  transfer_id uuid,
  from_account_id text,
  to_account_id text,
  asset_code text,
  amount_micros bigint,
  memo text,
  mandate_id uuid,
  operation text,
  idempotency_key text,
  created_at timestamptz,
  evidence_hash bytea
)
language sql
stable
security definer
set search_path = ''
as $$
  with requester as (
    select a.* from money.accounts a where a.id = p_requester_id and a.status = 'active'
  )
  select r.id, r.seq, t.id, t.from_account_id, t.to_account_id,
    t.asset_code, t.amount_micros, t.memo,
    coalesce(t.mandate_id, ta.mandate_id), t.operation, t.idempotency_key, t.created_at, r.evidence_hash
  from money.receipts r
  join money.transfers t on t.seq = r.transfer_seq
  left join money.transfer_authorizations ta on ta.transfer_seq = t.seq
  join requester q on (
    t.from_account_id = q.id or t.to_account_id = q.id or
    (q.kind = 'user' and (
      exists (select 1 from money.accounts owned where owned.id = t.from_account_id and owned.owner_id = q.id) or
      exists (select 1 from money.accounts owned where owned.id = t.to_account_id and owned.owner_id = q.id)
    ))
  )
  where r.id = p_receipt_id
$$;

revoke all on function money_private.get_receipt(text, uuid) from public;

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
      where r.evidence_hash <> public.digest(jsonb_build_object(
        'transferId', t.id,
        'actor', t.actor_id,
        'operation', t.operation,
        'from', t.from_account_id,
        'to', t.to_account_id,
        'asset', t.asset_code,
        'amount', t.amount_micros,
        'memo', t.memo,
        'requestHash', encode(t.request_hash, 'hex')
      )::text, 'sha256')
    )
$$;

revoke all on function money_private.ledger_health() from public;

comment on table money.signed_request_nonces
is 'Durable replay defense for API-verified Ed25519 request envelopes; actor-scoped and self-pruning on use.';
