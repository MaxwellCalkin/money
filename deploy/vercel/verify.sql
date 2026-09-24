-- Vercel beta profile: read-only post-setup verification. Run as `postgres`
-- over the SESSION pooler after setup.sql, `npm run db:migrate`, db/roles.sql,
-- logins.sql and schedule.sql:
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f deploy/vercel/verify.sql
--
-- Every `ok` must read `t` except the rows marked "report only" (7, 10). Nothing here
-- prints a row of data, a secret, or a URL. Supabase-only (cron, vault, net,
-- auth and the API roles do not exist elsewhere).
with health as (
  select h.zero_sum, h.receipts_ok from money_private.ledger_health() h
)
select n, check_name, ok
from (values
  ( 1, 'setup-shim: public.digest answers',
       (select encode(public.digest('x', 'sha256'), 'hex') is not null)),
  ( 2, 'setup-shim: public.gen_random_uuid answers',
       (select public.gen_random_uuid() is not null)),
  ( 3, 'anon cannot select money.beta_waitlist',
       has_table_privilege('anon', 'money.beta_waitlist', 'select') = false),
  ( 4, 'anon cannot execute money_private.join_waitlist',
       has_function_privilege('anon', 'money_private.join_waitlist(text,text)', 'execute') = false),
  ( 5, 'anon has no usage on schema money',
       has_schema_privilege('anon', 'money', 'usage') = false),
  ( 6, 'anon has no usage on schema money_private',
       has_schema_privilege('anon', 'money_private', 'usage') = false),
  ( 7, 'report only: anon has usage on schema public (close it by removing public from the exposed schemas)',
       has_schema_privilege('anon', 'public', 'usage')),
  ( 8, 'backup login cannot reach cron.job (PUBLIC holds SELECT, but only postgres may enter the cron schema)',
       not (has_schema_privilege('money_backup_login', 'cron', 'usage')
            and has_table_privilege('money_backup_login', 'cron.job', 'select'))),
  ( 9, 'backup login cannot read vault.decrypted_secrets',
       has_table_privilege('money_backup_login', 'vault.decrypted_secrets', 'select') = false),
  (10, 'report only: every login reaches net.* (Supabase pg_net default: PUBLIC holds ALL plus USAGE on net, granted by supabase_admin; postgres cannot revoke it)',
       has_schema_privilege('money_backup_login', 'net', 'usage')
       and has_table_privilege('money_backup_login', 'net._http_response', 'select')),
  (11, 'backup login cannot read auth.users',
       has_table_privilege('money_backup_login', 'auth.users', 'select') = false),
  (12, 'backup login can select money.beta_waitlist (for pg_dump)',
       has_table_privilege('money_backup_login', 'money.beta_waitlist', 'select')),
  (13, 'backup login has its row-security policy on money.beta_waitlist',
       exists (select 1 from pg_policies
               where schemaname = 'money' and tablename = 'beta_waitlist'
                 and policyname = 'beta_waitlist_backup_read')),
  (14, 'backup login is not a member of pg_read_all_data',
       pg_has_role('money_backup_login', 'pg_read_all_data', 'member') = false),
  (15, 'money_app can execute money_private.join_waitlist',
       has_function_privilege('money_app', 'money_private.join_waitlist(text,text)', 'execute')),
  (16, 'money_worker can execute money_private.sweep_external_payments',
       has_function_privilege('money_worker', 'money_private.sweep_external_payments(integer)', 'execute')),
  (17, 'money_card_ingress can execute money_private.decide_card_authorization',
       has_function_privilege('money_card_ingress',
         'money_private.decide_card_authorization(text,text,text,text,bigint,text,text,text,text,integer)', 'execute')),
  (18, 'money_ops can execute money_private.record_ledger_health',
       has_function_privilege('money_ops', 'money_private.record_ledger_health()', 'execute')),
  (19, 'money_app can execute money_private.latest_ledger_health',
       has_function_privilege('money_app', 'money_private.latest_ledger_health()', 'execute')),
  (20, 'money_metrics can execute money_private.public_metrics',
       has_function_privilege('money_metrics', 'money_private.public_metrics()', 'execute')),
  (21, 'every login inherits its authority role',
       pg_has_role('money_app_login', 'money_app', 'member')
       and pg_has_role('money_worker_login', 'money_worker', 'member')
       and pg_has_role('money_card_ingress_login', 'money_card_ingress', 'member')
       and pg_has_role('money_ops_login', 'money_ops', 'member')
       and pg_has_role('money_metrics_login', 'money_metrics', 'member')),
  (22, 'schema head is 0015',
       (select max(version) from money.schema_migrations) = '0015'),
  (23, 'three money-* cron jobs are scheduled',
       (select count(*) from cron.job where jobname like 'money-%') = 3),
  (24, 'sweep key is in Vault',
       exists (select 1 from vault.secrets where name = 'money_sweep_key')),
  (25, 'beta_cron origin is a bare https origin',
       (select count(*) from beta_cron.settings
         where key = 'origin' and value ~ '^https://[a-z0-9.-]+$') = 1),
  (26, 'ledger_health: zero_sum',
       (select zero_sum from health)),
  (27, 'ledger_health: receipts_ok',
       (select receipts_ok from health)),
  (28, 'beta app login can post play-dollar funding (logins.sql)',
       has_function_privilege('money_app_login',
         'money_private.post_confirmed_funding(text,text,text,bigint,jsonb)', 'execute')),
  (29, 'money_app authority role still cannot post funding (production matrix intact)',
       has_function_privilege('money_app',
         'money_private.post_confirmed_funding(text,text,text,bigint,jsonb)', 'execute') = false)
) as checks (n, check_name, ok)
order by n;
