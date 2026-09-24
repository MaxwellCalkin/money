-- Part 1 of deploy/vercel/setup.sql: the two scheduling extensions the cron
-- loop in deploy/vercel/schedule.sql needs. Supabase-only; `if not exists`
-- keeps it re-runnable. pg_cron is not relocatable and installs its own `cron`
-- schema; pg_net goes into `extensions` like every Supabase-managed extension.
-- The restore drill skips this file on purpose (a vanilla container has neither
-- extension and needs neither).
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
