-- Hosted compliance onboarding and named operator control plane.
--
-- Provider credentials and hosted URLs stay outside the product database
-- trust boundary: the provider worker stores only an authenticated reference,
-- a URL hash, and AES-GCM ciphertext. Human decisions are attributable to a
-- named Ed25519 operator. High-impact decisions require a different maker and
-- checker and execute atomically with their audit trail.

create table money.compliance_verification_sessions (
  id uuid primary key default public.gen_random_uuid(),
  subject_account_id text not null
    references money.compliance_subjects(account_id) on delete restrict,
  provider text not null check (provider ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  state text not null default 'requested'
    check (state in ('requested', 'creating', 'ready', 'failed', 'expired', 'completed', 'cancelled')),
  provider_inquiry_ref text check (
    provider_inquiry_ref is null or char_length(provider_inquiry_ref) between 1 and 255
  ),
  hosted_url_ciphertext bytea,
  hosted_url_hash bytea check (hosted_url_hash is null or octet_length(hosted_url_hash) = 32),
  encryption_key_id text check (
    encryption_key_id is null or encryption_key_id ~ '^[A-Za-z0-9._-]{1,64}$'
  ),
  attempts integer not null default 0 check (attempts between 0 and 100),
  claimed_by text check (claimed_by is null or char_length(claimed_by) between 1 and 128),
  claim_expires_at timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error text check (last_error is null or char_length(last_error) between 1 and 1000),
  requested_at timestamptz not null default clock_timestamp(),
  ready_at timestamptz,
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (subject_account_id, idempotency_key),
  check ((state = 'creating') = (claimed_by is not null)),
  check ((state = 'creating') = (claim_expires_at is not null)),
  check (
    state <> 'ready' or (
      provider_inquiry_ref is not null and hosted_url_ciphertext is not null and
      hosted_url_hash is not null and encryption_key_id is not null and ready_at is not null
    )
  ),
  check ((state = 'completed') = (completed_at is not null)),
  check (expires_at > requested_at),
  check (hosted_url_ciphertext is null or octet_length(hosted_url_ciphertext) between 32 and 65536)
);

create unique index compliance_verification_provider_ref_unique
  on money.compliance_verification_sessions(provider, provider_inquiry_ref)
  where provider_inquiry_ref is not null;
create unique index compliance_verification_one_active_subject
  on money.compliance_verification_sessions(subject_account_id)
  where state in ('requested', 'creating', 'ready');
create index compliance_verification_claim_idx
  on money.compliance_verification_sessions(next_attempt_at, requested_at, id)
  where state in ('requested', 'creating');
create index compliance_verification_expiry_idx
  on money.compliance_verification_sessions(expires_at, id)
  where state in ('requested', 'creating', 'ready');

create table money.compliance_operators (
  id text primary key check (id ~ '^cop_[A-Za-z0-9_-]{8,64}$'),
  name text not null check (char_length(name) between 1 and 160),
  handle text not null unique check (handle ~ '^[a-z0-9][a-z0-9_-]{1,31}$'),
  public_key text not null unique check (char_length(public_key) between 32 and 2048),
  role text not null check (role in ('analyst', 'supervisor', 'administrator')),
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table money.compliance_operator_nonces (
  operator_id text not null references money.compliance_operators(id) on delete restrict,
  nonce text not null check (char_length(nonce) between 8 and 200),
  request_hash bytea not null check (octet_length(request_hash) = 32),
  signed_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (operator_id, nonce),
  check (expires_at > signed_at)
);
create index compliance_operator_nonces_expiry_idx
  on money.compliance_operator_nonces(expires_at);

create table money.compliance_operator_sessions (
  token_hash bytea primary key check (octet_length(token_hash) = 32),
  operator_id text not null references money.compliance_operators(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  last_used_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index compliance_operator_sessions_active_idx
  on money.compliance_operator_sessions(operator_id, expires_at desc)
  where revoked_at is null;

create table money.compliance_operator_events (
  id bigint generated always as identity primary key,
  operator_id text references money.compliance_operators(id) on delete restrict,
  action text not null check (action ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  entity_kind text not null check (entity_kind ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  entity_id text not null check (char_length(entity_id) between 1 and 255),
  idempotency_key text check (
    idempotency_key is null or char_length(idempotency_key) between 8 and 200
  ),
  review_reference text not null check (char_length(review_reference) between 3 and 255),
  reason text not null check (char_length(reason) between 1 and 2000),
  database_actor text not null check (char_length(database_actor) between 1 and 255),
  created_at timestamptz not null default clock_timestamp()
);
create unique index compliance_operator_events_idempotency_unique
  on money.compliance_operator_events(operator_id, idempotency_key)
  where idempotency_key is not null;
create index compliance_operator_events_entity_idx
  on money.compliance_operator_events(entity_kind, entity_id, id desc);
create trigger compliance_operator_events_append_only
before update or delete on money.compliance_operator_events
for each row execute function money_private.forbid_immutable_mutation();

create table money.compliance_action_requests (
  id uuid primary key default public.gen_random_uuid(),
  action_type text not null
    check (action_type in (
      'subject_approval', 'restriction_release', 'case_resolution', 'risk_limit_change'
    )),
  target_id text not null check (char_length(target_id) between 1 and 255),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 16384),
  state text not null default 'pending'
    check (state in ('pending', 'executed', 'rejected', 'expired', 'cancelled')),
  requested_by text not null references money.compliance_operators(id) on delete restrict,
  approved_by text references money.compliance_operators(id) on delete restrict,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  review_reference text not null check (char_length(review_reference) between 3 and 255),
  reason text not null check (char_length(reason) between 1 and 2000),
  checker_reference text check (
    checker_reference is null or char_length(checker_reference) between 3 and 255
  ),
  checker_reason text check (checker_reason is null or char_length(checker_reason) between 1 and 2000),
  requested_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  decided_at timestamptz,
  executed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (requested_by, idempotency_key),
  check (approved_by is null or approved_by <> requested_by),
  check (expires_at > requested_at),
  check ((state = 'pending') = (decided_at is null)),
  check ((state = 'executed') = (executed_at is not null)),
  check ((state in ('executed', 'rejected')) = (approved_by is not null)),
  check ((approved_by is null) = (checker_reference is null)),
  check ((approved_by is null) = (checker_reason is null))
);
create index compliance_action_requests_pending_idx
  on money.compliance_action_requests(expires_at, requested_at, id)
  where state = 'pending';
create index compliance_action_requests_target_idx
  on money.compliance_action_requests(action_type, target_id, requested_at desc, id desc);

create or replace function money_private.request_compliance_verification_session(
  p_requester_id text,
  p_provider text,
  p_idempotency_key text
)
returns table (
  id uuid, subject_account_id text, provider text, state text,
  replayed boolean, expires_at timestamptz, updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject money.compliance_subjects%rowtype;
  v_session money.compliance_verification_sessions%rowtype;
begin
  if p_provider !~ '^[a-z][a-z0-9_.-]{1,63}$' or
     p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception 'invalid compliance verification request' using errcode = '22023';
  end if;
  if p_requester_id is null or money_private.compliance_subject_id(p_requester_id) <> p_requester_id then
    raise exception 'verification sessions require their owning user' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_requester_id, 9_120_001));
  select * into v_subject from money.compliance_subjects
  where account_id = p_requester_id for update;
  if v_subject.account_id is null or v_subject.country_code is null or
     v_subject.state not in ('pending', 'review', 'unverified') then
    raise exception 'subject is not eligible for a verification session' using errcode = '42501';
  end if;

  update money.compliance_verification_sessions s set
    state = 'expired', claimed_by = null, claim_expires_at = null,
    last_error = null, updated_at = clock_timestamp()
  where s.subject_account_id = p_requester_id
    and s.state in ('requested', 'creating', 'ready')
    and s.expires_at <= clock_timestamp();

  select * into v_session from money.compliance_verification_sessions s
  where s.subject_account_id = p_requester_id and s.idempotency_key = p_idempotency_key;
  if v_session.id is not null then
    return query select v_session.id, v_session.subject_account_id, v_session.provider,
      v_session.state, true, v_session.expires_at, v_session.updated_at;
    return;
  end if;

  select * into v_session from money.compliance_verification_sessions s
  where s.subject_account_id = p_requester_id
    and s.state in ('requested', 'creating', 'ready') for update;
  if v_session.id is not null then
    return query select v_session.id, v_session.subject_account_id, v_session.provider,
      v_session.state, true, v_session.expires_at, v_session.updated_at;
    return;
  end if;

  insert into money.compliance_verification_sessions(
    subject_account_id, provider, idempotency_key
  ) values (p_requester_id, p_provider, p_idempotency_key)
  returning * into v_session;
  return query select v_session.id, v_session.subject_account_id, v_session.provider,
    v_session.state, false, v_session.expires_at, v_session.updated_at;
end;
$$;
revoke all on function money_private.request_compliance_verification_session(text,text,text) from public;

create or replace function money_private.compliance_verification_session_state(
  p_requester_id text,
  p_session_id uuid
)
returns table (
  id uuid, subject_account_id text, provider text, state text,
  hosted_url_ciphertext bytea, hosted_url_hash bytea, encryption_key_id text,
  expires_at timestamptz, updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.subject_account_id, s.provider,
    case when s.state in ('requested', 'creating', 'ready') and s.expires_at <= clock_timestamp()
      then 'expired' else s.state end,
    case when s.state = 'ready' and s.expires_at > clock_timestamp() then s.hosted_url_ciphertext end,
    case when s.state = 'ready' and s.expires_at > clock_timestamp() then s.hosted_url_hash end,
    case when s.state = 'ready' and s.expires_at > clock_timestamp() then s.encryption_key_id end,
    s.expires_at, s.updated_at
  from money.compliance_verification_sessions s
  where s.id = p_session_id and s.subject_account_id = p_requester_id
    and money_private.compliance_subject_id(p_requester_id) = p_requester_id
$$;
revoke all on function money_private.compliance_verification_session_state(text,uuid) from public;

create or replace function money_private.claim_compliance_verification_sessions(
  p_worker_id text,
  p_limit integer
)
returns table (
  id uuid, subject_account_id text, subject_type text, country_code text,
  provider text, attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 128 or
     p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid compliance verification claim' using errcode = '22023';
  end if;
  return query
    with candidates as (
      select s.id from money.compliance_verification_sessions s
      where s.expires_at > clock_timestamp()
        and s.next_attempt_at <= clock_timestamp()
        and (s.state = 'requested' or
          (s.state = 'creating' and s.claim_expires_at <= clock_timestamp()))
      order by s.next_attempt_at, s.requested_at, s.id
      for update skip locked limit p_limit
    ), claimed as (
      update money.compliance_verification_sessions s set
        state = 'creating', attempts = s.attempts + 1,
        claimed_by = p_worker_id, claim_expires_at = clock_timestamp() + interval '2 minutes',
        last_error = null, updated_at = clock_timestamp()
      from candidates c where s.id = c.id
      returning s.*
    )
    select c.id, c.subject_account_id, sub.subject_type, sub.country_code,
      c.provider, c.attempts
    from claimed c join money.compliance_subjects sub on sub.account_id = c.subject_account_id
    order by c.requested_at, c.id;
end;
$$;
revoke all on function money_private.claim_compliance_verification_sessions(text,integer) from public;

create or replace function money_private.complete_compliance_verification_session(
  p_worker_id text,
  p_session_id uuid,
  p_provider_inquiry_ref text,
  p_hosted_url_ciphertext bytea,
  p_hosted_url_hash bytea,
  p_encryption_key_id text,
  p_expires_at timestamptz
)
returns money.compliance_verification_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session money.compliance_verification_sessions%rowtype;
begin
  if p_provider_inquiry_ref is null or char_length(p_provider_inquiry_ref) not between 1 and 255 or
     p_hosted_url_ciphertext is null or octet_length(p_hosted_url_ciphertext) not between 32 and 65536 or
     p_hosted_url_hash is null or octet_length(p_hosted_url_hash) <> 32 or
     p_encryption_key_id !~ '^[A-Za-z0-9._-]{1,64}$' or
     p_expires_at is null or p_expires_at <= clock_timestamp() or
     p_expires_at > clock_timestamp() + interval '7 days' then
    raise exception 'invalid hosted verification result' using errcode = '22023';
  end if;
  update money.compliance_verification_sessions s set
    state = 'ready', provider_inquiry_ref = p_provider_inquiry_ref,
    hosted_url_ciphertext = p_hosted_url_ciphertext,
    hosted_url_hash = p_hosted_url_hash, encryption_key_id = p_encryption_key_id,
    ready_at = clock_timestamp(), expires_at = p_expires_at,
    claimed_by = null, claim_expires_at = null, last_error = null,
    updated_at = clock_timestamp()
  where s.id = p_session_id and s.state = 'creating' and s.claimed_by = p_worker_id
  returning * into v_session;
  if v_session.id is null then
    raise exception 'compliance verification worker does not own this session' using errcode = '42501';
  end if;
  return v_session;
end;
$$;
revoke all on function money_private.complete_compliance_verification_session(text,uuid,text,bytea,bytea,text,timestamptz) from public;

create or replace function money_private.fail_compliance_verification_session(
  p_worker_id text,
  p_session_id uuid,
  p_error text,
  p_retry_seconds integer,
  p_dead boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  if p_error is null or char_length(p_error) not between 1 and 1000 or
     p_retry_seconds is null or p_retry_seconds not between 1 and 86400 then
    raise exception 'invalid compliance verification failure' using errcode = '22023';
  end if;
  update money.compliance_verification_sessions s set
    state = case when p_dead or s.attempts >= 25 then 'failed' else 'requested' end,
    next_attempt_at = case when p_dead or s.attempts >= 25 then s.next_attempt_at
      else clock_timestamp() + make_interval(secs => p_retry_seconds) end,
    last_error = p_error, claimed_by = null, claim_expires_at = null,
    updated_at = clock_timestamp()
  where s.id = p_session_id and s.state = 'creating' and s.claimed_by = p_worker_id
  returning state into v_state;
  if v_state is null then
    raise exception 'compliance verification worker does not own this session' using errcode = '42501';
  end if;
  return v_state;
end;
$$;
revoke all on function money_private.fail_compliance_verification_session(text,uuid,text,integer,boolean) from public;

create or replace function money_private.expire_compliance_verification_sessions(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'invalid verification expiry limit' using errcode = '22023';
  end if;
  with candidates as (
    select s.id from money.compliance_verification_sessions s
    where s.state in ('requested', 'creating', 'ready') and s.expires_at <= clock_timestamp()
    order by s.expires_at, s.id for update skip locked limit p_limit
  )
  update money.compliance_verification_sessions s set
    state = 'expired', claimed_by = null, claim_expires_at = null,
    last_error = null, updated_at = clock_timestamp()
  from candidates c where s.id = c.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function money_private.expire_compliance_verification_sessions(integer) from public;

create or replace function money_private.compliance_operator_role_rank(p_role text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_role when 'analyst' then 1 when 'supervisor' then 2
    when 'administrator' then 3 else 0 end
$$;

create or replace function money_private.register_compliance_operator(
  p_id text,
  p_name text,
  p_handle text,
  p_public_key text,
  p_role text,
  p_review_reference text,
  p_reason text
)
returns money.compliance_operators
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator money.compliance_operators%rowtype;
begin
  if p_id !~ '^cop_[A-Za-z0-9_-]{8,64}$' or
     p_name is null or char_length(p_name) not between 1 and 160 or
     p_handle !~ '^[a-z0-9][a-z0-9_-]{1,31}$' or
     p_public_key is null or char_length(p_public_key) not between 32 and 2048 or
     p_role not in ('analyst', 'supervisor', 'administrator') or
     p_review_reference is null or char_length(p_review_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 2000 then
    raise exception 'invalid compliance operator' using errcode = '22023';
  end if;
  insert into money.compliance_operators(id, name, handle, public_key, role)
  values (p_id, p_name, p_handle, p_public_key, p_role)
  on conflict (id) do nothing;
  select * into v_operator from money.compliance_operators where id = p_id;
  if v_operator.name <> p_name or v_operator.handle <> p_handle or
     v_operator.public_key <> p_public_key or v_operator.role <> p_role then
    raise exception 'compliance operator idempotency conflict' using errcode = '22023';
  end if;
  if not exists (
    select 1 from money.compliance_operator_events e
    where e.operator_id = p_id and e.action = 'operator.registered'
  ) then
    insert into money.compliance_operator_events(
      operator_id, action, entity_kind, entity_id,
      review_reference, reason, database_actor
    ) values (
      p_id, 'operator.registered', 'operator', p_id,
      p_review_reference, p_reason, session_user
    );
  end if;
  return v_operator;
end;
$$;
revoke all on function money_private.register_compliance_operator(text,text,text,text,text,text,text) from public;

create or replace function money_private.set_compliance_operator_status(
  p_operator_id text,
  p_status text,
  p_review_reference text,
  p_reason text
)
returns money.compliance_operators
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator money.compliance_operators%rowtype;
begin
  if p_status not in ('active', 'suspended', 'closed') or
     p_review_reference is null or char_length(p_review_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 2000 then
    raise exception 'invalid compliance operator status' using errcode = '22023';
  end if;
  update money.compliance_operators set status = p_status,
    updated_at = clock_timestamp()
  where id = p_operator_id returning * into v_operator;
  if v_operator.id is null then raise exception 'compliance operator not found' using errcode = 'P0002'; end if;
  if p_status <> 'active' then
    update money.compliance_operator_sessions set revoked_at = clock_timestamp()
    where operator_id = p_operator_id and revoked_at is null;
  end if;
  insert into money.compliance_operator_events(
    operator_id, action, entity_kind, entity_id,
    review_reference, reason, database_actor
  ) values (
    p_operator_id, 'operator.' || p_status, 'operator', p_operator_id,
    p_review_reference, p_reason, session_user
  );
  return v_operator;
end;
$$;
revoke all on function money_private.set_compliance_operator_status(text,text,text,text) from public;

create or replace function money_private.compliance_operator_identity(p_operator_id text)
returns table (id text, name text, handle text, public_key text, role text, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.name, o.handle, o.public_key, o.role, o.status
  from money.compliance_operators o where o.id = p_operator_id
$$;
revoke all on function money_private.compliance_operator_identity(text) from public;

create or replace function money_private.consume_compliance_operator_request(
  p_operator_id text,
  p_expected_public_key text,
  p_nonce text,
  p_signed_at_ms bigint,
  p_request_hash bytea
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator money.compliance_operators%rowtype;
  v_signed_at timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if p_nonce is null or char_length(p_nonce) not between 8 and 200 or
     p_request_hash is null or octet_length(p_request_hash) <> 32 then
    raise exception 'invalid operator signed request' using errcode = '22023';
  end if;
  v_signed_at := to_timestamp(p_signed_at_ms::numeric / 1000);
  if v_signed_at < v_now - interval '2 minutes' or v_signed_at > v_now + interval '30 seconds' then
    raise exception 'operator signature timestamp is outside the accepted window' using errcode = '28000';
  end if;
  select * into v_operator from money.compliance_operators
  where id = p_operator_id and status = 'active' for update;
  if v_operator.id is null or v_operator.public_key <> p_expected_public_key then
    raise exception 'unknown operator or operator key changed' using errcode = '28000';
  end if;
  delete from money.compliance_operator_nonces n where n.expires_at <= v_now;
  begin
    insert into money.compliance_operator_nonces(
      operator_id, nonce, request_hash, signed_at, expires_at
    ) values (
      p_operator_id, p_nonce, p_request_hash, v_signed_at, v_signed_at + interval '2 minutes'
    );
  exception when unique_violation then
    raise exception 'operator signature nonce already used' using errcode = '28000';
  end;
end;
$$;
revoke all on function money_private.consume_compliance_operator_request(text,text,text,bigint,bytea) from public;

create or replace function money_private.create_compliance_operator_session(
  p_operator_id text,
  p_token_hash bytea
)
returns table (expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires_at timestamptz := clock_timestamp() + interval '30 minutes';
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 or not exists (
    select 1 from money.compliance_operators o
    where o.id = p_operator_id and o.status = 'active'
  ) then
    raise exception 'invalid compliance operator session' using errcode = '42501';
  end if;
  update money.compliance_operator_sessions s set revoked_at = clock_timestamp()
  where s.operator_id = p_operator_id and s.revoked_at is null and s.expires_at <= clock_timestamp();
  if (select count(*) from money.compliance_operator_sessions s
      where s.operator_id = p_operator_id and s.revoked_at is null and s.expires_at > clock_timestamp()) >= 5 then
    update money.compliance_operator_sessions s set revoked_at = clock_timestamp()
    where s.token_hash = (
      select old.token_hash from money.compliance_operator_sessions old
      where old.operator_id = p_operator_id and old.revoked_at is null and old.expires_at > clock_timestamp()
      order by old.created_at, old.token_hash limit 1
    );
  end if;
  insert into money.compliance_operator_sessions(token_hash, operator_id, expires_at)
  values (p_token_hash, p_operator_id, v_expires_at);
  return query select v_expires_at;
end;
$$;
revoke all on function money_private.create_compliance_operator_session(text,bytea) from public;

create or replace function money_private.compliance_operator_for_session(p_token_hash bytea)
returns money.compliance_operators
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator money.compliance_operators%rowtype;
begin
  if p_token_hash is null or octet_length(p_token_hash) <> 32 then return null; end if;
  select o.* into v_operator
  from money.compliance_operator_sessions s
  join money.compliance_operators o on o.id = s.operator_id
  where s.token_hash = p_token_hash and s.revoked_at is null
    and s.expires_at > clock_timestamp() and o.status = 'active';
  if v_operator.id is not null then
    update money.compliance_operator_sessions set last_used_at = clock_timestamp()
    where token_hash = p_token_hash;
  end if;
  return v_operator;
end;
$$;
revoke all on function money_private.compliance_operator_for_session(bytea) from public;

create or replace function money_private.resolve_compliance_operator_session(p_token_hash bytea)
returns table (id text, name text, handle text, role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator money.compliance_operators%rowtype;
begin
  v_operator := money_private.compliance_operator_for_session(p_token_hash);
  if v_operator.id is null then return; end if;
  return query select v_operator.id, v_operator.name, v_operator.handle, v_operator.role;
end;
$$;
revoke all on function money_private.resolve_compliance_operator_session(bytea) from public;

create or replace function money_private.revoke_compliance_operator_session(p_token_hash bytea)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update money.compliance_operator_sessions s set revoked_at = clock_timestamp()
  where s.token_hash = p_token_hash and s.revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;
revoke all on function money_private.revoke_compliance_operator_session(bytea) from public;

create or replace function money_private.list_compliance_cases_for_operator(
  p_token_hash bytea,
  p_limit integer
)
returns setof money.compliance_cases
language plpgsql
security definer
set search_path = ''
as $$
declare v_operator money.compliance_operators%rowtype;
begin
  v_operator := money_private.compliance_operator_for_session(p_token_hash);
  if v_operator.id is null then raise exception 'operator session is invalid' using errcode = '28000'; end if;
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid case limit' using errcode = '22023'; end if;
  return query select * from money.compliance_cases c
    order by (c.status in ('open','in_review','escalated','restricted')) desc,
      case c.severity when 'critical' then 4 when 'high' then 3 when 'medium' then 2 else 1 end desc,
      c.due_at nulls last, c.created_at desc, c.id desc limit p_limit;
end;
$$;
revoke all on function money_private.list_compliance_cases_for_operator(bytea,integer) from public;

create or replace function money_private.list_compliance_subjects_for_operator(
  p_token_hash bytea,
  p_limit integer
)
returns setof money.compliance_subjects
language plpgsql
security definer
set search_path = ''
as $$
declare v_operator money.compliance_operators%rowtype;
begin
  v_operator := money_private.compliance_operator_for_session(p_token_hash);
  if v_operator.id is null then raise exception 'operator session is invalid' using errcode = '28000'; end if;
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid subject limit' using errcode = '22023'; end if;
  return query select * from money.compliance_subjects s
    order by (s.state in ('review','restricted','rejected')) desc,
      s.updated_at desc, s.account_id limit p_limit;
end;
$$;
revoke all on function money_private.list_compliance_subjects_for_operator(bytea,integer) from public;

create or replace function money_private.list_compliance_restrictions_for_operator(
  p_token_hash bytea,
  p_limit integer
)
returns setof money.compliance_restrictions
language plpgsql
security definer
set search_path = ''
as $$
declare v_operator money.compliance_operators%rowtype;
begin
  v_operator := money_private.compliance_operator_for_session(p_token_hash);
  if v_operator.id is null then raise exception 'operator session is invalid' using errcode = '28000'; end if;
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid restriction limit' using errcode = '22023'; end if;
  return query select * from money.compliance_restrictions r
    order by (r.released_at is null) desc, r.restricted_at desc, r.id desc limit p_limit;
end;
$$;
revoke all on function money_private.list_compliance_restrictions_for_operator(bytea,integer) from public;

create or replace function money_private.list_compliance_action_requests_for_operator(
  p_token_hash bytea,
  p_limit integer
)
returns setof money.compliance_action_requests
language plpgsql
security definer
set search_path = ''
as $$
declare v_operator money.compliance_operators%rowtype;
begin
  v_operator := money_private.compliance_operator_for_session(p_token_hash);
  if v_operator.id is null then raise exception 'operator session is invalid' using errcode = '28000'; end if;
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid action limit' using errcode = '22023'; end if;
  update money.compliance_action_requests set state = 'expired', decided_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where state = 'pending' and expires_at <= clock_timestamp();
  return query select * from money.compliance_action_requests a
    order by (a.state = 'pending') desc, a.requested_at desc, a.id desc limit p_limit;
end;
$$;
revoke all on function money_private.list_compliance_action_requests_for_operator(bytea,integer) from public;

create or replace function money_private.list_compliance_case_actions_for_operator(
  p_token_hash bytea,
  p_case_id uuid,
  p_limit integer
)
returns setof money.compliance_case_actions
language plpgsql
security definer
set search_path = ''
as $$
declare v_operator money.compliance_operators%rowtype;
begin
  v_operator := money_private.compliance_operator_for_session(p_token_hash);
  if v_operator.id is null then raise exception 'operator session is invalid' using errcode = '28000'; end if;
  if p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid case action limit' using errcode = '22023'; end if;
  return query select * from money.compliance_case_actions a
    where a.case_id = p_case_id order by a.id desc limit p_limit;
end;
$$;
revoke all on function money_private.list_compliance_case_actions_for_operator(bytea,uuid,integer) from public;

create or replace function money_private.claim_compliance_case_as_operator(
  p_token_hash bytea,
  p_case_id uuid,
  p_idempotency_key text,
  p_review_reference text,
  p_reason text
)
returns money.compliance_cases
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator money.compliance_operators%rowtype;
  v_case money.compliance_cases%rowtype;
  v_event money.compliance_operator_events%rowtype;
begin
  v_operator := money_private.compliance_operator_for_session(p_token_hash);
  if v_operator.id is null then raise exception 'operator session is invalid' using errcode = '28000'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 or
     p_review_reference is null or char_length(p_review_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 2000 then
    raise exception 'invalid case claim' using errcode = '22023';
  end if;
  select * into v_event from money.compliance_operator_events e
  where e.operator_id = v_operator.id and e.idempotency_key = p_idempotency_key;
  if v_event.id is not null then
    if v_event.action <> 'case.claimed' or v_event.entity_id <> p_case_id::text then
      raise exception 'operator idempotency conflict' using errcode = '22023';
    end if;
    select * into v_case from money.compliance_cases where id = p_case_id;
    return v_case;
  end if;
  select * into v_case from money.compliance_cases where id = p_case_id for update;
  if v_case.id is null then raise exception 'compliance case not found' using errcode = 'P0002'; end if;
  if v_case.status in ('closed_no_action','blocked','reported') or
     (v_case.assigned_to is not null and v_case.assigned_to <> v_operator.id) then
    raise exception 'compliance case cannot be claimed' using errcode = '42501';
  end if;
  update money.compliance_cases set assigned_to = v_operator.id,
    status = case when status = 'open' then 'in_review' else status end,
    updated_at = clock_timestamp()
  where id = p_case_id returning * into v_case;
  insert into money.compliance_case_actions(
    case_id, action, reason, review_reference, database_actor
  ) values (p_case_id, 'claimed', p_reason, p_review_reference, 'operator:' || v_operator.id);
  insert into money.compliance_operator_events(
    operator_id, action, entity_kind, entity_id, idempotency_key,
    review_reference, reason, database_actor
  ) values (
    v_operator.id, 'case.claimed', 'case', p_case_id::text, p_idempotency_key,
    p_review_reference, p_reason, session_user
  );
  return v_case;
end;
$$;
revoke all on function money_private.claim_compliance_case_as_operator(bytea,uuid,text,text,text) from public;

create or replace function money_private.add_compliance_case_note_as_operator(
  p_token_hash bytea,
  p_case_id uuid,
  p_idempotency_key text,
  p_review_reference text,
  p_reason text,
  p_evidence_hash bytea
)
returns money.compliance_case_actions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator money.compliance_operators%rowtype;
  v_case money.compliance_cases%rowtype;
  v_action money.compliance_case_actions%rowtype;
  v_event money.compliance_operator_events%rowtype;
begin
  v_operator := money_private.compliance_operator_for_session(p_token_hash);
  if v_operator.id is null then raise exception 'operator session is invalid' using errcode = '28000'; end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 or
     p_review_reference is null or char_length(p_review_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 2000 or
     (p_evidence_hash is not null and octet_length(p_evidence_hash) <> 32) then
    raise exception 'invalid case note' using errcode = '22023';
  end if;
  select * into v_event from money.compliance_operator_events e
  where e.operator_id = v_operator.id and e.idempotency_key = p_idempotency_key;
  if v_event.id is not null then
    if v_event.action <> 'case.noted' or v_event.entity_id <> p_case_id::text then
      raise exception 'operator idempotency conflict' using errcode = '22023';
    end if;
    select * into v_action from money.compliance_case_actions a
    where a.case_id = p_case_id and a.database_actor = 'operator:' || v_operator.id
      and a.review_reference = p_review_reference and a.reason = p_reason
    order by a.id desc limit 1;
    return v_action;
  end if;
  select * into v_case from money.compliance_cases where id = p_case_id for update;
  if v_case.id is null or v_case.status in ('closed_no_action','blocked','reported') then
    raise exception 'compliance case cannot be noted' using errcode = '42501';
  end if;
  insert into money.compliance_case_actions(
    case_id, action, reason, evidence_hash, review_reference, database_actor
  ) values (
    p_case_id, 'note', p_reason, p_evidence_hash, p_review_reference,
    'operator:' || v_operator.id
  ) returning * into v_action;
  update money.compliance_cases set updated_at = clock_timestamp() where id = p_case_id;
  insert into money.compliance_operator_events(
    operator_id, action, entity_kind, entity_id, idempotency_key,
    review_reference, reason, database_actor
  ) values (
    v_operator.id, 'case.noted', 'case', p_case_id::text, p_idempotency_key,
    p_review_reference, p_reason, session_user
  );
  return v_action;
end;
$$;
revoke all on function money_private.add_compliance_case_note_as_operator(bytea,uuid,text,text,text,bytea) from public;

create or replace function money_private.restrict_compliance_subject_as_operator(
  p_token_hash bytea,
  p_subject_account_id text,
  p_case_id uuid,
  p_reason_code text,
  p_idempotency_key text,
  p_review_reference text,
  p_reason text
)
returns money.compliance_restrictions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator money.compliance_operators%rowtype;
  v_case money.compliance_cases%rowtype;
  v_restriction money.compliance_restrictions%rowtype;
  v_event money.compliance_operator_events%rowtype;
begin
  v_operator := money_private.compliance_operator_for_session(p_token_hash);
  if v_operator.id is null then raise exception 'operator session is invalid' using errcode = '28000'; end if;
  if p_reason_code !~ '^[a-z][a-z0-9_.:-]{1,63}$' or
     p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 or
     p_review_reference is null or char_length(p_review_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 1000 then
    raise exception 'invalid operator restriction' using errcode = '22023';
  end if;
  select * into v_event from money.compliance_operator_events e
  where e.operator_id = v_operator.id and e.idempotency_key = p_idempotency_key;
  if v_event.id is not null then
    if v_event.action <> 'subject.restricted' or v_event.entity_id <> p_subject_account_id then
      raise exception 'operator idempotency conflict' using errcode = '22023';
    end if;
    select * into v_restriction from money.compliance_restrictions r
    where r.subject_account_id = p_subject_account_id order by r.restricted_at desc limit 1;
    return v_restriction;
  end if;
  select * into v_case from money.compliance_cases where id = p_case_id for update;
  if v_case.id is null or v_case.subject_account_id <> p_subject_account_id or
     v_case.status in ('closed_no_action','blocked','reported') then
    raise exception 'restriction requires an open case for the subject' using errcode = '42501';
  end if;
  select * into v_restriction from money_private.restrict_compliance_subject(
    p_subject_account_id, p_case_id, p_reason_code, p_reason
  );
  update money.compliance_cases set status = 'restricted', assigned_to = coalesce(assigned_to, v_operator.id),
    updated_at = clock_timestamp() where id = p_case_id;
  insert into money.compliance_case_actions(
    case_id, action, reason, review_reference, database_actor
  ) values (
    p_case_id, 'restricted', p_reason, p_review_reference, 'operator:' || v_operator.id
  );
  insert into money.compliance_operator_events(
    operator_id, action, entity_kind, entity_id, idempotency_key,
    review_reference, reason, database_actor
  ) values (
    v_operator.id, 'subject.restricted', 'subject', p_subject_account_id,
    p_idempotency_key, p_review_reference, p_reason, session_user
  );
  return v_restriction;
end;
$$;
revoke all on function money_private.restrict_compliance_subject_as_operator(bytea,text,uuid,text,text,text,text) from public;

create or replace function money_private.request_compliance_action_as_operator(
  p_token_hash bytea,
  p_action_type text,
  p_target_id text,
  p_payload jsonb,
  p_idempotency_key text,
  p_review_reference text,
  p_reason text
)
returns money.compliance_action_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator money.compliance_operators%rowtype;
  v_request money.compliance_action_requests%rowtype;
  v_next_review timestamptz;
begin
  v_operator := money_private.compliance_operator_for_session(p_token_hash);
  if v_operator.id is null then raise exception 'operator session is invalid' using errcode = '28000'; end if;
  if p_action_type not in ('subject_approval','restriction_release','case_resolution','risk_limit_change') or
     p_target_id is null or char_length(p_target_id) not between 1 and 255 or
     p_payload is null or jsonb_typeof(p_payload) <> 'object' or pg_column_size(p_payload) > 16384 or
     not money_private.compliance_normalized_evidence_safe(p_payload, 0) or
     p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 or
     p_review_reference is null or char_length(p_review_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 2000 then
    raise exception 'invalid reviewed compliance action' using errcode = '22023';
  end if;
  select * into v_request from money.compliance_action_requests a
  where a.requested_by = v_operator.id and a.idempotency_key = p_idempotency_key;
  if v_request.id is not null then
    if v_request.action_type <> p_action_type or v_request.target_id <> p_target_id or
       v_request.payload <> p_payload then
      raise exception 'compliance action idempotency conflict' using errcode = '22023';
    end if;
    return v_request;
  end if;

  if p_action_type = 'subject_approval' then
    if not (p_payload ? 'riskTier') or not (p_payload ? 'nextReviewAt') or
       exists (select 1 from jsonb_object_keys(p_payload) k where k not in ('riskTier','nextReviewAt')) or
       p_payload->>'riskTier' not in ('low','standard','high') then
      raise exception 'invalid subject approval payload' using errcode = '22023';
    end if;
    begin v_next_review := (p_payload->>'nextReviewAt')::timestamptz;
    exception when others then raise exception 'invalid subject approval review date' using errcode = '22023'; end;
    if v_next_review <= clock_timestamp() or not exists (
      select 1 from money.compliance_subjects s where s.account_id = p_target_id
    ) then raise exception 'subject approval target is invalid' using errcode = '42501'; end if;
  elsif p_action_type = 'restriction_release' then
    if p_payload <> '{}'::jsonb or not exists (
      select 1 from money.compliance_restrictions r
      where r.subject_account_id = p_target_id and r.released_at is null
    ) then raise exception 'restriction release target is invalid' using errcode = '42501'; end if;
  elsif p_action_type = 'case_resolution' then
    if not (p_payload ? 'status') or
       exists (select 1 from jsonb_object_keys(p_payload) k where k not in ('status','evidenceHash')) or
       p_payload->>'status' not in ('closed_no_action','blocked','reported') or
       ((p_payload ? 'evidenceHash') and (p_payload->>'evidenceHash') !~ '^[0-9a-fA-F]{64}$') or
       not exists (select 1 from money.compliance_cases c where c.id = p_target_id::uuid) then
      raise exception 'case resolution target is invalid' using errcode = '42501';
    end if;
  else
    if p_target_id not in ('low','standard','high') or
       exists (select 1 from jsonb_object_keys(p_payload) k where k not in (
         'perTransferMicros','dailyCrossUserMicros','dailyExternalMicros',
         'dailyPayoutMicros','rolling30dOutflowMicros'
       )) or
       not (p_payload ?& array[
         'perTransferMicros','dailyCrossUserMicros','dailyExternalMicros',
         'dailyPayoutMicros','rolling30dOutflowMicros'
       ]) or
       (p_payload->>'perTransferMicros') !~ '^[1-9][0-9]{0,18}$' or
       (p_payload->>'dailyCrossUserMicros') !~ '^[1-9][0-9]{0,18}$' or
       (p_payload->>'dailyExternalMicros') !~ '^[1-9][0-9]{0,18}$' or
       (p_payload->>'dailyPayoutMicros') !~ '^[1-9][0-9]{0,18}$' or
       (p_payload->>'rolling30dOutflowMicros') !~ '^[1-9][0-9]{0,18}$' then
      raise exception 'risk limit change payload is invalid' using errcode = '22023';
    end if;
  end if;

  insert into money.compliance_action_requests(
    action_type, target_id, payload, requested_by, idempotency_key,
    review_reference, reason
  ) values (
    p_action_type, p_target_id, p_payload, v_operator.id, p_idempotency_key,
    p_review_reference, p_reason
  ) returning * into v_request;
  insert into money.compliance_operator_events(
    operator_id, action, entity_kind, entity_id, idempotency_key,
    review_reference, reason, database_actor
  ) values (
    v_operator.id, 'action.requested', 'action_request', v_request.id::text,
    p_idempotency_key, p_review_reference, p_reason, session_user
  );
  return v_request;
end;
$$;
revoke all on function money_private.request_compliance_action_as_operator(bytea,text,text,jsonb,text,text,text) from public;

create or replace function money_private.approve_compliance_action_as_operator(
  p_token_hash bytea,
  p_request_id uuid,
  p_review_reference text,
  p_reason text
)
returns money.compliance_action_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator money.compliance_operators%rowtype;
  v_request money.compliance_action_requests%rowtype;
  v_evidence_hash bytea;
begin
  v_operator := money_private.compliance_operator_for_session(p_token_hash);
  if v_operator.id is null or money_private.compliance_operator_role_rank(v_operator.role) < 2 then
    raise exception 'supervisor operator session is required' using errcode = '42501';
  end if;
  if p_review_reference is null or char_length(p_review_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 2000 then
    raise exception 'invalid compliance action approval' using errcode = '22023';
  end if;
  select * into v_request from money.compliance_action_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'compliance action request not found' using errcode = 'P0002'; end if;
  if v_request.state = 'executed' and v_request.approved_by = v_operator.id then return v_request; end if;
  if v_request.state <> 'pending' or v_request.expires_at <= clock_timestamp() or
     v_request.requested_by = v_operator.id then
    raise exception 'compliance action requires a different active checker' using errcode = '42501';
  end if;

  if v_request.action_type = 'subject_approval' then
    perform money_private.approve_compliance_subject(
      v_request.target_id, v_request.payload->>'riskTier',
      (v_request.payload->>'nextReviewAt')::timestamptz,
      p_review_reference, p_reason
    );
  elsif v_request.action_type = 'restriction_release' then
    perform money_private.release_compliance_restriction(
      v_request.target_id, p_review_reference, p_reason
    );
  elsif v_request.action_type = 'case_resolution' then
    v_evidence_hash := case when v_request.payload ? 'evidenceHash'
      then decode(v_request.payload->>'evidenceHash', 'hex') else null end;
    perform money_private.resolve_compliance_case(
      v_request.target_id::uuid, v_request.payload->>'status',
      p_review_reference, p_reason, v_evidence_hash
    );
  else
    perform money_private.configure_risk_limits(
      v_request.target_id,
      (v_request.payload->>'perTransferMicros')::bigint,
      (v_request.payload->>'dailyCrossUserMicros')::bigint,
      (v_request.payload->>'dailyExternalMicros')::bigint,
      (v_request.payload->>'dailyPayoutMicros')::bigint,
      (v_request.payload->>'rolling30dOutflowMicros')::bigint,
      p_review_reference,
      p_reason
    );
  end if;

  update money.compliance_action_requests set
    state = 'executed', approved_by = v_operator.id,
    checker_reference = p_review_reference, checker_reason = p_reason,
    decided_at = clock_timestamp(), executed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = p_request_id returning * into v_request;
  insert into money.compliance_operator_events(
    operator_id, action, entity_kind, entity_id,
    review_reference, reason, database_actor
  ) values (
    v_operator.id, 'action.executed', 'action_request', p_request_id::text,
    p_review_reference, p_reason, session_user
  );
  return v_request;
end;
$$;
revoke all on function money_private.approve_compliance_action_as_operator(bytea,uuid,text,text) from public;

create or replace function money_private.reject_compliance_action_as_operator(
  p_token_hash bytea,
  p_request_id uuid,
  p_review_reference text,
  p_reason text
)
returns money.compliance_action_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operator money.compliance_operators%rowtype;
  v_request money.compliance_action_requests%rowtype;
begin
  v_operator := money_private.compliance_operator_for_session(p_token_hash);
  if v_operator.id is null or money_private.compliance_operator_role_rank(v_operator.role) < 2 then
    raise exception 'supervisor operator session is required' using errcode = '42501';
  end if;
  if p_review_reference is null or char_length(p_review_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 2000 then
    raise exception 'invalid compliance action rejection' using errcode = '22023';
  end if;
  select * into v_request from money.compliance_action_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'compliance action request not found' using errcode = 'P0002'; end if;
  if v_request.state = 'rejected' and v_request.approved_by = v_operator.id then return v_request; end if;
  if v_request.state <> 'pending' or v_request.expires_at <= clock_timestamp() or
     v_request.requested_by = v_operator.id then
    raise exception 'compliance action requires a different active checker' using errcode = '42501';
  end if;
  update money.compliance_action_requests set
    state = 'rejected', approved_by = v_operator.id,
    checker_reference = p_review_reference, checker_reason = p_reason,
    decided_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_request_id returning * into v_request;
  insert into money.compliance_operator_events(
    operator_id, action, entity_kind, entity_id,
    review_reference, reason, database_actor
  ) values (
    v_operator.id, 'action.rejected', 'action_request', p_request_id::text,
    p_review_reference, p_reason, session_user
  );
  return v_request;
end;
$$;
revoke all on function money_private.reject_compliance_action_as_operator(bytea,uuid,text,text) from public;

comment on table money.compliance_verification_sessions is
  'Durable hosted-verification orchestration. Hosted URLs are ciphertext bound to session, subject, provider, and expiry.';
comment on table money.compliance_operators is
  'Named internal reviewers authenticated with Ed25519 keys; private keys never enter the service or database.';
comment on table money.compliance_action_requests is
  'Maker/checker queue for subject approval, restriction release, and terminal case resolution.';
comment on table money.compliance_operator_events is
  'Append-only attribution trail for every operator and maker/checker action.';
