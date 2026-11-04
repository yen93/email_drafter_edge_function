-- Daily cron that re-arms the Gmail watch (it expires <= 7 days).
-- Run this AFTER the functions are deployed and secrets are set. Requires the
-- pg_cron and pg_net extensions (enable them in Dashboard -> Database ->
-- Extensions if they aren't already on — this project already uses cron for its
-- other *-sync functions, so they likely are).
--
-- Replace <PROJECT_REF> and <PUSH_SHARED_SECRET> before running.

-- enable once (no-op if already enabled)
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- re-arm every day at 02:00 UTC (well inside the 7-day expiry window)
select cron.schedule(
  'renew-gmail-watch-daily',
  '0 2 * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/renew-gmail-watch?token=<PUSH_SHARED_SECRET>',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- To inspect or remove later:
--   select * from cron.job;
--   select cron.unschedule('renew-gmail-watch-daily');
