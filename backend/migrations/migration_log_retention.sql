-- ============================================================
-- [COMPANY_NAME] Hub — automatic log/ticket/password-reset retention.
--
-- WHY THIS EXISTS: the actual fix for "don't let Supabase hit its
-- storage limit" is pruning old rows, not moving them to a second
-- service. See the sizing math in the chat response — at realistic
-- volumes this alone keeps you comfortably under the Free plan's 500 MB
-- for years. Do this FIRST; only reach for a second database if you
-- later have real evidence (checked via Database -> Database size in
-- the Supabase dashboard) that you're actually approaching the ceiling.
--
-- WHAT IT PRUNES AND WHY THESE WINDOWS:
--   - audit_log:   full detail kept 180 days, then deleted. This is Hub
--     USAGE history (who did what in the Hub UI) — not clinical
--     vaccination data (that lives entirely in each client's Google
--     Sheet via VxSync and is untouched by this). Adjust the window if
--     your org has a specific internal policy for how long admin
--     activity logs must be retrievable; 180 days is a reasonable
--     default, not a compliance-verified number — confirm before relying
--     on it if this ever matters for an audit.
--   - password_reset_requests / password_reset_approvals: these are
--     inherently short-lived (each request already has its own
--     expires_at). Anything sitting in a final state (used/expired) for
--     more than 30 days is pruned. password_reset_approvals rows
--     cascade-delete automatically when their parent request is deleted
--     (see "on delete cascade" in migration_email_features.sql), so
--     pruning the parent table is enough.
--   - help_tickets: resolved tickets are kept 1 year, then pruned. This
--     table grows the slowest of the three (people file tickets far
--     less often than the system logs activity), so it's the least
--     urgent to prune — the window is generous on purpose.
--
-- These numbers are starting points, not fixed law — change the
-- interval literals below any time via the Supabase SQL Editor, no
-- redeploy needed:
--   select cron.alter_job(job_id, schedule => '...') -- to change timing
-- or just re-run this whole file (cron.schedule below is idempotent per
-- job name — it replaces a job with the same name).
--
-- Run this in: Supabase Dashboard -> SQL Editor -> New query.
-- ============================================================

-- pg_cron ships with Supabase but isn't always enabled by default on a
-- given project — this is safe to run even if it's already on.
create extension if not exists pg_cron;

-- Nightly at 03:00 UTC (adjust the cron expression to your timezone's
-- offset if you want it to land at a specific local off-peak hour).
select cron.schedule(
  'prune-audit-log',
  '0 3 * * *',
  $$ delete from audit_log where created_at < now() - interval '180 days' $$
);

select cron.schedule(
  'prune-password-reset-requests',
  '15 3 * * *',
  $$ delete from password_reset_requests
     where status in ('used', 'expired')
       and coalesce(completed_at, expires_at) < now() - interval '30 days' $$
);

select cron.schedule(
  'prune-resolved-help-tickets',
  '30 3 * * *',
  $$ delete from help_tickets
     where status = 'resolved'
       and resolved_at < now() - interval '365 days' $$
);

-- ------------------------------------------------------------
-- To check these ran (any time after they've fired at least once):
--   select * from cron.job_run_details order by start_time desc limit 20;
--
-- To change a window later, e.g. audit_log from 180 to 90 days:
--   select cron.schedule(
--     'prune-audit-log', '0 3 * * *',
--     $$ delete from audit_log where created_at < now() - interval '90 days' $$
--   );
--   (re-running cron.schedule with the same job name updates it in place)
--
-- To stop a job entirely:
--   select cron.unschedule('prune-audit-log');
-- ------------------------------------------------------------
