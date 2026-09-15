-- ============================================================
-- [COMPANY_NAME] Hub - migration for: Help Ticket priority levels.
--
-- Run this in: Supabase Dashboard > SQL Editor > New query.
-- Safe to run once on your existing project - it does NOT touch any
-- existing rows other than backfilling this one new column to 'normal'.
-- ============================================================

alter table help_tickets add column if not exists priority text not null default 'normal'
  check (priority in ('low', 'normal', 'high', 'urgent'));
