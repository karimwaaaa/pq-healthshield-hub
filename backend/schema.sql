-- ============================================================
-- [COMPANY_NAME] Hub — Supabase schema
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

create extension if not exists pgcrypto;

-- One table for everyone who can log in — admins (permanent accounts) and
-- nurses/encoders (temporary accounts with an expiry). The role column and
-- expires_at/duration_days columns are what tell them apart.
create table users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  display_name text not null,
  role text not null check (role in ('admin', 'nurse')),
  must_change_password boolean not null default false,
  expires_at timestamptz,        -- only set for role = 'nurse'
  duration_days int,             -- only set for role = 'nurse' (for display in the UI)
  created_at timestamptz not null default now()
);

-- Session tokens issued at login. A row here = a logged-in session.
create table sessions (
  token text primary key,
  user_id uuid not null references users(id) on delete cascade,
  role text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Same shape as your old Clients sheet.
create table clients (
  id bigint generated always as identity primary key,
  name text not null,
  category text default 'General',
  initials text,
  last_updated text,
  status text not null default 'Ongoing' check (status in ('Ongoing', 'Active', 'Complete')),
  app_url text,
  sheet_url text
);

-- Lock every table down completely. Nobody using the public anon key can
-- read or write any of this directly — the only way in is through the Edge
-- Function, which uses the service role key (full access, kept server-side,
-- never shipped to the browser). This is what makes it safe that your
-- SUPABASE_ANON_KEY is visible in the frontend's HTML — it grants no data
-- access on its own, only permission to invoke the function.
alter table users enable row level security;
alter table sessions enable row level security;
alter table clients enable row level security;
-- (No policies are created, which under RLS means: zero access for
-- anon/authenticated keys. Intentional — leave it this way.)

-- ------------------------------------------------------------
-- Seed your first admin account.
-- Do NOT put a plaintext password here. Generate a bcrypt hash first using
-- hash-password.js (see that file), then paste the hash below.
-- must_change_password = true forces them to set a real password on first login.
-- ------------------------------------------------------------
insert into users (email, password_hash, display_name, role, must_change_password)
values (
  'admin@[COMPANY_DOMAIN].com',
  '<PASTE_BCRYPT_HASH_FROM_hash-password.js_HERE>',
  'Admin User',
  'admin',
  true
);

-- ------------------------------------------------------------
-- Encoder-to-client assignments: which nurse/encoder can see which client
-- project. (If you're running this schema fresh, this is included here for
-- completeness. If you already have a working project, use
-- add_assignments.sql instead so you don't re-run everything above.)
-- ------------------------------------------------------------
create table assignments (
  id bigint generated always as identity primary key,
  client_id bigint not null references clients(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (client_id, user_id)
);

alter table assignments enable row level security;
grant select, insert, update, delete on public.assignments to service_role;
grant usage, select on all sequences in schema public to service_role;
