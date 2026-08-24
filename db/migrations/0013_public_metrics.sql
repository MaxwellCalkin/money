-- Public wash-proof metrics. The receipts journal is the product's honesty
-- instrument: this migration adds the read-only public surface behind the
-- metrics page — two SECURITY DEFINER entry points plus the incrementally
-- maintained aggregate cache they read. Everything published is an aggregate
-- or chain evidence — never an account id, handle, memo, payee, merchant
-- descriptor, or individual transfer row — and the funding-lineage split
-- labels founder/sandbox-funded traffic instead of hiding it.
--
-- Definitions (documented for third parties in docs/METRICS.md):
--   * Operation classes partition money.transfers.operation:
--       funding   = 'fund' (the development/sandbox funding path)
--       treasury  = 'funding_settlement' | 'funding_return' | 'payout_hold'
--                   | 'payout_reversal' (provider-verified settlement rail)
--       card      = 'card_reserve' | 'card_release' | 'card_refund'
--       external  = 'external_debit' | 'external_reversal' (x402)
--       internal  = everything else ('pay', 'allocate', 'refund')
--   * Weeks are ISO weeks in UTC (Monday start), capped at the most recent
--     26 weeks.
--   * The chain root is CHAINED and cumulative: root_0 is the empty byte
--     string and root_i = sha256(root_{i-1} || evidence_hash_i) over receipts
--     in transfer_seq order. The published root for a week is the chain value
--     after the last receipt belonging to that week or earlier — any receipt
--     holder who saved earlier roots can re-derive inclusion, and the chained
--     form lets the server advance a checkpoint instead of re-hashing the
--     whole journal on every refresh.
--   * Funding lineage is conservative against ourselves: spend that cannot
--     be traced to provider-verified external settlement counts as
--     dev/sandbox-funded, never the reverse. External funding is net of
--     returns AND net of payouts, so settle -> payout -> re-settle cycles
--     cannot inflate the external bucket; spend is net of card releases,
--     card refunds, and marketplace refunds, so a fully released reservation
--     or refunded purchase drops back out. Money an agent receives from a
--     DIFFERENT owner family's agent ('pay' credits across families) counts
--     as dev/sandbox funding for the recipient family: peer income can never
--     manufacture external lineage, so a seller-funded (or founder-funded)
--     buyer stays labeled. As a final backstop, each family's externally
--     attributed spend is capped at the external settlement it actually
--     received. (Marketplace 'refund' credits are NOT peer income: the kernel
--     locks them to the original payer and caps them at the original receipt,
--     so they restore that family's own prior spend — they net out of the
--     spend side instead.)
--
-- The metrics_* tables below are derived caches, rebuildable from the
-- journal; they are deliberately NOT append-only and hold no authority.
-- Grants live exclusively in db/roles.sql; the helper internals below are
-- granted to no role at all.

create table money.metrics_chain_checkpoint (
  id boolean primary key default true check (id),
  last_transfer_seq bigint not null default 0,
  chain_root bytea not null default ''::bytea,
  updated_at timestamptz not null default clock_timestamp()
);

insert into money.metrics_chain_checkpoint (id) values (true);

create table money.metrics_weekly (
  week_start date primary key,
  transfers bigint not null default 0,
  volume_micros numeric not null default 0,
  chain_root bytea not null,
  last_transfer_seq bigint not null
);

create table money.metrics_week_agents (
  week_start date not null,
  agent_account_id text not null,
  primary key (week_start, agent_account_id)
);

-- Each agent's first active ISO week, maintained in the same checkpoint pass,
-- so cohort refreshes never re-aggregate the whole (week, agent) history.
create table money.metrics_agent_first_week (
  agent_account_id text primary key,
  first_week date not null
);

create index metrics_agent_first_week_week_idx
  on money.metrics_agent_first_week (first_week);

-- Running totals per operation class: public_metrics() reads exactly these
-- five rows instead of scanning money.transfers.
create table money.metrics_class_totals (
  operation_class text primary key
    check (operation_class in ('internal', 'external', 'card', 'treasury', 'funding')),
  transfers bigint not null default 0,
  volume_micros numeric not null default 0
);

insert into money.metrics_class_totals (operation_class)
values ('internal'), ('external'), ('card'), ('treasury'), ('funding');

