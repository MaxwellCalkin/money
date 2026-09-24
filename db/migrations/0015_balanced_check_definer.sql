-- The ledger's zero-sum check (0001) is a DEFERRED constraint trigger, so it
-- runs at COMMIT, after the SECURITY DEFINER posting functions have returned.
-- PostgreSQL 18 executes such triggers as the role that queued the event (the
-- definer); PostgreSQL 17 and earlier execute them as the role active at
-- COMMIT, i.e. the least-privilege login that called the posting function.
-- Those logins hold no SELECT on money.ledger_entries or money.transfers by
-- design, so on 17 every posting committed through the product API failed with
-- 42501 at commit (first seen on the hosted beta, Supabase Postgres 17.6).
-- The check only reads the two journal tables and raises; running it with its
-- owner's rights (the migrating identity that owns them) widens nothing a
-- caller can reach, and makes the rule behave the same on 17 and 18. The
-- function already pins search_path to ''.
alter function money_private.assert_balanced_transfer() security definer;
revoke all on function money_private.assert_balanced_transfer() from public;
