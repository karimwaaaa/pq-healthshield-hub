-- ============================================================
-- [COMPANY_NAME] Hub - migration for: Help Ticket archiving (the drag-to-
-- archive sidebar) and in-app "your ticket was resolved" notifications.
--
-- Run this in: Supabase Dashboard > SQL Editor > New query.
-- Safe to run once on your existing project - it does NOT touch any
-- existing rows other than backfilling these two new columns to their
-- defaults (archived = false, submitter_notified = false).
-- ============================================================

alter table help_tickets add column if not exists archived boolean not null default false;
alter table help_tickets add column if not exists submitter_notified boolean not null default false;
