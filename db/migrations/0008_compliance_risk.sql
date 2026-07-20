-- Customer-compliance and transaction-risk perimeter.
--
-- This database intentionally stores normalized decisions, provider object
-- references, and cryptographic evidence hashes rather than identity
-- documents or raw screening payloads. Provider calls happen outside money
-- transactions. Reviewed SECURITY DEFINER commands are the only write path.

create table money.compliance_subjects (
  account_id text primary key references money.accounts(id) on delete restrict,
  subject_type text not null default 'individual'
    check (subject_type in ('individual', 'business')),
  state text not null default 'unverified'
    check (state in ('unverified', 'pending', 'review', 'approved', 'rejected', 'restricted', 'closed')),
  risk_tier text not null default 'standard'
    check (risk_tier in ('low', 'standard', 'high', 'prohibited')),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  provider text check (provider is null or provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_subject_ref text check (
    provider_subject_ref is null or char_length(provider_subject_ref) between 1 and 255
  ),
  verification_version text check (
    verification_version is null or char_length(verification_version) between 1 and 100
  ),
  identity_evidence_hash bytea check (
    identity_evidence_hash is null or octet_length(identity_evidence_hash) = 32
  ),
  identity_verified_at timestamptz,
  identity_expires_at timestamptz,
  beneficial_owners_verified boolean not null default false,
  screening_state text not null default 'pending'
    check (screening_state in ('pending', 'clear', 'review', 'blocked', 'error', 'expired')),
  screening_evidence_hash bytea check (
    screening_evidence_hash is null or octet_length(screening_evidence_hash) = 32
  ),
  last_screened_at timestamptz,
  screening_expires_at timestamptz,
  expected_single_micros bigint not null default 0 check (expected_single_micros >= 0),
  expected_monthly_micros bigint not null default 0 check (expected_monthly_micros >= 0),
  next_review_at timestamptz,
  version bigint not null default 0 check (version >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (identity_expires_at is null or identity_verified_at is not null),
  check (screening_expires_at is null or last_screened_at is not null),
  check (state <> 'approved' or (
    identity_verified_at is not null and identity_expires_at is not null and
    screening_state = 'clear' and last_screened_at is not null and screening_expires_at is not null and
    risk_tier <> 'prohibited'
  ))
);

create unique index compliance_subjects_provider_ref_unique
  on money.compliance_subjects(provider, provider_subject_ref)
  where provider is not null and provider_subject_ref is not null;
create index compliance_subjects_review_idx
  on money.compliance_subjects(state, next_review_at, account_id)
  where state in ('pending', 'review', 'restricted');
create index compliance_subjects_screening_expiry_idx
  on money.compliance_subjects(screening_expires_at, account_id)
  where state = 'approved';

create table money.compliance_evidence (
  id uuid primary key default public.gen_random_uuid(),
  subject_account_id text not null references money.compliance_subjects(account_id) on delete restrict,
  kind text not null check (kind in (
    'identity', 'business', 'beneficial_owner', 'sanctions', 'pep', 'adverse_media'
  )),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_result_ref text not null check (char_length(provider_result_ref) between 1 and 255),
  decision text not null check (decision in ('clear', 'review', 'blocked', 'error')),
  evidence_hash bytea not null check (octet_length(evidence_hash) = 32),
  list_version text check (list_version is null or char_length(list_version) between 1 and 200),
  normalized jsonb not null default '{}'::jsonb check (jsonb_typeof(normalized) = 'object'),
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  database_actor text not null check (char_length(database_actor) between 1 and 255),
  created_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_result_ref),
  check (expires_at > observed_at)
);

create index compliance_evidence_subject_kind_idx
  on money.compliance_evidence(subject_account_id, kind, observed_at desc, id desc);
create index compliance_evidence_expiry_idx
  on money.compliance_evidence(expires_at, subject_account_id);

create table money.compliance_event_inbox (
  id bigint generated always as identity primary key,
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 255),
  provider_result_ref text not null check (char_length(provider_result_ref) between 1 and 255),
  endpoint_id text not null check (char_length(endpoint_id) between 1 and 255),
  delivery_hash bytea not null check (octet_length(delivery_hash) = 32),
  state text not null default 'queued'
    check (state in ('queued', 'processing', 'completed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  locked_by text,
  locked_at timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error text,
  evidence_id uuid references money.compliance_evidence(id) on delete restrict,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_event_id),
  check ((state = 'processing') = (locked_by is not null)),
  check ((state = 'processing') = (locked_at is not null)),
  check ((state = 'completed') = (completed_at is not null)),
  check (state = 'completed' or evidence_id is null)
);

create index compliance_event_inbox_ready_idx
  on money.compliance_event_inbox(next_attempt_at, id)
  where state = 'queued';
create index compliance_event_inbox_stale_idx
  on money.compliance_event_inbox(locked_at, id)
  where state = 'processing';
create index compliance_event_inbox_dead_idx
  on money.compliance_event_inbox(updated_at desc, id desc)
  where state = 'dead';

create table money.compliance_counterparties (
  id uuid primary key default public.gen_random_uuid(),
  kind text not null check (kind in ('wallet', 'bank_destination', 'merchant', 'domain')),
  canonical_ref_hash bytea not null unique check (octet_length(canonical_ref_hash) = 32),
  label text not null check (char_length(label) between 1 and 200),
  provider text check (provider is null or provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_ref text check (provider_ref is null or char_length(provider_ref) between 1 and 255),
  state text not null default 'pending'
    check (state in ('pending', 'clear', 'review', 'blocked', 'error', 'expired')),
  evidence_hash bytea check (evidence_hash is null or octet_length(evidence_hash) = 32),
  list_version text check (list_version is null or char_length(list_version) between 1 and 200),
  screened_at timestamptz,
  expires_at timestamptz,
  version bigint not null default 0 check (version >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (expires_at is null or screened_at is not null),
  check (state <> 'clear' or (
    evidence_hash is not null and screened_at is not null and expires_at is not null
  ))
);

create unique index compliance_counterparties_provider_ref_unique
  on money.compliance_counterparties(provider, provider_ref)
  where provider is not null and provider_ref is not null;
create index compliance_counterparties_expiry_idx
  on money.compliance_counterparties(expires_at, id)
  where state = 'clear';

alter table money.treasury_destinations
  add column compliance_counterparty_id uuid references money.compliance_counterparties(id) on delete restrict;
create index treasury_destinations_compliance_counterparty_idx
  on money.treasury_destinations(compliance_counterparty_id)
  where compliance_counterparty_id is not null;

create table money.compliance_cases (
  id uuid primary key default public.gen_random_uuid(),
  subject_account_id text references money.compliance_subjects(account_id) on delete restrict,
  counterparty_id uuid references money.compliance_counterparties(id) on delete restrict,
  transfer_seq bigint references money.transfers(seq) on delete restrict,
  kind text not null check (kind in (
    'verification', 'sanctions', 'transaction_monitoring', 'fraud',
    'complaint', 'regulatory_request', 'other'
  )),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  status text not null default 'open'
    check (status in ('open', 'in_review', 'escalated', 'closed_no_action', 'restricted', 'blocked', 'reported')),
  alert_code text not null check (alert_code ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  summary text not null check (char_length(summary) between 1 and 1000),
  assigned_to text check (assigned_to is null or char_length(assigned_to) between 1 and 255),
  due_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (subject_account_id is not null or counterparty_id is not null or transfer_seq is not null),
  check ((status in ('closed_no_action', 'blocked', 'reported')) = (closed_at is not null))
);

create index compliance_cases_open_idx
  on money.compliance_cases(severity desc, due_at, created_at, id)
  where status in ('open', 'in_review', 'escalated', 'restricted');
create index compliance_cases_subject_idx
  on money.compliance_cases(subject_account_id, created_at desc, id desc)
  where subject_account_id is not null;

create table money.compliance_case_actions (
  id bigint generated always as identity primary key,
  case_id uuid not null references money.compliance_cases(id) on delete restrict,
  action text not null check (action ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  reason text not null check (char_length(reason) between 1 and 2000),
  evidence_hash bytea check (evidence_hash is null or octet_length(evidence_hash) = 32),
  review_reference text not null check (char_length(review_reference) between 3 and 255),
  database_actor text not null check (char_length(database_actor) between 1 and 255),
  created_at timestamptz not null default clock_timestamp()
);

create index compliance_case_actions_case_idx
  on money.compliance_case_actions(case_id, id desc);

create table money.compliance_restrictions (
  id uuid primary key default public.gen_random_uuid(),
  subject_account_id text not null references money.compliance_subjects(account_id) on delete restrict,
  case_id uuid references money.compliance_cases(id) on delete restrict,
  reason_code text not null check (reason_code ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  reason text not null check (char_length(reason) between 1 and 1000),
  database_actor text not null check (char_length(database_actor) between 1 and 255),
  restricted_at timestamptz not null default clock_timestamp(),
  released_at timestamptz,
  release_reference text check (
    release_reference is null or char_length(release_reference) between 3 and 255
  ),
  release_reason text check (release_reason is null or char_length(release_reason) between 1 and 1000),
  released_by text check (released_by is null or char_length(released_by) between 1 and 255),
  check ((released_at is null) = (release_reference is null)),
  check ((released_at is null) = (release_reason is null)),
  check ((released_at is null) = (released_by is null))
);

create unique index compliance_restrictions_active_unique
  on money.compliance_restrictions(subject_account_id)
  where released_at is null;
create index compliance_restrictions_case_idx
  on money.compliance_restrictions(case_id)
  where case_id is not null;

create table money.compliance_subject_events (
  id bigint generated always as identity primary key,
  subject_account_id text not null references money.compliance_subjects(account_id) on delete restrict,
  prior_state text,
  new_state text not null check (new_state in (
    'unverified', 'pending', 'review', 'approved', 'rejected', 'restricted', 'closed'
  )),
  reason text not null check (char_length(reason) between 1 and 1000),
  review_reference text check (
    review_reference is null or char_length(review_reference) between 3 and 255
  ),
  database_actor text not null check (char_length(database_actor) between 1 and 255),
  created_at timestamptz not null default clock_timestamp()
);

create index compliance_subject_events_subject_idx
  on money.compliance_subject_events(subject_account_id, id desc);

create table money.risk_limits (
  risk_tier text primary key check (risk_tier in ('low', 'standard', 'high')),
  per_transfer_micros bigint not null check (per_transfer_micros > 0),
  daily_cross_user_micros bigint not null check (daily_cross_user_micros > 0),
  daily_external_micros bigint not null check (daily_external_micros > 0),
  daily_payout_micros bigint not null check (daily_payout_micros > 0),
  rolling_30d_outflow_micros bigint not null check (rolling_30d_outflow_micros > 0),
  updated_at timestamptz not null default clock_timestamp()
);

insert into money.risk_limits(
  risk_tier, per_transfer_micros, daily_cross_user_micros,
  daily_external_micros, daily_payout_micros, rolling_30d_outflow_micros
) values
  ('low',      25000000000, 100000000000, 50000000000, 100000000000, 500000000000),
  ('standard', 10000000000,  25000000000, 10000000000,  25000000000, 100000000000),
  ('high',      1000000000,   2500000000,  1000000000,   2500000000,  10000000000);

create table money.risk_limit_events (
  id bigint generated always as identity primary key,
  risk_tier text not null check (risk_tier in ('low', 'standard', 'high')),
  per_transfer_micros bigint not null check (per_transfer_micros > 0),
  daily_cross_user_micros bigint not null check (daily_cross_user_micros > 0),
  daily_external_micros bigint not null check (daily_external_micros > 0),
  daily_payout_micros bigint not null check (daily_payout_micros > 0),
  rolling_30d_outflow_micros bigint not null check (rolling_30d_outflow_micros > 0),
  review_reference text not null check (char_length(review_reference) between 3 and 255),
  reason text not null check (char_length(reason) between 1 and 1000),
  database_actor text not null check (char_length(database_actor) between 1 and 255),
  created_at timestamptz not null default clock_timestamp()
);

create table money.risk_velocity_buckets (
  subject_account_id text not null references money.compliance_subjects(account_id) on delete restrict,
  bucket_day date not null,
  category text not null check (category in ('cross_user', 'external', 'payout', 'all_outflow')),
  amount_micros bigint not null default 0 check (amount_micros >= 0),
  transfer_count bigint not null default 0 check (transfer_count >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (subject_account_id, bucket_day, category)
);

create index risk_velocity_subject_category_idx
  on money.risk_velocity_buckets(subject_account_id, category, bucket_day desc);

create table money.risk_decisions (
  id uuid primary key default public.gen_random_uuid(),
  actor_id text not null references money.accounts(id) on delete restrict,
  operation text not null check (operation ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 128),
  request_hash bytea not null check (octet_length(request_hash) = 32),
  from_account_id text not null references money.accounts(id) on delete restrict,
  to_account_id text not null references money.accounts(id) on delete restrict,
  source_subject_id text references money.compliance_subjects(account_id) on delete restrict,
  destination_subject_id text references money.compliance_subjects(account_id) on delete restrict,
  counterparty_id uuid references money.compliance_counterparties(id) on delete restrict,
  asset_code text not null references money.assets(code),
  amount_micros bigint not null check (amount_micros > 0),
  risk_tier text check (risk_tier is null or risk_tier in ('low', 'standard', 'high', 'prohibited')),
  outcome text not null check (outcome in ('allow', 'deny', 'review')),
  rule_codes text[] not null default '{}'::text[],
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default clock_timestamp(),
  unique (actor_id, operation, idempotency_key),
  check (cardinality(rule_codes) between 1 and 20)
);

create index risk_decisions_subject_created_idx
  on money.risk_decisions(source_subject_id, created_at desc, id desc)
  where source_subject_id is not null;
create index risk_decisions_denied_idx
  on money.risk_decisions(created_at desc, id desc)
  where outcome <> 'allow';

alter table money.compliance_cases
  add column risk_decision_id uuid references money.risk_decisions(id) on delete restrict;
create index compliance_cases_risk_decision_idx
  on money.compliance_cases(risk_decision_id)
  where risk_decision_id is not null;

create table money.risk_transfer_links (
  decision_id uuid primary key references money.risk_decisions(id) on delete restrict,
  transfer_seq bigint not null unique references money.transfers(seq) on delete restrict,
  created_at timestamptz not null default clock_timestamp()
);

create or replace function money_private.assert_compliance_subject_account()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from money.accounts where id = new.account_id and kind = 'user'
  ) then
    raise exception 'compliance subjects must be user accounts' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger compliance_subject_account_kind
before insert or update of account_id on money.compliance_subjects
for each row execute function money_private.assert_compliance_subject_account();

revoke all on function money_private.assert_compliance_subject_account() from public;

create or replace function money_private.initialize_compliance_subject()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'user' then
    insert into money.compliance_subjects(account_id) values (new.id)
    on conflict (account_id) do nothing;
    insert into money.compliance_subject_events(
      subject_account_id, prior_state, new_state, reason, database_actor
    ) values (new.id, null, 'unverified', 'customer compliance profile initialized', session_user);
  end if;
  return new;
end;
$$;

create trigger accounts_initialize_compliance_subject
after insert on money.accounts
for each row execute function money_private.initialize_compliance_subject();

revoke all on function money_private.initialize_compliance_subject() from public;

insert into money.compliance_subjects(account_id)
select id from money.accounts where kind = 'user'
on conflict (account_id) do nothing;

insert into money.compliance_subject_events(
  subject_account_id, prior_state, new_state, reason, database_actor
)
select s.account_id, null, s.state, 'existing customer compliance profile initialized', session_user
from money.compliance_subjects s
where not exists (
  select 1 from money.compliance_subject_events e where e.subject_account_id = s.account_id
);

create trigger compliance_evidence_append_only
before update or delete on money.compliance_evidence
for each row execute function money_private.forbid_immutable_mutation();
create trigger compliance_case_actions_append_only
before update or delete on money.compliance_case_actions
for each row execute function money_private.forbid_immutable_mutation();
create trigger compliance_subject_events_append_only
before update or delete on money.compliance_subject_events
for each row execute function money_private.forbid_immutable_mutation();
create trigger risk_decisions_append_only
before update or delete on money.risk_decisions
for each row execute function money_private.forbid_immutable_mutation();
create trigger risk_transfer_links_append_only
before update or delete on money.risk_transfer_links
for each row execute function money_private.forbid_immutable_mutation();
create trigger risk_limit_events_append_only
before update or delete on money.risk_limit_events
for each row execute function money_private.forbid_immutable_mutation();

create or replace function money_private.compliance_subject_id(p_account_id text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case a.kind
    when 'user' then a.id
    when 'agent' then a.owner_id
    when 'provider' then a.owner_id
    else null
  end
  from money.accounts a where a.id = p_account_id
$$;

revoke all on function money_private.compliance_subject_id(text) from public;

create or replace function money_private.begin_compliance_verification(
  p_user_id text,
  p_subject_type text,
  p_country_code text,
  p_expected_single_micros bigint,
  p_expected_monthly_micros bigint
)
returns money.compliance_subjects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject money.compliance_subjects%rowtype;
  v_prior_state text;
begin
  if p_subject_type not in ('individual', 'business') or p_country_code !~ '^[A-Z]{2}$' or
     p_expected_single_micros is null or p_expected_single_micros < 0 or
     p_expected_monthly_micros is null or p_expected_monthly_micros < p_expected_single_micros then
    raise exception 'invalid compliance onboarding profile' using errcode = '22023';
  end if;
  select * into v_subject from money.compliance_subjects
  where account_id = p_user_id for update;
  if v_subject.account_id is null then
    raise exception 'compliance subject not found' using errcode = 'P0002';
  end if;
  if v_subject.state in ('approved', 'restricted', 'closed') then
    raise exception 'compliance profile cannot be changed through onboarding' using errcode = '42501';
  end if;
  if v_subject.state = 'pending' and v_subject.subject_type = p_subject_type and
     v_subject.country_code = p_country_code and
     v_subject.expected_single_micros = p_expected_single_micros and
     v_subject.expected_monthly_micros = p_expected_monthly_micros then
    return v_subject;
  end if;
  v_prior_state := v_subject.state;
  update money.compliance_subjects set
    subject_type = p_subject_type,
    country_code = p_country_code,
    expected_single_micros = p_expected_single_micros,
    expected_monthly_micros = p_expected_monthly_micros,
    state = 'pending', version = version + 1, updated_at = clock_timestamp()
  where account_id = p_user_id
  returning * into v_subject;
  insert into money.compliance_subject_events(
    subject_account_id, prior_state, new_state, reason, database_actor
  ) values (
    p_user_id, v_prior_state,
    'pending', 'customer submitted compliance onboarding profile', session_user
  );
  return v_subject;
end;
$$;

revoke all on function money_private.begin_compliance_verification(text,text,text,bigint,bigint) from public;

create or replace function money_private.open_compliance_case(
  p_subject_account_id text,
  p_counterparty_id uuid,
  p_transfer_seq bigint,
  p_kind text,
  p_severity text,
  p_alert_code text,
  p_summary text,
  p_due_at timestamptz,
  p_review_reference text,
  p_reason text
)
returns money.compliance_cases
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case money.compliance_cases%rowtype;
begin
  if p_kind not in ('verification', 'sanctions', 'transaction_monitoring', 'fraud', 'complaint', 'regulatory_request', 'other') or
     p_severity not in ('low', 'medium', 'high', 'critical') or
     p_alert_code !~ '^[a-z][a-z0-9_.:-]{1,63}$' or
     p_summary is null or char_length(p_summary) not between 1 and 1000 or
     p_review_reference is null or char_length(p_review_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 2000 or
     (p_subject_account_id is null and p_counterparty_id is null and p_transfer_seq is null) then
    raise exception 'invalid compliance case' using errcode = '22023';
  end if;
  insert into money.compliance_cases(
    subject_account_id, counterparty_id, transfer_seq, kind, severity,
    alert_code, summary, due_at
  ) values (
    p_subject_account_id, p_counterparty_id, p_transfer_seq, p_kind, p_severity,
    p_alert_code, p_summary, p_due_at
  ) returning * into v_case;
  insert into money.compliance_case_actions(
    case_id, action, reason, review_reference, database_actor
  ) values (v_case.id, 'opened', p_reason, p_review_reference, session_user);
  return v_case;
end;
$$;

revoke all on function money_private.open_compliance_case(text,uuid,bigint,text,text,text,text,timestamptz,text,text) from public;

create or replace function money_private.restrict_compliance_subject(
  p_subject_account_id text,
  p_case_id uuid,
  p_reason_code text,
  p_reason text
)
returns money.compliance_restrictions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject money.compliance_subjects%rowtype;
  v_restriction money.compliance_restrictions%rowtype;
  v_prior_state text;
begin
  if p_reason_code !~ '^[a-z][a-z0-9_.:-]{1,63}$' or
     p_reason is null or char_length(p_reason) not between 1 and 1000 then
    raise exception 'invalid compliance restriction' using errcode = '22023';
  end if;
  select * into v_subject from money.compliance_subjects
  where account_id = p_subject_account_id for update;
  if v_subject.account_id is null or v_subject.state = 'closed' then
    raise exception 'compliance subject cannot be restricted' using errcode = '42501';
  end if;
  select * into v_restriction from money.compliance_restrictions
  where subject_account_id = p_subject_account_id and released_at is null for update;
  if v_restriction.id is not null then return v_restriction; end if;

  insert into money.compliance_restrictions(
    subject_account_id, case_id, reason_code, reason, database_actor
  ) values (
    p_subject_account_id, p_case_id, p_reason_code, p_reason, session_user
  ) returning * into v_restriction;
  v_prior_state := v_subject.state;
  update money.compliance_subjects set
    state = 'restricted', version = version + 1, updated_at = clock_timestamp()
  where account_id = p_subject_account_id;
  update money.accounts set status = 'frozen'
  where status = 'active' and (id = p_subject_account_id or owner_id = p_subject_account_id);
  insert into money.compliance_subject_events(
    subject_account_id, prior_state, new_state, reason, database_actor
  ) values (p_subject_account_id, v_prior_state, 'restricted', p_reason, session_user);
  return v_restriction;
end;
$$;

revoke all on function money_private.restrict_compliance_subject(text,uuid,text,text) from public;

create or replace function money_private.compliance_normalized_evidence_safe(
  p_value jsonb,
  p_depth integer
)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_entry record;
begin
  if p_depth > 8 then return false; end if;
  if jsonb_typeof(p_value) = 'object' then
    for v_entry in select e.key, e.value from jsonb_each(p_value) e loop
      if v_entry.key ~* '(name|dob|birth|ssn|tin|ein|tax[_-]?id|address|email|phone|passport|license|document|image|selfie)' then
        return false;
      end if;
      if not money_private.compliance_normalized_evidence_safe(v_entry.value, p_depth + 1) then
        return false;
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    if jsonb_array_length(p_value) > 100 then return false; end if;
    for v_entry in select a.value from jsonb_array_elements(p_value) a loop
      if not money_private.compliance_normalized_evidence_safe(v_entry.value, p_depth + 1) then
        return false;
      end if;
    end loop;
  end if;
  return true;
end;
$$;

revoke all on function money_private.compliance_normalized_evidence_safe(jsonb,integer) from public;

alter table money.compliance_evidence
  add constraint compliance_evidence_normalized_safe check (
    octet_length(normalized::text) <= 32768 and
    money_private.compliance_normalized_evidence_safe(normalized, 0)
  );

create or replace function money_private.record_compliance_evidence(
  p_subject_account_id text,
  p_kind text,
  p_provider text,
  p_provider_result_ref text,
  p_decision text,
  p_evidence_hash bytea,
  p_list_version text,
  p_observed_at timestamptz,
  p_expires_at timestamptz,
  p_normalized jsonb
)
returns table (evidence_id uuid, replayed boolean, subject_state text, screening_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject money.compliance_subjects%rowtype;
  v_prior money.compliance_evidence%rowtype;
  v_evidence money.compliance_evidence%rowtype;
  v_case money.compliance_cases%rowtype;
  v_prior_state text;
begin
  if p_kind not in ('identity', 'business', 'beneficial_owner', 'sanctions', 'pep', 'adverse_media') or
     p_provider !~ '^[a-z][a-z0-9_-]{1,31}$' or
     p_provider_result_ref is null or char_length(p_provider_result_ref) not between 1 and 255 or
     p_decision not in ('clear', 'review', 'blocked', 'error') or
     p_evidence_hash is null or octet_length(p_evidence_hash) <> 32 or
     p_observed_at is null or p_expires_at is null or p_expires_at <= p_observed_at or
     p_observed_at > clock_timestamp() + interval '5 minutes' or
     p_normalized is null or jsonb_typeof(p_normalized) <> 'object' or
     octet_length(p_normalized::text) > 32768 or
     not money_private.compliance_normalized_evidence_safe(p_normalized, 0) then
    raise exception 'invalid compliance evidence' using errcode = '22023';
  end if;
  select * into v_subject from money.compliance_subjects
  where account_id = p_subject_account_id for update;
  if v_subject.account_id is null or v_subject.state = 'closed' then
    raise exception 'compliance subject not found or closed' using errcode = 'P0002';
  end if;
  select * into v_prior from money.compliance_evidence
  where provider = p_provider and provider_result_ref = p_provider_result_ref;
  if v_prior.id is not null then
    if v_prior.subject_account_id <> p_subject_account_id or v_prior.kind <> p_kind or
       v_prior.decision <> p_decision or v_prior.evidence_hash <> p_evidence_hash or
       v_prior.observed_at <> p_observed_at or v_prior.expires_at <> p_expires_at or
       v_prior.normalized <> p_normalized then
      raise exception 'compliance provider result was reused with different evidence' using errcode = '22023';
    end if;
    return query select v_prior.id, true, v_subject.state, v_subject.screening_state;
    return;
  end if;
  insert into money.compliance_evidence(
    subject_account_id, kind, provider, provider_result_ref, decision,
    evidence_hash, list_version, normalized, observed_at, expires_at, database_actor
  ) values (
    p_subject_account_id, p_kind, p_provider, p_provider_result_ref, p_decision,
    p_evidence_hash, p_list_version, p_normalized, p_observed_at, p_expires_at, session_user
  ) returning * into v_evidence;

  v_prior_state := v_subject.state;
  if p_kind in ('identity', 'business') and p_decision = 'clear' then
    update money.compliance_subjects set
      provider = p_provider, provider_subject_ref = coalesce(provider_subject_ref, p_provider_result_ref),
      verification_version = coalesce(p_list_version, 'provider-current'),
      identity_evidence_hash = p_evidence_hash,
      identity_verified_at = p_observed_at, identity_expires_at = p_expires_at,
      state = case when state = 'unverified' then 'pending' else state end,
      version = version + 1, updated_at = clock_timestamp()
    where account_id = p_subject_account_id;
  elsif p_kind = 'beneficial_owner' and p_decision = 'clear' then
    update money.compliance_subjects set
      beneficial_owners_verified = true, version = version + 1, updated_at = clock_timestamp()
    where account_id = p_subject_account_id;
  elsif p_kind = 'sanctions' then
    update money.compliance_subjects set
      screening_state = case p_decision
        when 'clear' then 'clear' when 'review' then 'review'
        when 'blocked' then 'blocked' else 'error' end,
      screening_evidence_hash = p_evidence_hash,
      last_screened_at = p_observed_at, screening_expires_at = p_expires_at,
      state = case
        when p_decision = 'blocked' then state
        when p_decision in ('review', 'error') and state <> 'closed' then 'review'
        else state end,
      version = version + 1, updated_at = clock_timestamp()
    where account_id = p_subject_account_id;
  elsif p_decision in ('review', 'error') then
    update money.compliance_subjects set
      state = case when state = 'closed' then state else 'review' end,
      version = version + 1, updated_at = clock_timestamp()
    where account_id = p_subject_account_id;
  end if;

  if p_decision = 'blocked' then
    select * into v_case from money_private.open_compliance_case(
      p_subject_account_id, null, null,
      case when p_kind = 'sanctions' then 'sanctions' else 'verification' end,
      'critical', 'provider_blocked', 'Provider returned a blocked compliance result',
      clock_timestamp() + interval '1 day', p_provider_result_ref,
      'provider blocked result requires immediate review'
    );
    perform money_private.restrict_compliance_subject(
      p_subject_account_id, v_case.id, 'provider_blocked',
      'compliance provider returned a blocked result'
    );
  elsif p_decision in ('review', 'error') and v_prior_state <> 'review' then
    insert into money.compliance_subject_events(
      subject_account_id, prior_state, new_state, reason, review_reference, database_actor
    ) values (
      p_subject_account_id, v_prior_state, 'review',
      'compliance provider result requires review', p_provider_result_ref, session_user
    );
  end if;
  select * into v_subject from money.compliance_subjects where account_id = p_subject_account_id;
  return query select v_evidence.id, false, v_subject.state, v_subject.screening_state;
end;
$$;

revoke all on function money_private.record_compliance_evidence(text,text,text,text,text,bytea,text,timestamptz,timestamptz,jsonb) from public;

create or replace function money_private.enqueue_compliance_event(
  p_provider text,
  p_provider_event_id text,
  p_provider_result_ref text,
  p_endpoint_id text,
  p_delivery_hash bytea
)
returns table (inbox_id bigint, replayed boolean, event_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event money.compliance_event_inbox%rowtype;
begin
  if p_provider !~ '^[a-z][a-z0-9_-]{1,31}$' or
     p_provider_event_id is null or char_length(p_provider_event_id) not between 1 and 255 or
     p_provider_result_ref is null or char_length(p_provider_result_ref) not between 1 and 255 or
     p_endpoint_id is null or char_length(p_endpoint_id) not between 1 and 255 or
     p_delivery_hash is null or octet_length(p_delivery_hash) <> 32 then
    raise exception 'invalid compliance event envelope' using errcode = '22023';
  end if;
  insert into money.compliance_event_inbox(
    provider, provider_event_id, provider_result_ref, endpoint_id, delivery_hash
  ) values (
    p_provider, p_provider_event_id, p_provider_result_ref, p_endpoint_id, p_delivery_hash
  )
  on conflict (provider, provider_event_id) do nothing
  returning * into v_event;
  if v_event.id is not null then
    return query select v_event.id, false, v_event.state;
    return;
  end if;
  select * into v_event from money.compliance_event_inbox
  where provider = p_provider and provider_event_id = p_provider_event_id;
  if v_event.provider_result_ref <> p_provider_result_ref or
     v_event.endpoint_id <> p_endpoint_id or v_event.delivery_hash <> p_delivery_hash then
    raise exception 'compliance event id was reused with different delivery evidence' using errcode = '22023';
  end if;
  return query select v_event.id, true, v_event.state;
end;
$$;

revoke all on function money_private.enqueue_compliance_event(text,text,text,text,bytea) from public;

create or replace function money_private.claim_compliance_events(
  p_worker_id text,
  p_limit integer
)
returns table (
  inbox_id bigint, provider text, provider_event_id text,
  provider_result_ref text, attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 255 or
     p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid compliance event claim' using errcode = '22023';
  end if;
  return query
    with claims as (
      select e.id from money.compliance_event_inbox e
      where (e.state = 'queued' and e.next_attempt_at <= clock_timestamp())
         or (e.state = 'processing' and e.locked_at < clock_timestamp() - interval '2 minutes')
      order by e.next_attempt_at, e.id
      limit p_limit
      for update skip locked
    )
    update money.compliance_event_inbox e set
      state = 'processing', attempts = e.attempts + 1,
      locked_by = p_worker_id, locked_at = clock_timestamp(), updated_at = clock_timestamp()
    from claims where e.id = claims.id
    returning e.id, e.provider, e.provider_event_id, e.provider_result_ref, e.attempts;
end;
$$;

revoke all on function money_private.claim_compliance_events(text,integer) from public;

create or replace function money_private.complete_compliance_event(
  p_worker_id text,
  p_inbox_id bigint,
  p_evidence_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update money.compliance_event_inbox set
    state = 'completed', evidence_id = p_evidence_id,
    completed_at = clock_timestamp(), locked_by = null, locked_at = null,
    last_error = null, updated_at = clock_timestamp()
  where id = p_inbox_id and state = 'processing' and locked_by = p_worker_id
    and exists (select 1 from money.compliance_evidence where id = p_evidence_id);
  get diagnostics v_count = row_count;
  if v_count = 0 and not exists (
    select 1 from money.compliance_event_inbox
    where id = p_inbox_id and state = 'completed' and evidence_id = p_evidence_id
  ) then
    raise exception 'compliance worker does not own this event or evidence is missing' using errcode = '42501';
  end if;
  return v_count = 1;
end;
$$;

revoke all on function money_private.complete_compliance_event(text,bigint,uuid) from public;

create or replace function money_private.fail_compliance_event(
  p_worker_id text,
  p_inbox_id bigint,
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
     p_retry_seconds is null or p_retry_seconds not between 1 and 86400 or p_dead is null then
    raise exception 'invalid compliance event failure' using errcode = '22023';
  end if;
  update money.compliance_event_inbox set
    state = case when p_dead then 'dead' else 'queued' end,
    next_attempt_at = case when p_dead then next_attempt_at
      else clock_timestamp() + make_interval(secs => p_retry_seconds) end,
    last_error = p_error, locked_by = null, locked_at = null,
    updated_at = clock_timestamp()
  where id = p_inbox_id and state = 'processing' and locked_by = p_worker_id
  returning state into v_state;
  if v_state is null then
    raise exception 'compliance worker does not own this event' using errcode = '42501';
  end if;
  return v_state;
end;
$$;

revoke all on function money_private.fail_compliance_event(text,bigint,text,integer,boolean) from public;

create or replace function money_private.approve_compliance_subject(
  p_subject_account_id text,
  p_risk_tier text,
  p_next_review_at timestamptz,
  p_review_reference text,
  p_reason text
)
returns money.compliance_subjects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject money.compliance_subjects%rowtype;
  v_prior_state text;
begin
  if p_risk_tier not in ('low', 'standard', 'high') or
     p_next_review_at is null or p_next_review_at <= clock_timestamp() or
     p_review_reference is null or char_length(p_review_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 1000 then
    raise exception 'invalid compliance approval' using errcode = '22023';
  end if;
  select * into v_subject from money.compliance_subjects
  where account_id = p_subject_account_id for update;
  if v_subject.account_id is null or v_subject.state in ('restricted', 'closed') or
     v_subject.identity_verified_at is null or v_subject.identity_expires_at <= clock_timestamp() or
     v_subject.screening_state <> 'clear' or v_subject.screening_expires_at <= clock_timestamp() or
     (v_subject.subject_type = 'business' and not v_subject.beneficial_owners_verified) or
     exists (select 1 from money.compliance_restrictions r
             where r.subject_account_id = p_subject_account_id and r.released_at is null) or
     exists (select 1 from money.compliance_cases c
             where c.subject_account_id = p_subject_account_id
               and c.status in ('open', 'in_review', 'escalated', 'restricted')) then
    raise exception 'subject does not have current clear evidence or has unresolved review' using errcode = '42501';
  end if;
  v_prior_state := v_subject.state;
  update money.compliance_subjects set
    state = 'approved', risk_tier = p_risk_tier, next_review_at = p_next_review_at,
    version = version + 1, updated_at = clock_timestamp()
  where account_id = p_subject_account_id
  returning * into v_subject;
  insert into money.compliance_subject_events(
    subject_account_id, prior_state, new_state, reason, review_reference, database_actor
  ) values (
    p_subject_account_id, v_prior_state, 'approved', p_reason, p_review_reference, session_user
  );
  return v_subject;
end;
$$;

revoke all on function money_private.approve_compliance_subject(text,text,timestamptz,text,text) from public;

create or replace function money_private.resolve_compliance_case(
  p_case_id uuid,
  p_status text,
  p_review_reference text,
  p_reason text,
  p_evidence_hash bytea
)
returns money.compliance_cases
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case money.compliance_cases%rowtype;
begin
  if p_status not in ('closed_no_action', 'blocked', 'reported') or
     p_review_reference is null or char_length(p_review_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 2000 or
     (p_evidence_hash is not null and octet_length(p_evidence_hash) <> 32) then
    raise exception 'invalid compliance case resolution' using errcode = '22023';
  end if;
  select * into v_case from money.compliance_cases where id = p_case_id for update;
  if v_case.id is null then raise exception 'compliance case not found' using errcode = 'P0002'; end if;
  if v_case.status in ('closed_no_action', 'blocked', 'reported') then
    if v_case.status <> p_status then
      raise exception 'closed compliance case cannot change resolution' using errcode = '22023';
    end if;
    return v_case;
  end if;
  update money.compliance_cases set
    status = p_status, closed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_case_id returning * into v_case;
  insert into money.compliance_case_actions(
    case_id, action, reason, evidence_hash, review_reference, database_actor
  ) values (p_case_id, p_status, p_reason, p_evidence_hash, p_review_reference, session_user);
  return v_case;
end;
$$;

revoke all on function money_private.resolve_compliance_case(uuid,text,text,text,bytea) from public;

create or replace function money_private.release_compliance_restriction(
  p_subject_account_id text,
  p_release_reference text,
  p_reason text
)
returns money.compliance_subjects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject money.compliance_subjects%rowtype;
  v_restriction money.compliance_restrictions%rowtype;
  v_new_state text;
begin
  if p_release_reference is null or char_length(p_release_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 1000 then
    raise exception 'invalid restriction release' using errcode = '22023';
  end if;
  select * into v_subject from money.compliance_subjects
  where account_id = p_subject_account_id for update;
  select * into v_restriction from money.compliance_restrictions
  where subject_account_id = p_subject_account_id and released_at is null for update;
  if v_subject.account_id is null or v_restriction.id is null then
    raise exception 'active compliance restriction not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from money.compliance_cases c
    where c.subject_account_id = p_subject_account_id
      and c.status in ('open', 'in_review', 'escalated', 'restricted')
  ) then
    raise exception 'open compliance cases must be resolved before release' using errcode = '42501';
  end if;
  update money.compliance_restrictions set
    released_at = clock_timestamp(), release_reference = p_release_reference,
    release_reason = p_reason, released_by = session_user
  where id = v_restriction.id;
  v_new_state := case when
    v_subject.identity_expires_at > clock_timestamp() and
    v_subject.screening_state = 'clear' and v_subject.screening_expires_at > clock_timestamp() and
    (v_subject.subject_type = 'individual' or v_subject.beneficial_owners_verified)
    then 'approved' else 'review' end;
  update money.compliance_subjects set
    state = v_new_state, version = version + 1, updated_at = clock_timestamp()
  where account_id = p_subject_account_id returning * into v_subject;
  if v_new_state = 'approved' and not exists (
    select 1 from money.treasury_freezes f
    where f.user_id = p_subject_account_id and f.released_at is null
  ) then
    update money.accounts set status = 'active'
    where status = 'frozen' and (id = p_subject_account_id or owner_id = p_subject_account_id);
  end if;
  insert into money.compliance_subject_events(
    subject_account_id, prior_state, new_state, reason, review_reference, database_actor
  ) values (
    p_subject_account_id, 'restricted', v_new_state, p_reason, p_release_reference, session_user
  );
  return v_subject;
end;
$$;

revoke all on function money_private.release_compliance_restriction(text,text,text) from public;

create or replace function money_private.register_compliance_counterparty(
  p_kind text,
  p_canonical_ref text,
  p_label text,
  p_provider text,
  p_provider_ref text
)
returns money.compliance_counterparties
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash bytea;
  v_counterparty money.compliance_counterparties%rowtype;
begin
  if p_kind not in ('wallet', 'bank_destination', 'merchant', 'domain') or
     p_canonical_ref is null or char_length(p_canonical_ref) not between 1 and 800 or
     p_label is null or char_length(p_label) not between 1 and 200 or
     (p_provider is not null and p_provider !~ '^[a-z][a-z0-9_-]{1,31}$') or
     (p_provider_ref is not null and char_length(p_provider_ref) not between 1 and 255) then
    raise exception 'invalid compliance counterparty' using errcode = '22023';
  end if;
  v_hash := public.digest(p_canonical_ref, 'sha256');
  insert into money.compliance_counterparties(
    kind, canonical_ref_hash, label, provider, provider_ref
  ) values (p_kind, v_hash, p_label, p_provider, p_provider_ref)
  on conflict (canonical_ref_hash) do nothing
  returning * into v_counterparty;
  if v_counterparty.id is null then
    select * into v_counterparty from money.compliance_counterparties
    where canonical_ref_hash = v_hash;
    if v_counterparty.kind <> p_kind or v_counterparty.label <> p_label or
       v_counterparty.provider is distinct from p_provider or
       v_counterparty.provider_ref is distinct from p_provider_ref then
      raise exception 'canonical counterparty was reused with different terms' using errcode = '22023';
    end if;
  end if;
  return v_counterparty;
end;
$$;

revoke all on function money_private.register_compliance_counterparty(text,text,text,text,text) from public;

create or replace function money_private.record_counterparty_screening(
  p_counterparty_id uuid,
  p_state text,
  p_evidence_hash bytea,
  p_list_version text,
  p_screened_at timestamptz,
  p_expires_at timestamptz
)
returns money.compliance_counterparties
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_counterparty money.compliance_counterparties%rowtype;
begin
  if p_state not in ('clear', 'review', 'blocked', 'error') or
     p_evidence_hash is null or octet_length(p_evidence_hash) <> 32 or
     p_screened_at is null or p_expires_at is null or p_expires_at <= p_screened_at or
     p_screened_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid counterparty screening' using errcode = '22023';
  end if;
  select * into v_counterparty from money.compliance_counterparties
  where id = p_counterparty_id for update;
  if v_counterparty.id is null then
    raise exception 'compliance counterparty not found' using errcode = 'P0002';
  end if;
  if v_counterparty.screened_at is not null and p_screened_at < v_counterparty.screened_at then
    raise exception 'counterparty screening cannot move backward in time' using errcode = '22023';
  end if;
  update money.compliance_counterparties set
    state = p_state, evidence_hash = p_evidence_hash, list_version = p_list_version,
    screened_at = p_screened_at, expires_at = p_expires_at,
    version = version + 1, updated_at = clock_timestamp()
  where id = p_counterparty_id returning * into v_counterparty;
  return v_counterparty;
end;
$$;

revoke all on function money_private.record_counterparty_screening(uuid,text,bytea,text,timestamptz,timestamptz) from public;

create or replace function money_private.link_treasury_destination_compliance(
  p_destination_id uuid,
  p_counterparty_id uuid,
  p_review_reference text
)
returns money.treasury_destinations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_destination money.treasury_destinations%rowtype;
  v_counterparty money.compliance_counterparties%rowtype;
begin
  if p_review_reference is null or char_length(p_review_reference) not between 3 and 255 then
    raise exception 'destination compliance link requires a review reference' using errcode = '22023';
  end if;
  select * into v_counterparty from money.compliance_counterparties
  where id = p_counterparty_id for key share;
  if v_counterparty.id is null or v_counterparty.kind <> 'bank_destination' then
    raise exception 'bank-destination compliance counterparty not found' using errcode = 'P0002';
  end if;
  update money.treasury_destinations set compliance_counterparty_id = p_counterparty_id
  where id = p_destination_id returning * into v_destination;
  if v_destination.id is null then
    raise exception 'treasury destination not found' using errcode = 'P0002';
  end if;
  insert into money.compliance_subject_events(
    subject_account_id, prior_state, new_state, reason, review_reference, database_actor
  )
  select money_private.compliance_subject_id(v_destination.account_id), s.state, s.state,
    'payout destination linked to screened counterparty', p_review_reference, session_user
  from money.compliance_subjects s
  where s.account_id = money_private.compliance_subject_id(v_destination.account_id);
  return v_destination;
end;
$$;

revoke all on function money_private.link_treasury_destination_compliance(uuid,uuid,text) from public;

create or replace function money_private.compliance_subject_state(p_requester_id text)
returns table (
  account_id text, subject_type text, state text, risk_tier text, country_code text,
  screening_state text, identity_expires_at timestamptz,
  screening_expires_at timestamptz, next_review_at timestamptz, updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_subject_id text;
begin
  v_subject_id := money_private.compliance_subject_id(p_requester_id);
  if v_subject_id is null then return; end if;
  return query
    select s.account_id, s.subject_type, s.state, s.risk_tier, s.country_code,
      case when s.screening_state in ('clear', 'pending', 'expired') then s.screening_state else 'review' end,
      s.identity_expires_at, s.screening_expires_at, s.next_review_at, s.updated_at
    from money.compliance_subjects s where s.account_id = v_subject_id;
end;
$$;

revoke all on function money_private.compliance_subject_state(text) from public;

create or replace function money_private.configure_risk_limits(
  p_risk_tier text,
  p_per_transfer_micros bigint,
  p_daily_cross_user_micros bigint,
  p_daily_external_micros bigint,
  p_daily_payout_micros bigint,
  p_rolling_30d_outflow_micros bigint,
  p_review_reference text,
  p_reason text
)
returns money.risk_limits
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limits money.risk_limits%rowtype;
begin
  if p_risk_tier not in ('low', 'standard', 'high') or
     p_per_transfer_micros is null or p_per_transfer_micros <= 0 or
     p_daily_cross_user_micros is null or p_daily_external_micros is null or
     p_daily_payout_micros is null or p_rolling_30d_outflow_micros is null or
     p_daily_cross_user_micros < p_per_transfer_micros or
     p_daily_external_micros < p_per_transfer_micros or
     p_daily_payout_micros < p_per_transfer_micros or
     p_rolling_30d_outflow_micros < greatest(
       p_daily_cross_user_micros, p_daily_external_micros, p_daily_payout_micros
     ) or
     p_review_reference is null or char_length(p_review_reference) not between 3 and 255 or
     p_reason is null or char_length(p_reason) not between 1 and 1000 then
    raise exception 'invalid reviewed risk limits' using errcode = '22023';
  end if;
  update money.risk_limits set
    per_transfer_micros = p_per_transfer_micros,
    daily_cross_user_micros = p_daily_cross_user_micros,
    daily_external_micros = p_daily_external_micros,
    daily_payout_micros = p_daily_payout_micros,
    rolling_30d_outflow_micros = p_rolling_30d_outflow_micros,
    updated_at = clock_timestamp()
  where risk_tier = p_risk_tier returning * into v_limits;
  if v_limits.risk_tier is null then
    raise exception 'risk tier not found' using errcode = 'P0002';
  end if;
  insert into money.risk_limit_events(
    risk_tier, per_transfer_micros, daily_cross_user_micros,
    daily_external_micros, daily_payout_micros, rolling_30d_outflow_micros,
    review_reference, reason, database_actor
  ) values (
    p_risk_tier, p_per_transfer_micros, p_daily_cross_user_micros,
    p_daily_external_micros, p_daily_payout_micros, p_rolling_30d_outflow_micros,
    p_review_reference, p_reason, session_user
  );
  return v_limits;
end;
$$;

revoke all on function money_private.configure_risk_limits(
  text,bigint,bigint,bigint,bigint,bigint,text,text
) from public;

create or replace function money_private.record_risk_decision(
  p_actor_id text,
  p_operation text,
  p_idempotency_key text,
  p_request_hash bytea,
  p_from_account_id text,
  p_to_account_id text,
  p_source_subject_id text,
  p_destination_subject_id text,
  p_counterparty_id uuid,
  p_asset_code text,
  p_amount_micros bigint,
  p_risk_tier text,
  p_outcome text,
  p_rule_codes text[],
  p_reason text
)
returns table (
  decision_id uuid, replayed boolean, decision_outcome text,
  decision_rule_codes text[], decision_reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision money.risk_decisions%rowtype;
begin
  if p_request_hash is null or octet_length(p_request_hash) <> 32 or
     p_outcome not in ('allow', 'deny', 'review') or
     p_rule_codes is null or cardinality(p_rule_codes) not between 1 and 20 or
     p_reason is null or char_length(p_reason) not between 1 and 500 then
    raise exception 'invalid risk decision' using errcode = '22023';
  end if;
  insert into money.risk_decisions(
    actor_id, operation, idempotency_key, request_hash,
    from_account_id, to_account_id, source_subject_id, destination_subject_id,
    counterparty_id, asset_code, amount_micros, risk_tier,
    outcome, rule_codes, reason
  ) values (
    p_actor_id, p_operation, p_idempotency_key, p_request_hash,
    p_from_account_id, p_to_account_id, p_source_subject_id, p_destination_subject_id,
    p_counterparty_id, p_asset_code, p_amount_micros, p_risk_tier,
    p_outcome, p_rule_codes, p_reason
  )
  on conflict (actor_id, operation, idempotency_key) do nothing
  returning * into v_decision;
  if v_decision.id is not null then
    return query select v_decision.id, false, v_decision.outcome,
      v_decision.rule_codes, v_decision.reason;
    return;
  end if;
  select * into v_decision from money.risk_decisions
  where actor_id = p_actor_id and operation = p_operation and idempotency_key = p_idempotency_key;
  if v_decision.request_hash <> p_request_hash or
     v_decision.from_account_id <> p_from_account_id or
     v_decision.to_account_id <> p_to_account_id or
     v_decision.asset_code <> p_asset_code or
     v_decision.amount_micros <> p_amount_micros then
    raise exception 'risk decision idempotency key was reused with different terms' using errcode = '22023';
  end if;
  return query select v_decision.id, true, v_decision.outcome,
    v_decision.rule_codes, v_decision.reason;
end;
$$;

revoke all on function money_private.record_risk_decision(
  text,text,text,bytea,text,text,text,text,uuid,text,bigint,text,text,text[],text
) from public;

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
    if p_operation = 'external_debit' then
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
  v_required := new.operation in ('fund', 'external_debit', 'funding_settlement', 'payout_hold') or
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

create trigger transfers_require_risk_decision
before insert on money.transfers
for each row execute function money_private.assert_transfer_risk_decision();

revoke all on function money_private.assert_transfer_risk_decision() from public;

-- Keep the proven journal kernels byte-for-byte as base implementations. The
-- wrappers perform deterministic prechecks, reserve a stable risk denial or
-- set a transaction-local decision capability, and then call the base. The
-- transfer trigger makes stale cached callers fail closed after a live upgrade.
alter function money_private.post_transfer_kernel(
  text,text,text,text,text,text,bigint,text,jsonb,uuid
) rename to post_transfer_kernel_before_compliance;

revoke all on function money_private.post_transfer_kernel_before_compliance(
  text,text,text,text,text,text,bigint,text,jsonb,uuid
) from public;

create function money_private.post_transfer_kernel(
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
  status text, replayed boolean, transfer_id uuid, receipt_id uuid,
  denial_code text, reason text, from_balance_micros bigint, to_balance_micros bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from money.accounts%rowtype;
  v_to money.accounts%rowtype;
  v_from_balance bigint;
  v_hash bytea;
  v_key_id bigint;
  v_result jsonb;
  v_risk record;
  v_post record;
  v_transfer_seq bigint;
  v_restore_status text;
begin
  if exists (
    select 1 from money.idempotency_keys k
    where k.actor_id = p_actor_id and k.operation = p_operation
      and k.idempotency_key = p_idempotency_key
  ) or p_operation = 'allocate' then
    return query select * from money_private.post_transfer_kernel_before_compliance(
      p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
      p_asset_code, p_amount_micros, p_memo, p_metadata, p_refund_of
    );
    return;
  end if;
  if p_operation in ('refund', 'external_reversal') then
    perform 1 from money.accounts where id in (p_from_account_id, p_to_account_id)
    order by id for update;
    select a.status into v_restore_status from money.accounts a where a.id = p_to_account_id;
    if v_restore_status in ('frozen', 'closed') then
      -- A restriction stops new value movement, not the return of money that
      -- already left. The destination is active only inside this locked
      -- transaction and is restored before any concurrent observer can see it.
      update money.accounts set status = 'active' where id = p_to_account_id;
      select * into v_post from money_private.post_transfer_kernel_before_compliance(
        p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
        p_asset_code, p_amount_micros, p_memo, p_metadata, p_refund_of
      );
      update money.accounts set status = v_restore_status where id = p_to_account_id;
      return query select v_post.status::text, v_post.replayed::boolean,
        v_post.transfer_id::uuid, v_post.receipt_id::uuid,
        v_post.denial_code::text, v_post.reason::text,
        v_post.from_balance_micros::bigint, v_post.to_balance_micros::bigint;
      return;
    end if;
    return query select * from money_private.post_transfer_kernel_before_compliance(
      p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
      p_asset_code, p_amount_micros, p_memo, p_metadata, p_refund_of
    );
    return;
  end if;
  if p_actor_id is null or p_idempotency_key is null or p_from_account_id is null or
     p_to_account_id is null or p_asset_code is null or p_amount_micros is null or
     p_amount_micros <= 0 or p_memo is null or p_metadata is null or
     jsonb_typeof(p_metadata) <> 'object' then
    return query select * from money_private.post_transfer_kernel_before_compliance(
      p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
      p_asset_code, p_amount_micros, p_memo, p_metadata, p_refund_of
    );
    return;
  end if;
  perform 1 from money.accounts where id in (p_from_account_id, p_to_account_id)
  order by id for update;
  select * into v_from from money.accounts where id = p_from_account_id;
  select * into v_to from money.accounts where id = p_to_account_id;
  if v_from.id is null or v_to.id is null or v_from.status <> 'active' or v_to.status <> 'active' or
     (p_operation = 'pay' and (p_actor_id <> p_from_account_id or v_from.kind <> 'agent' or v_to.kind = 'external')) or
     (p_operation = 'fund' and (p_from_account_id <> 'external:funding' or p_actor_id <> p_to_account_id or v_to.kind <> 'user')) or
     (p_operation = 'external_debit' and (p_actor_id <> p_from_account_id or v_from.kind <> 'agent' or p_to_account_id <> 'external:x402')) or
     p_operation not in ('pay', 'fund', 'external_debit') then
    return query select * from money_private.post_transfer_kernel_before_compliance(
      p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
      p_asset_code, p_amount_micros, p_memo, p_metadata, p_refund_of
    );
    return;
  end if;
  if p_operation <> 'fund' then
    select available_micros into v_from_balance from money.balances
    where account_id = p_from_account_id and asset_code = p_asset_code for update;
    if coalesce(v_from_balance, 0) < p_amount_micros then
      return query select * from money_private.post_transfer_kernel_before_compliance(
        p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
        p_asset_code, p_amount_micros, p_memo, p_metadata, p_refund_of
      );
      return;
    end if;
  end if;
  v_hash := public.digest(jsonb_build_object(
    'actor', p_actor_id, 'operation', p_operation, 'from', p_from_account_id,
    'to', p_to_account_id, 'asset', p_asset_code, 'amount', p_amount_micros,
    'memo', p_memo, 'metadata', p_metadata
  )::text, 'sha256');
  select * into v_risk from money_private.evaluate_transfer_risk(
    p_actor_id, p_operation, p_idempotency_key, v_hash,
    p_from_account_id, p_to_account_id, p_asset_code, p_amount_micros, p_metadata
  );
  if v_risk.decision_id is null then
    return query select * from money_private.post_transfer_kernel_before_compliance(
      p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
      p_asset_code, p_amount_micros, p_memo, p_metadata, p_refund_of
    );
    return;
  end if;
  if not v_risk.allowed then
    insert into money.idempotency_keys(actor_id, operation, idempotency_key, request_hash)
    values (p_actor_id, p_operation, p_idempotency_key, v_hash)
    on conflict (actor_id, operation, idempotency_key) do nothing returning id into v_key_id;
    if v_key_id is null then
      return query select * from money_private.post_transfer_kernel_before_compliance(
        p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
        p_asset_code, p_amount_micros, p_memo, p_metadata, p_refund_of
      );
      return;
    end if;
    v_result := jsonb_build_object('denialCode', v_risk.denial_code, 'reason', v_risk.reason);
    update money.idempotency_keys set state = 'completed', result_kind = 'denied',
      result = v_result, completed_at = clock_timestamp() where id = v_key_id;
    return query select 'denied', false, null::uuid, null::uuid,
      v_risk.denial_code::text, v_risk.reason::text, null::bigint, null::bigint;
    return;
  end if;
  perform set_config('money.risk_decision_id', v_risk.decision_id::text, true);
  select * into v_post from money_private.post_transfer_kernel_before_compliance(
    p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
    p_asset_code, p_amount_micros, p_memo, p_metadata, p_refund_of
  );
  perform set_config('money.risk_decision_id', '', true);
  if v_post.status <> 'posted' then
    raise exception 'risk precheck diverged from journal result' using errcode = '55000';
  end if;
  select seq into v_transfer_seq from money.transfers where id = v_post.transfer_id;
  insert into money.risk_transfer_links(decision_id, transfer_seq)
  values (v_risk.decision_id, v_transfer_seq) on conflict do nothing;
  if not exists (
    select 1 from money.risk_transfer_links l
    where l.decision_id = v_risk.decision_id and l.transfer_seq = v_transfer_seq
  ) then
    raise exception 'risk decision is linked to a different transfer' using errcode = '55000';
  end if;
  return query select v_post.status::text, v_post.replayed::boolean,
    v_post.transfer_id::uuid, v_post.receipt_id::uuid,
    v_post.denial_code::text, v_post.reason::text,
    v_post.from_balance_micros::bigint, v_post.to_balance_micros::bigint;
end;
$$;

revoke all on function money_private.post_transfer_kernel(
  text,text,text,text,text,text,bigint,text,jsonb,uuid
) from public;

alter function money_private.post_treasury_transfer(
  text,text,text,text,text,text,bigint,text,jsonb
) rename to post_treasury_transfer_before_compliance;

revoke all on function money_private.post_treasury_transfer_before_compliance(
  text,text,text,text,text,text,bigint,text,jsonb
) from public;

create function money_private.post_treasury_transfer(
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
  v_from money.accounts%rowtype;
  v_to money.accounts%rowtype;
  v_from_balance bigint;
  v_hash bytea;
  v_key_id bigint;
  v_result jsonb;
  v_risk record;
  v_post record;
begin
  if exists (
    select 1 from money.idempotency_keys k
    where k.actor_id = p_actor_id and k.operation = p_operation
      and k.idempotency_key = p_idempotency_key
  ) or p_operation in ('funding_return', 'payout_reversal') then
    return query select * from money_private.post_treasury_transfer_before_compliance(
      p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
      p_asset_code, p_amount_micros, p_memo, p_metadata
    );
    return;
  end if;
  if p_operation not in ('funding_settlement', 'payout_hold') or
     p_actor_id is null or p_idempotency_key is null or p_amount_micros is null or
     p_amount_micros <= 0 or p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    return query select * from money_private.post_treasury_transfer_before_compliance(
      p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
      p_asset_code, p_amount_micros, p_memo, p_metadata
    );
    return;
  end if;
  perform 1 from money.accounts where id in (p_from_account_id, p_to_account_id)
  order by id for update;
  select * into v_from from money.accounts where id = p_from_account_id;
  select * into v_to from money.accounts where id = p_to_account_id;
  if v_from.id is null or v_to.id is null or
     (p_operation = 'funding_settlement' and not (
       p_actor_id = 'external:funding' and p_from_account_id = 'external:funding' and
       v_from.kind = 'external' and v_to.kind = 'user' and v_to.status in ('active', 'frozen')
     )) or
     (p_operation = 'payout_hold' and not (
       p_actor_id = p_from_account_id and v_from.kind in ('user', 'provider') and
       v_from.status = 'active' and p_to_account_id = 'external:payout'
     )) then
    return query select * from money_private.post_treasury_transfer_before_compliance(
      p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
      p_asset_code, p_amount_micros, p_memo, p_metadata
    );
    return;
  end if;
  if p_operation = 'payout_hold' then
    select available_micros into v_from_balance from money.balances
    where account_id = p_from_account_id and asset_code = p_asset_code for update;
    if coalesce(v_from_balance, 0) < p_amount_micros then
      return query select * from money_private.post_treasury_transfer_before_compliance(
        p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
        p_asset_code, p_amount_micros, p_memo, p_metadata
      );
      return;
    end if;
  end if;
  v_hash := public.digest(jsonb_build_object(
    'actor', p_actor_id, 'operation', p_operation, 'from', p_from_account_id,
    'to', p_to_account_id, 'asset', p_asset_code, 'amount', p_amount_micros,
    'memo', p_memo, 'metadata', p_metadata
  )::text, 'sha256');
  select * into v_risk from money_private.evaluate_transfer_risk(
    p_actor_id, p_operation, p_idempotency_key, v_hash,
    p_from_account_id, p_to_account_id, p_asset_code, p_amount_micros, p_metadata
  );
  if not v_risk.allowed then
    insert into money.idempotency_keys(actor_id, operation, idempotency_key, request_hash)
    values (p_actor_id, p_operation, p_idempotency_key, v_hash)
    on conflict (actor_id, operation, idempotency_key) do nothing returning id into v_key_id;
    if v_key_id is null then
      return query select * from money_private.post_treasury_transfer_before_compliance(
        p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
        p_asset_code, p_amount_micros, p_memo, p_metadata
      );
      return;
    end if;
    v_result := jsonb_build_object('denialCode', v_risk.denial_code, 'reason', v_risk.reason);
    update money.idempotency_keys set state = 'completed', result_kind = 'denied',
      result = v_result, completed_at = clock_timestamp() where id = v_key_id;
    return query select 'denied', false, null::bigint, null::uuid, null::uuid,
      v_risk.denial_code::text, v_risk.reason::text, null::bigint, null::bigint;
    return;
  end if;
  perform set_config('money.risk_decision_id', v_risk.decision_id::text, true);
  select * into v_post from money_private.post_treasury_transfer_before_compliance(
    p_actor_id, p_operation, p_idempotency_key, p_from_account_id, p_to_account_id,
    p_asset_code, p_amount_micros, p_memo, p_metadata
  );
  perform set_config('money.risk_decision_id', '', true);
  if v_post.status <> 'posted' then
    raise exception 'risk precheck diverged from treasury journal result' using errcode = '55000';
  end if;
  insert into money.risk_transfer_links(decision_id, transfer_seq)
  values (v_risk.decision_id, v_post.transfer_seq) on conflict do nothing;
  if not exists (
    select 1 from money.risk_transfer_links l
    where l.decision_id = v_risk.decision_id and l.transfer_seq = v_post.transfer_seq
  ) then
    raise exception 'risk decision is linked to a different treasury transfer' using errcode = '55000';
  end if;
  return query select v_post.status::text, v_post.replayed::boolean,
    v_post.transfer_seq::bigint, v_post.transfer_id::uuid, v_post.receipt_id::uuid,
    v_post.denial_code::text, v_post.reason::text,
    v_post.from_balance_micros::bigint, v_post.to_balance_micros::bigint;
end;
$$;

revoke all on function money_private.post_treasury_transfer(
  text,text,text,text,text,text,bigint,text,jsonb
) from public;

create or replace function money_private.sweep_expired_compliance(p_limit integer)
returns table (restricted_subjects integer, expired_counterparties integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject record;
  v_case_id uuid;
  v_restricted integer := 0;
  v_expired integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'compliance sweep limit must be 1-500' using errcode = '22023';
  end if;

  for v_subject in
    select s.account_id
    from money.compliance_subjects s
    where s.state = 'approved' and (
      s.identity_expires_at is null or s.identity_expires_at <= clock_timestamp() or
      s.screening_expires_at is null or s.screening_expires_at <= clock_timestamp() or
      s.next_review_at is null or s.next_review_at <= clock_timestamp()
    )
    order by s.account_id
    limit p_limit
    for update skip locked
  loop
    select c.id into v_case_id
    from money.compliance_cases c
    where c.subject_account_id = v_subject.account_id
      and c.alert_code = 'evidence_expired'
      and c.status in ('open', 'in_review', 'escalated', 'restricted')
    order by c.created_at, c.id
    limit 1
    for update;
    if v_case_id is null then
      select opened.id into v_case_id
      from money_private.open_compliance_case(
        v_subject.account_id, null, null, 'verification', 'high',
        'evidence_expired', 'Compliance evidence or periodic review has expired',
        clock_timestamp() + interval '1 day', 'AUTO-EXPIRY',
        'automated expiry sweep requires renewed evidence and manual review'
      ) opened;
    end if;
    perform money_private.restrict_compliance_subject(
      v_subject.account_id, v_case_id, 'evidence_expired',
      'compliance evidence or periodic review expired'
    );
    v_restricted := v_restricted + 1;
  end loop;

  with targets as (
    select c.id
    from money.compliance_counterparties c
    where c.state not in ('blocked', 'expired')
      and c.expires_at is not null and c.expires_at <= clock_timestamp()
    order by c.id
    limit p_limit
    for update skip locked
  )
  update money.compliance_counterparties c set
    state = 'expired', version = c.version + 1, updated_at = clock_timestamp()
  from targets where c.id = targets.id;
  get diagnostics v_expired = row_count;

  return query select v_restricted, v_expired;
end;
$$;

revoke all on function money_private.sweep_expired_compliance(integer) from public;

-- Raw tables remain inaccessible. Function grants are assigned in db/roles.sql.