-- Distinct-id sets plus a counts row, advanced by insert-on-conflict in the
-- checkpoint pass: the published distinct counts are O(1) reads.
create table money.metrics_funded_agents (
  agent_account_id text primary key
);

create table money.metrics_paid_providers (
  provider_account_id text primary key
);

create table money.metrics_counts (
  id boolean primary key default true check (id),
  funded_agents bigint not null default 0,
  paid_providers bigint not null default 0
);

insert into money.metrics_counts (id) values (true);

-- Per-owner-family funding/spend components for the lineage split. The
-- derived global totals row below is adjusted by delta whenever a family's
-- components change, so the published split is a single-row read.
create table money.metrics_owner_lineage (
  owner_id text primary key,
  fund_micros numeric not null default 0,
  peer_micros numeric not null default 0,
  settle_micros numeric not null default 0,
  return_micros numeric not null default 0,
  hold_micros numeric not null default 0,
  reversal_micros numeric not null default 0,
  spend_gross_micros numeric not null default 0,
  spend_back_micros numeric not null default 0
);

create table money.metrics_lineage_totals (
  id boolean primary key default true check (id),
  dev_funding_micros numeric not null default 0,
  external_funding_micros numeric not null default 0,
  spend_micros numeric not null default 0,
  external_attributed_micros numeric not null default 0
);

insert into money.metrics_lineage_totals (id) values (true);

create or replace function money_private.metrics_operation_class(p_operation text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when p_operation = 'fund' then 'funding'
    when p_operation in ('funding_settlement', 'funding_return', 'payout_hold', 'payout_reversal')
      then 'treasury'
    when p_operation in ('card_reserve', 'card_release', 'card_refund') then 'card'
    when p_operation in ('external_debit', 'external_reversal') then 'external'
    else 'internal'
  end
$$;

create or replace function money_private.metrics_week_bucket(p_at timestamptz)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (date_trunc('week', (p_at at time zone 'utc')))::date
$$;

-- Derived lineage values for one owner family's components. Kept in one
-- place so the per-family rollup and the delta-maintained totals can never
-- disagree: dev funding is 'fund' credits plus cross-family peer income;
-- external funding is settlement net of returns and net of outstanding
-- payouts, floored at zero; spend is gross spend net of releases/refunds,
-- floored at zero; the externally attributed share is proportional, rounded
-- DOWN, and capped at the external settlement the family actually received.
create function money_private.metrics_lineage_derived(
  p_fund numeric, p_peer numeric, p_settle numeric, p_return numeric,
  p_hold numeric, p_reversal numeric, p_gross numeric, p_back numeric,
  out dev_micros numeric, out external_micros numeric,
  out spend_micros numeric, out external_attributed numeric
)
language sql
immutable
security definer
set search_path = ''
as $$
  select d.dev, d.ext, d.spend,
    case when d.dev + d.ext > 0
      then least(floor(d.spend * d.ext / (d.dev + d.ext)), d.ext)
      else 0::numeric
    end
  from (
    select p_fund + p_peer as dev,
      greatest(p_settle - p_return - greatest(p_hold - p_reversal, 0), 0) as ext,
      greatest(p_gross - p_back, 0) as spend
  ) d
$$;

-- Apply component deltas to one owner family's lineage rollup and adjust the
-- global totals row by the change in that family's derived values. Called
-- only from metrics_advance_chain, which holds the checkpoint row lock, so
-- applications are serialized.
create function money_private.metrics_lineage_apply(
  p_owner_id text,
  p_fund numeric, p_peer numeric, p_settle numeric, p_return numeric,
  p_hold numeric, p_reversal numeric, p_gross numeric, p_back numeric
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row money.metrics_owner_lineage%rowtype;
  v_old record;
  v_new record;
begin
  insert into money.metrics_owner_lineage (owner_id) values (p_owner_id)
  on conflict (owner_id) do nothing;
  select * into v_row from money.metrics_owner_lineage l
  where l.owner_id = p_owner_id
  for update;

  select * into v_old from money_private.metrics_lineage_derived(
    v_row.fund_micros, v_row.peer_micros, v_row.settle_micros, v_row.return_micros,
    v_row.hold_micros, v_row.reversal_micros,
    v_row.spend_gross_micros, v_row.spend_back_micros);

  update money.metrics_owner_lineage set
    fund_micros = fund_micros + coalesce(p_fund, 0),
    peer_micros = peer_micros + coalesce(p_peer, 0),
    settle_micros = settle_micros + coalesce(p_settle, 0),
    return_micros = return_micros + coalesce(p_return, 0),
    hold_micros = hold_micros + coalesce(p_hold, 0),
    reversal_micros = reversal_micros + coalesce(p_reversal, 0),
    spend_gross_micros = spend_gross_micros + coalesce(p_gross, 0),
    spend_back_micros = spend_back_micros + coalesce(p_back, 0)
  where owner_id = p_owner_id;

  select * into v_new from money_private.metrics_lineage_derived(
    v_row.fund_micros + coalesce(p_fund, 0), v_row.peer_micros + coalesce(p_peer, 0),
    v_row.settle_micros + coalesce(p_settle, 0), v_row.return_micros + coalesce(p_return, 0),
    v_row.hold_micros + coalesce(p_hold, 0), v_row.reversal_micros + coalesce(p_reversal, 0),
    v_row.spend_gross_micros + coalesce(p_gross, 0), v_row.spend_back_micros + coalesce(p_back, 0));

  update money.metrics_lineage_totals set
    dev_funding_micros = dev_funding_micros + (v_new.dev_micros - v_old.dev_micros),
    external_funding_micros = external_funding_micros + (v_new.external_micros - v_old.external_micros),
    spend_micros = spend_micros + (v_new.spend_micros - v_old.spend_micros),
    external_attributed_micros =
      external_attributed_micros + (v_new.external_attributed - v_old.external_attributed)
  where id;
end;
$$;

-- Advance the chained root checkpoint over at most p_max_rows receipts newer
-- than the checkpoint, in transfer_seq order (index-driven: receipts has a
-- unique index on transfer_seq). The same single pass maintains EVERY derived
-- cache — the per-week transfer/volume aggregates, the distinct-active-agent
-- sets and each agent's first active week, the per-class running totals, the
-- distinct funded-agent/paid-provider id sets and counts, and the per-family
-- funding-lineage rollup with its delta-maintained totals row — so a refresh
-- never re-scans history: work per call is bounded by the batch size, and the
-- caches are deterministic functions of the journal.
create function money_private.metrics_advance_chain(p_max_rows integer)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_max_rows, 5000), 1), 10000);
  v_seq bigint;
  v_root bytea;
  v_week date;
  v_class text;
  v_row record;
  v_count integer := 0;
