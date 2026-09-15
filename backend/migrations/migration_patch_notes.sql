-- ============================================================
-- [COMPANY_NAME] Hub — migration for Patch Notes ("what's changed" banner)
--
-- Bug reports do NOT need a schema change — they're a pure email-to-IT
-- path (see reportBug / reportBugFromVxSync in api_index.ts) and are
-- never stored in help_tickets, so there is nothing to migrate for that
-- feature.
--
-- Run this in: Supabase Dashboard -> SQL Editor -> New query.
-- Safe to run once; does not touch existing rows.
-- ============================================================

-- Patch notes. One row per posted update. Only IT Support can create
-- these (enforced app-side in api_index.ts's createPatchNotes action).
create table if not exists patch_notes (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  published_by_name text
);

alter table patch_notes enable row level security;
grant select, insert, update, delete on public.patch_notes to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Tracks the last patch note each Hub user has already seen/dismissed, so
-- the "what's new" popup only ever shows once per person (server-side, so
-- it follows the account across devices/browsers) — not once per login.
-- The small "What's New" sidebar link works separately from this column
-- (it re-fetches the latest note on demand, with no ack), so people can
-- always look the latest note up again after they've dismissed the popup.
alter table users add column if not exists last_seen_patch_notes_id bigint not null default 0;
