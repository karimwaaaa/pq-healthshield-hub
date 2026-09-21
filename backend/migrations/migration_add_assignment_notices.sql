-- Notices shown to encoders when something changes about their client
-- assignments outside their control (e.g. a client they were assigned to
-- gets deleted). Modeled on the existing help_tickets.submitter_notified
-- pattern used elsewhere in this schema.
create table if not exists assignment_notices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now(),
  acknowledged boolean not null default false
);

alter table assignment_notices enable row level security;
-- No policies: this table is written to and read from exclusively by the
-- service_role via the Edge Function, same as the rest of this schema.

grant select, insert, update, delete on assignment_notices to service_role;
