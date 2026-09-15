-- ============================================================
-- [COMPANY_NAME] Hub — migration for: admin-only "Forgot Password" with
-- email approval, login lockout after 5 failed attempts, the "Contact IT
-- Support" ticket system, and the new "IT Support" role.
--
-- Run this in: Supabase Dashboard → SQL Editor → New query.
-- Safe to run once on your existing project — it does NOT touch any
-- existing rows in users/clients/assignments/sessions/audit_log.
-- ============================================================

-- 1) New role. Postgres check constraints can't be altered in place, so
--    drop and recreate it with 'it_support' added. This does not touch any
--    existing row's role value.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('admin', 'nurse', 'it_support'));

-- 2) Login lockout — 5 failed attempts locks the account until an admin/IT
--    Support clears it from the Admin Accounts panel.
alter table users add column if not exists failed_login_attempts int not null default 0;
alter table users add column if not exists login_locked boolean not null default false;

-- 3) Forgot-password admin-approval requests. One row per request; the
--    per-recipient approval links live in the table below so each admin's
--    email has a distinct, individually-trackable link.
create table if not exists password_reset_requests (
  id bigint generated always as identity primary key,
  requester_user_id uuid not null references users(id) on delete cascade,
  requester_email text not null,
  requester_display_name text not null,
  poll_token text not null unique,
  status text not null default 'pending' check (status in ('pending', 'approved', 'used', 'expired')),
  approved_by_user_id uuid references users(id),
  approved_by_name text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null
);

create table if not exists password_reset_approvals (
  id bigint generated always as identity primary key,
  request_id bigint not null references password_reset_requests(id) on delete cascade,
  admin_user_id uuid not null references users(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now()
);

alter table password_reset_requests enable row level security;
alter table password_reset_approvals enable row level security;
grant select, insert, update, delete on public.password_reset_requests to service_role;
grant select, insert, update, delete on public.password_reset_approvals to service_role;

-- 4) "Contact IT Support" tickets — submitted from the Help modal, emailed
--    to IT_SUPPORT_EMAIL immediately, and also kept here so an IT Support
--    account has a real in-Hub inbox instead of only ever seeing raw email.
create table if not exists help_tickets (
  id bigint generated always as identity primary key,
  submitter_user_id uuid references users(id),
  submitter_email text not null,
  submitter_name text not null,
  message text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table help_tickets enable row level security;
grant select, insert, update, delete on public.help_tickets to service_role;

grant usage, select on all sequences in schema public to service_role;
