#!/bin/sh
# Applies db/roles.sql (idempotent, convergent revokes included) and binds the
# passworded beta login for the money_metrics role. The public-metrics service
# is the only internet-reachable process with zero request authentication, so
# it must never connect as the database owner: its identity can execute
# exactly two aggregate functions and select from no table.
set -eu

psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f /roles.sql

psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v pw="$BETA_METRICS_DB_PASSWORD" <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'money_metrics_login') then
    create role money_metrics_login login;
  end if;
end $$;
alter role money_metrics_login with login password :'pw';
grant money_metrics to money_metrics_login;
SQL