begin
  select c.last_transfer_seq, c.chain_root
    into v_seq, v_root
  from money.metrics_chain_checkpoint c
  where c.id
  for update;

  for v_row in
    select r.transfer_seq, r.evidence_hash, t.created_at, t.amount_micros,
        t.operation, t.from_account_id, t.to_account_id,
        fa.kind as from_kind,
        case when fa.kind = 'user' then fa.id else fa.owner_id end as from_family,
        ta.kind as to_kind,
        case when ta.kind = 'user' then ta.id else ta.owner_id end as to_family
    from money.receipts r
    join money.transfers t on t.seq = r.transfer_seq
    left join money.accounts fa on fa.id = t.from_account_id
    left join money.accounts ta on ta.id = t.to_account_id
    where r.transfer_seq > v_seq
    order by r.transfer_seq
    limit v_limit
  loop
    v_root := public.digest(v_root || v_row.evidence_hash, 'sha256');
    v_seq := v_row.transfer_seq;
    v_week := money_private.metrics_week_bucket(v_row.created_at);
    v_class := money_private.metrics_operation_class(v_row.operation);

    insert into money.metrics_weekly as w
      (week_start, transfers, volume_micros, chain_root, last_transfer_seq)
    values (v_week, 1, v_row.amount_micros, v_root, v_seq)
    on conflict (week_start) do update set
      transfers = w.transfers + 1,
      volume_micros = w.volume_micros + excluded.volume_micros,
      chain_root = excluded.chain_root,
      last_transfer_seq = excluded.last_transfer_seq;

    update money.metrics_class_totals set
      transfers = transfers + 1,
      volume_micros = volume_micros + v_row.amount_micros
    where operation_class = v_class;

    if v_row.from_kind = 'agent' then
      insert into money.metrics_week_agents (week_start, agent_account_id)
      values (v_week, v_row.from_account_id)
      on conflict do nothing;
      insert into money.metrics_agent_first_week as fw (agent_account_id, first_week)
      values (v_row.from_account_id, v_week)
      on conflict (agent_account_id) do update
        set first_week = least(fw.first_week, excluded.first_week);
    end if;

    if v_row.operation = 'allocate' and v_row.to_kind = 'agent' then
      insert into money.metrics_funded_agents (agent_account_id)
      values (v_row.to_account_id)
      on conflict do nothing;
      if found then
        update money.metrics_counts set funded_agents = funded_agents + 1 where id;
      end if;
    end if;

    if v_row.to_kind = 'provider' then
      insert into money.metrics_paid_providers (provider_account_id)
      values (v_row.to_account_id)
      on conflict do nothing;
      if found then
        update money.metrics_counts set paid_providers = paid_providers + 1 where id;
      end if;
    end if;

    -- Funding-side lineage components, keyed by owner family (a user account
    -- is its own family; agents and providers roll up to their owner).
    if v_row.operation = 'fund' and v_row.to_family is not null then
      perform money_private.metrics_lineage_apply(
        v_row.to_family, v_row.amount_micros, 0, 0, 0, 0, 0, 0, 0);
    elsif v_row.operation = 'funding_settlement' and v_row.to_family is not null then
      perform money_private.metrics_lineage_apply(
        v_row.to_family, 0, 0, v_row.amount_micros, 0, 0, 0, 0, 0);
    elsif v_row.operation = 'funding_return' and v_row.from_family is not null then
      perform money_private.metrics_lineage_apply(
        v_row.from_family, 0, 0, 0, v_row.amount_micros, 0, 0, 0, 0);
    elsif v_row.operation = 'payout_hold' and v_row.from_family is not null then
      perform money_private.metrics_lineage_apply(
        v_row.from_family, 0, 0, 0, 0, v_row.amount_micros, 0, 0, 0);
    elsif v_row.operation = 'payout_reversal' and v_row.to_family is not null then
      perform money_private.metrics_lineage_apply(
        v_row.to_family, 0, 0, 0, 0, 0, v_row.amount_micros, 0, 0);
    end if;

    -- Spend-side components: agent spend counts gross for the spender's
    -- family; card releases/refunds and marketplace refunds (kernel-locked to
    -- the original payer, receipt-capped) net back out.
    if v_row.from_kind = 'agent' and v_row.from_family is not null
       and v_row.operation in ('pay', 'external_debit', 'card_reserve') then
      perform money_private.metrics_lineage_apply(
        v_row.from_family, 0, 0, 0, 0, 0, 0, v_row.amount_micros, 0);
    end if;
    if v_row.to_kind = 'agent' and v_row.to_family is not null
       and v_row.operation in ('card_release', 'card_refund', 'refund') then
      perform money_private.metrics_lineage_apply(
        v_row.to_family, 0, 0, 0, 0, 0, 0, 0, v_row.amount_micros);
    end if;

    -- Cross-family peer income: a 'pay' credited to an agent of a DIFFERENT
    -- owner family is presumed dev-lineage income for the recipient family —
    -- a seller- or founder-funded buyer cannot launder that money into the
    -- external bucket by re-spending it.
    if v_row.operation = 'pay' and v_row.to_kind = 'agent'
       and v_row.to_family is not null
       and v_row.to_family is distinct from v_row.from_family then
      perform money_private.metrics_lineage_apply(
        v_row.to_family, 0, v_row.amount_micros, 0, 0, 0, 0, 0, 0);
    end if;

    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    update money.metrics_chain_checkpoint c
      set last_transfer_seq = v_seq, chain_root = v_root, updated_at = clock_timestamp()
    where c.id;
  end if;
  return v_count;
