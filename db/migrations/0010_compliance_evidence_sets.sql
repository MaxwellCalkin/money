-- One authenticated provider event may yield several independently typed
-- evidence rows (for example identity plus sanctions). Record the complete
-- set and finish the inbox claim in one transaction so a worker crash cannot
-- leave a mutable provider object half-applied under an occupied result key.
-- The ordered link also retains the opaque provider-side subject reference;
-- Persona monitoring evidence must match the account bound by the inquiry.

create table money.compliance_event_evidence (
  inbox_id bigint not null references money.compliance_event_inbox(id) on delete restrict,
  evidence_id uuid not null references money.compliance_evidence(id) on delete restrict,
  ordinal smallint not null check (ordinal between 1 and 16),
  provider_subject_ref text check (
    provider_subject_ref is null or char_length(provider_subject_ref) between 1 and 255
  ),
  created_at timestamptz not null default clock_timestamp(),
  primary key (inbox_id, evidence_id),
  unique (inbox_id, ordinal)
);

create index compliance_event_evidence_evidence_idx
  on money.compliance_event_evidence(evidence_id, inbox_id);

insert into money.compliance_event_evidence(inbox_id, evidence_id, ordinal)
select id, evidence_id, 1
from money.compliance_event_inbox
where evidence_id is not null;

