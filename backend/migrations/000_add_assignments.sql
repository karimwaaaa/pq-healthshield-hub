-- ============================================================
-- Adds encoder-to-client assignments. Run this once in the SQL Editor —
-- it doesn't touch your existing users/sessions/clients tables or data.
-- ============================================================

create table assignments (
  id bigint generated always as identity primary key,
  client_id bigint not null references clients(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (client_id, user_id)
);

alter table assignments enable row level security;
-- No policies created, same as your other tables — locked down except
-- through the Edge Function's service_role connection.

-- Explicit grant, same reasoning as the fix we did earlier: your project has
-- "automatically expose new tables" disabled, so every new table needs this
-- spelled out for service_role or the function gets "permission denied"
-- again. The ALTER DEFAULT PRIVILEGES you ran earlier should already cover
-- this automatically, but this makes it certain either way.
grant select, insert, update, delete on public.assignments to service_role;
grant usage, select on all sequences in schema public to service_role;
