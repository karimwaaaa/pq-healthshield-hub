-- ============================================================
-- [COMPANY_NAME] Hub — fixes deleting an admin/IT Support account failing with:
--   "update or delete on table users violates foreign key constraint
--    password_reset_requests_approved_by_user_id_fkey"
--
-- ROOT CAUSE: three FK columns added in migration_email_features.sql
-- reference users(id) with NO "on delete" behavior specified, which
-- Postgres defaults to NO ACTION — i.e. it refuses to delete a user row
-- as long as ANYTHING still points at it. Any account that has ever
-- approved a password reset, submitted a help ticket, or resolved a help
-- ticket becomes permanently undeletable until that historical row is
-- dealt with. This isn't specific to your IT Support account — it will
-- hit the next account you try to remove too, the moment it has any of
-- that history.
--
-- FIX: switch those three columns to "on delete set null". The
-- request/ticket rows themselves are kept (this is audit history — you
-- don't want a password-reset log or a support ticket to vanish just
-- because the account involved was later deleted); only the dangling
-- reference to the now-gone user is cleared. This is safe to do because:
--   - password_reset_requests already stores approved_by_name (text) —
--     the human-readable "who approved this" survives even after
--     approved_by_user_id goes null.
--   - help_tickets already stores submitter_email/submitter_name (text) —
--     same deal for who submitted a ticket.
--   - help_tickets.resolved_by_user_id has no equivalent text column and
--     isn't currently shown anywhere in the Hub UI (getHelpTickets never
--     selects it), so nulling it loses nothing that's actually visible
--     today. If you'd like "resolved by" to show up in the ticket inbox
--     going forward, say so and I'll add a resolved_by_name column plus
--     the two-line api_index.ts change to populate/return it — same
--     pattern as approved_by_name.
--
-- Run this in: Supabase Dashboard → SQL Editor → New query.
-- Safe to run once; does not touch any existing row's data.
-- ============================================================

alter table password_reset_requests
  drop constraint if exists password_reset_requests_approved_by_user_id_fkey;
alter table password_reset_requests
  add constraint password_reset_requests_approved_by_user_id_fkey
  foreign key (approved_by_user_id) references users(id) on delete set null;

alter table help_tickets
  drop constraint if exists help_tickets_submitter_user_id_fkey;
alter table help_tickets
  add constraint help_tickets_submitter_user_id_fkey
  foreign key (submitter_user_id) references users(id) on delete set null;

alter table help_tickets
  drop constraint if exists help_tickets_resolved_by_user_id_fkey;
alter table help_tickets
  add constraint help_tickets_resolved_by_user_id_fkey
  foreign key (resolved_by_user_id) references users(id) on delete set null;
