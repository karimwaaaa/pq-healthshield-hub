-- ============================================================
-- [COMPANY_NAME] Hub — migration for the "assign encoder first, generate
-- password later" workflow + the new Activity Log feature.
--
-- Run this in: Supabase Dashboard → SQL Editor → New query.
-- Safe to run once on your existing project — it does NOT touch any
-- existing rows in users/clients/assignments/sessions.
-- ============================================================

-- 1) Allow a "pending" encoder: assigned to a client, but no password
--    generated yet. Previously password_hash was NOT NULL, which made this
--    impossible — an admin had to generate a password before an encoder
--    could exist at all.
alter table users alter column password_hash drop not null;

-- 2) Activity log for the small "History" drawer in the VxSync and
--    Password Management tabs. One row per action, human-readable message
--    pre-formatted with the timestamp baked in (so wording matches exactly
--    what you asked for, regardless of the reader's timezone settings).
create table if not exists audit_log (
  id bigint generated always as identity primary key,
  category text not null check (category in ('vxsync', 'password')),
  message text not null,
  created_at timestamptz not null default now()
);

alter table audit_log enable row level security;
-- No policies created, same as every other table — locked down except
-- through the Edge Function's service_role connection.

-- Same reasoning as add_assignments.sql: this project has "automatically
-- expose new tables" disabled, so every new table needs its grants spelled
-- out explicitly for service_role or the function gets "permission denied".
grant select, insert, update, delete on public.audit_log to service_role;
grant usage, select on all sequences in schema public to service_role;