end;
$$;

-- Weekly aggregates plus the cumulative chained root, oldest week first, read
-- from the incrementally maintained cache: at most 26 indexed row lookups.
-- Honest zero weeks are emitted rather than skipped and carry the previous
-- week's root forward.
create or replace function money_private.metrics_weekly_series(p_weeks integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_weeks integer := least(greatest(coalesce(p_weeks, 26), 1), 26);
  v_current_week date := (date_trunc('week', (clock_timestamp() at time zone 'utc')))::date;
  v_first_week date;
  v_start_week date;
  v_week_start date;
  v_transfers bigint;
  v_volume numeric;
  v_active bigint;
  v_root bytea;
  v_series jsonb := '[]'::jsonb;
begin
  select min(w.week_start) into v_first_week from money.metrics_weekly w;
  if v_first_week is null then
    return '[]'::jsonb;
  end if;
  v_start_week := greatest(v_first_week, v_current_week - (v_weeks - 1) * 7);

  for v_week_start in
    select generate_series(v_start_week::timestamp, v_current_week::timestamp, interval '7 days')::date
    limit 26
  loop
    select coalesce(w.transfers, 0), coalesce(w.volume_micros, 0)
      into v_transfers, v_volume
    from (values (1)) as one(x)
    left join money.metrics_weekly w on w.week_start = v_week_start;

    select count(*)::bigint into v_active
    from money.metrics_week_agents wa
    where wa.week_start = v_week_start;

    -- The chained root as of this week's end: the cache row for the latest
    -- week at or before it. Empty weeks inherit the previous root.
    select w.chain_root into v_root
    from money.metrics_weekly w
    where w.week_start <= v_week_start
    order by w.week_start desc
    limit 1;

    v_series := v_series || jsonb_build_object(
      'week', to_char(v_week_start, 'IYYY-"W"IW'),
      'weekStart', to_char(v_week_start, 'YYYY-MM-DD'),
      'transfers', v_transfers,
      'volumeMicros', v_volume::text,
      'activeAgents', v_active,
      'chainRoot', encode(coalesce(v_root, public.digest(''::bytea, 'sha256')), 'hex')
    );
  end loop;
  return v_series;
end;
$$;

-- The single public aggregate document. Counts, class totals, the weekly
-- series with chain roots, retention cohorts, and the funding-lineage split;
-- account-level data never appears in the output by construction. Volatile:
-- each call first advances the chain checkpoint over a bounded batch of new
-- receipts (the only write on this surface — to the derived caches above).
create or replace function money_private.public_metrics()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_advanced integer;
  v_rounds integer := 0;
  v_funded_agents bigint;
  v_paid_providers bigint;
  v_classes jsonb;
  v_lineage jsonb;
  v_cohorts jsonb;
  v_current_week date := (date_trunc('week', (clock_timestamp() at time zone 'utc')))::date;
  v_first_week date;
  v_start_week date;
begin
  -- Catch the caches up over bounded batches. Work per refresh is capped at
  -- 12 x 5000 receipts; a large backlog converges across refreshes instead of
  -- blowing the statement timeout.
  loop
    v_advanced := money_private.metrics_advance_chain(5000);
    v_rounds := v_rounds + 1;
    exit when v_advanced < 5000 or v_rounds >= 12;
  end loop;

  -- Distinct funded agents (ever received an owner allocation) and distinct
  -- paid providers (ever actually paid — registering a listing without
  -- traffic does not count): one cache row, maintained by the checkpoint.
  select c.funded_agents, c.paid_providers
    into v_funded_agents, v_paid_providers
  from money.metrics_counts c
  where c.id;

  select jsonb_agg(jsonb_build_object(
      'operationClass', s.operation_class,
      'transfers', s.transfers,
      'volumeMicros', s.volume_micros::text
    ) order by c.ord)
    into v_classes
  from (values ('internal', 1), ('external', 2), ('card', 3), ('treasury', 4), ('funding', 5))
    as c(class, ord)
  join money.metrics_class_totals s on s.operation_class = c.class;

  -- Funding lineage, from the delta-maintained totals row (the derivation —
  -- external settlement net of returns and payouts, cross-family peer income
  -- into the dev bucket, spend net of card releases/refunds and marketplace
  -- refunds, proportional attribution rounded DOWN and capped at received
  -- external settlement — lives in metrics_lineage_derived and is applied
  -- per family by the checkpoint pass): a single-row read.
  select jsonb_build_object(
      'devFundingMicros', t.dev_funding_micros::text,
      'externalFundingMicros', t.external_funding_micros::text,
      'spendMicros', t.spend_micros::text,
      'devAttributedSpendMicros', (t.spend_micros - t.external_attributed_micros)::text,
      'externalAttributedSpendMicros', t.external_attributed_micros::text
    )
    into v_lineage
  from money.metrics_lineage_totals t
  where t.id;

  -- Retention cohorts over the same capped window: an agent's cohort is its
  -- first active ISO week (first spend-side transfer, since genesis, read
  -- from the checkpoint-maintained first-week cache), and activeByWeek[k]
  -- counts cohort members active k weeks later. Aggregate counts only; both
  -- caches are read only inside the 26-week window, never over full history
  -- and never from the journal.
  select min(w.week_start) into v_first_week from money.metrics_weekly w;
  v_start_week := greatest(coalesce(v_first_week, v_current_week), v_current_week - 25 * 7);
  with cohorts as (
    select f.first_week as cohort_week, count(*)::bigint as cohort_size
    from money.metrics_agent_first_week f
    where f.first_week between v_start_week and v_current_week
    group by f.first_week
    order by f.first_week
    limit 26
  ),
  cells as (
    select f.first_week as cohort_week,
      ((wa.week_start - f.first_week) / 7)::int as off,
      count(*)::bigint as agents
    from money.metrics_week_agents wa
    join money.metrics_agent_first_week f on f.agent_account_id = wa.agent_account_id
    where f.first_week between v_start_week and v_current_week
      and wa.week_start between v_start_week and v_current_week
    group by 1, 2
  ),
  grid as (
    select c.cohort_week, c.cohort_size, o.off, coalesce(x.agents, 0) as agents
    from cohorts c
    cross join lateral generate_series(0, least((v_current_week - c.cohort_week) / 7, 25)) as o(off)
    left join cells x on x.cohort_week = c.cohort_week and x.off = o.off
  )
  select coalesce(jsonb_agg(row_obj order by cohort_week), '[]'::jsonb)
    into v_cohorts
  from (
    select g.cohort_week,
      jsonb_build_object(
        'cohortWeek', to_char(g.cohort_week, 'IYYY-"W"IW'),
        'weekStart', to_char(g.cohort_week, 'YYYY-MM-DD'),
        'cohortSize', g.cohort_size,
        'activeByWeek', jsonb_agg(g.agents order by g.off)
      ) as row_obj
    from grid g
    group by g.cohort_week, g.cohort_size
  ) cohort_rows;

  return jsonb_build_object(
    'generatedAt', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'distinctFundedAgents', coalesce(v_funded_agents, 0),
    'distinctPaidProviders', coalesce(v_paid_providers, 0),
    'operationClasses', v_classes,
    'fundingLineage', v_lineage,
    'weekly', money_private.metrics_weekly_series(26),
    'cohorts', v_cohorts
  );
end;
$$;

-- Receipt inclusion verification: lookup by exact unguessable receipt uuid
-- only — there is deliberately no listing or enumeration surface. Returns
-- chain evidence and NOTHING else: no parties, no amount, no memo, no
-- timestamp beyond the ISO week bucket.
create or replace function money_private.verify_receipt(p_receipt_id uuid)
returns table (
  receipt_exists boolean,
  transfer_seq bigint,
  evidence_hash_hex text,
  operation_class text,
  week_bucket text
)
language sql
stable
security definer
set search_path = ''
as $$
  select true,
    r.transfer_seq,
    encode(r.evidence_hash, 'hex'),
    money_private.metrics_operation_class(t.operation),
    to_char(money_private.metrics_week_bucket(t.created_at), 'IYYY-"W"IW')
  from money.receipts r
  join money.transfers t on t.seq = r.transfer_seq
  where r.id = p_receipt_id
  limit 1
$$;

revoke all on function
  money_private.metrics_operation_class(text),
  money_private.metrics_week_bucket(timestamptz),
  money_private.metrics_lineage_derived(numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric),
  money_private.metrics_lineage_apply(text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric),
  money_private.metrics_advance_chain(integer),
  money_private.metrics_weekly_series(integer),
  money_private.public_metrics(),
  money_private.verify_receipt(uuid)
from public;

comment on function money_private.public_metrics()
is 'Public wash-proof aggregates: distinct counts, per-class totals, funding-lineage split, retention cohorts, and the 26-week series with cumulative chained receipt roots. Advances the bounded metrics cache checkpoint on each call. Grant EXECUTE only to money_metrics (and money_ops for pre-publication checks).';

comment on function money_private.verify_receipt(uuid)
is 'Receipt inclusion lookup by exact uuid: {exists, transferSeq, evidenceHash, operationClass, weekBucket} and nothing else. No enumeration surface exists.';