create or replace function money_private.record_compliance_event_evidence_set(
  p_worker_id text,
  p_inbox_id bigint,
  p_items jsonb
)
returns table (
  primary_evidence_id uuid,
  evidence_ids uuid[],
  subject_state text,
  screening_state text,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event money.compliance_event_inbox%rowtype;
  v_item jsonb;
  v_ordinal bigint;
  v_evidence record;
  v_stored money.compliance_evidence%rowtype;
  v_existing_id uuid;
  v_existing_provider_subject_ref text;
  v_primary_id uuid;
  v_ids uuid[] := array[]::uuid[];
  v_subject_id text;
  v_provider_subject_ref text;
  v_subject money.compliance_subjects%rowtype;
  v_link_count integer;
  v_was_completed boolean;
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 255 or
     p_inbox_id is null or p_items is null or jsonb_typeof(p_items) <> 'array' or
     jsonb_array_length(p_items) not between 1 and 16 or
     pg_catalog.pg_column_size(p_items) > 1048576 then
    raise exception 'invalid compliance event evidence set' using errcode = '22023';
  end if;

  select * into v_event
  from money.compliance_event_inbox
  where id = p_inbox_id
  for update;
  if v_event.id is null then
    raise exception 'compliance event not found' using errcode = 'P0002';
  end if;
  v_was_completed := v_event.state = 'completed';
  if not v_was_completed and
     (v_event.state <> 'processing' or v_event.locked_by <> p_worker_id) then
    raise exception 'compliance worker does not own this event' using errcode = '42501';
  end if;
  if v_was_completed then
    select count(*)::integer into v_link_count
    from money.compliance_event_evidence
    where inbox_id = p_inbox_id;
    if v_link_count <> jsonb_array_length(p_items) then
      raise exception 'compliance event evidence set changed on replay' using errcode = '22023';
    end if;
  end if;

  for v_item, v_ordinal in
    select item.value, item.ordinality
    from jsonb_array_elements(p_items) with ordinality as item(value, ordinality)
  loop
    if jsonb_typeof(v_item) <> 'object' or
       not (v_item ?& array[
         'subjectAccountId', 'kind', 'providerResultRef', 'decision',
         'evidenceHash', 'observedAt', 'expiresAt', 'normalized'
       ]) or
       v_item - array[
         'subjectAccountId', 'providerSubjectRef', 'kind', 'providerResultRef', 'decision',
         'evidenceHash', 'listVersion', 'observedAt', 'expiresAt', 'normalized'
       ]::text[] <> '{}'::jsonb or
       coalesce(v_item->>'evidenceHash', '') !~ '^[0-9a-fA-F]{64}$' or
       jsonb_typeof(v_item->'normalized') <> 'object' or
       (v_item ? 'listVersion' and jsonb_typeof(v_item->'listVersion') not in ('string', 'null')) or
       (v_item ? 'providerSubjectRef' and (
         jsonb_typeof(v_item->'providerSubjectRef') not in ('string', 'null') or
         (jsonb_typeof(v_item->'providerSubjectRef') = 'string' and
          char_length(v_item->>'providerSubjectRef') not between 1 and 255)
       )) then
      raise exception 'invalid compliance event evidence item' using errcode = '22023';
    end if;

    if v_subject_id is null then
      v_subject_id := v_item->>'subjectAccountId';
    elsif v_subject_id <> v_item->>'subjectAccountId' then
      raise exception 'compliance event evidence spans multiple subjects' using errcode = '22023';
    end if;
    if v_item->>'providerSubjectRef' is not null then
      if v_provider_subject_ref is null then
        v_provider_subject_ref := v_item->>'providerSubjectRef';
      elsif v_provider_subject_ref <> v_item->>'providerSubjectRef' then
        raise exception 'compliance event evidence spans multiple provider subjects'
          using errcode = '22023';
      end if;
    end if;
    if v_ordinal = 1 and v_item->>'providerResultRef' <> v_event.provider_result_ref then
      raise exception 'compliance event has different primary result evidence' using errcode = '22023';
    end if;

    -- A continuous Persona report is useful only if its opaque Persona account
    -- is the same account established by this subject's approved inquiry. The
    -- reference is not PII, and binding it here prevents a correctly signed
    -- report for an unrelated Persona account from clearing this user.
    if v_event.provider = 'persona' then
      if coalesce(v_item->>'providerSubjectRef', '') !~ '^act_[A-Za-z0-9]{8,128}$' then
        raise exception 'Persona evidence is missing a valid provider subject reference'
          using errcode = '22023';
      end if;
      select * into v_subject
      from money.compliance_subjects
      where account_id = v_subject_id
      for update;
      if v_subject.account_id is null then
        raise exception 'compliance subject not found' using errcode = 'P0002';
      end if;
      if v_item->>'kind' in ('identity', 'business') then
        if (v_subject.provider is not null and v_subject.provider <> v_event.provider) or
           (v_subject.provider_subject_ref is not null and
            v_subject.provider_subject_ref <> v_item->>'providerSubjectRef' and
            v_subject.provider_subject_ref <> v_item->>'providerResultRef') then
          raise exception 'Persona provider subject is not bound to this compliance subject'
            using errcode = '22023';
        end if;
      elsif v_subject.provider is distinct from v_event.provider or
            v_subject.provider_subject_ref is distinct from v_item->>'providerSubjectRef' then
        raise exception 'Persona provider subject is not bound to this compliance subject'
          using errcode = '22023';
      end if;
    end if;

    select * into v_evidence
    from money_private.record_compliance_evidence(
      v_item->>'subjectAccountId',
      v_item->>'kind',
      v_event.provider,
      v_item->>'providerResultRef',
      v_item->>'decision',
      pg_catalog.decode(v_item->>'evidenceHash', 'hex'),
      v_item->>'listVersion',
      (v_item->>'observedAt')::timestamptz,
      (v_item->>'expiresAt')::timestamptz,
      v_item->'normalized'
    );

    -- record_compliance_evidence predates event evidence sets and did not
    -- include list_version in its replay comparison. Treat that version as
    -- immutable here: changing the source list/template changes the meaning
    -- of otherwise identical screening evidence.
    select * into v_stored
    from money.compliance_evidence
    where id = v_evidence.evidence_id;
    if v_stored.list_version is distinct from v_item->>'listVersion' then
      raise exception 'compliance provider result was reused with different evidence'
        using errcode = '22023';
    end if;

    if v_event.provider = 'persona' and
       v_item->>'kind' in ('identity', 'business') and
       v_item->>'decision' = 'clear' then
      update money.compliance_subjects set
        provider_subject_ref = v_item->>'providerSubjectRef',
        updated_at = clock_timestamp()
      where account_id = v_subject_id and provider = v_event.provider and
        provider_subject_ref in (
          v_item->>'providerResultRef', v_item->>'providerSubjectRef'
        )
      returning * into v_subject;
      if v_subject.account_id is null then
        raise exception 'Persona provider subject binding failed' using errcode = '22023';
      end if;
    end if;

    insert into money.compliance_event_evidence(
      inbox_id, evidence_id, ordinal, provider_subject_ref
    ) values (
      p_inbox_id, v_evidence.evidence_id, v_ordinal::smallint,
      v_item->>'providerSubjectRef'
    )
    on conflict (inbox_id, ordinal) do nothing;

    select link.evidence_id, link.provider_subject_ref
    into v_existing_id, v_existing_provider_subject_ref
    from money.compliance_event_evidence link
    where link.inbox_id = p_inbox_id and link.ordinal = v_ordinal;
    if v_existing_id is distinct from v_evidence.evidence_id or
       v_existing_provider_subject_ref is distinct from v_item->>'providerSubjectRef' then
      raise exception 'compliance event evidence ordinal or provider subject was reused'
        using errcode = '22023';
    end if;
    v_ids := array_append(v_ids, v_evidence.evidence_id);
  end loop;

  select count(*)::integer into v_link_count
  from money.compliance_event_evidence
  where inbox_id = p_inbox_id;
  if v_link_count <> cardinality(v_ids) then
    raise exception 'compliance event evidence set changed on replay' using errcode = '22023';
  end if;

  v_primary_id := v_ids[1];
  if v_was_completed then
    if v_event.evidence_id is distinct from v_primary_id then
      raise exception 'completed compliance event has different primary evidence' using errcode = '22023';
    end if;
  else
    update money.compliance_event_inbox set
      state = 'completed', evidence_id = v_primary_id,
      completed_at = clock_timestamp(), locked_by = null, locked_at = null,
      last_error = null, updated_at = clock_timestamp()
    where id = p_inbox_id;
  end if;

  select * into v_subject
  from money.compliance_subjects
  where account_id = v_subject_id;
  return query select
    v_primary_id, v_ids, v_subject.state, v_subject.screening_state, v_was_completed;
end;
$$;

revoke all on function money_private.record_compliance_event_evidence_set(text,bigint,jsonb)
  from public;

-- The former worker flow recorded evidence and completed the inbox claim in
-- separate statements. Nothing uses that split-phase completion primitive
-- after this migration; remove it instead of relying only on role revocation.
drop function money_private.complete_compliance_event(text,bigint,uuid);
