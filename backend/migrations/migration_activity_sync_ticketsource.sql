-- ============================================================
-- Adds structured actor tracking to the Activity Log, a ticket-source
-- tag (Hub vs VxSync) to Help Tickets, and a table to track Hub<->VxSync
-- data sync freshness/failures.
--
-- Safe to run more than once (every statement is IF NOT EXISTS / IF
-- EXISTS guarded) and safe to run on the live database — it only adds
-- columns/tables, never drops or renames anything existing.
-- ============================================================

-- 1. Activity Log: name + email as real, queryable columns (previously
--    only baked into the free-text message string, so the Hub UI had no
--    way to show/filter/sort by who did it beyond re-parsing a sentence).
alter table audit_log add column if not exists actor_name text;
alter table audit_log add column if not exists actor_email text;

-- Which client (if any) this log line is about - lets the new per-client
-- "Activity Logs" modal on each client card query just that client's
-- history, instead of text-matching client names inside free-form
-- messages (fragile the moment a client is renamed).
alter table audit_log add column if not exists client_id bigint references clients(id) on delete set null;
create index if not exists audit_log_client_id_idx on audit_log(client_id);

-- Coarse category used by VxSync's own "Filter by Action Type" dropdown
-- (Data Edits vs Access Changes vs System/Sync vs Help Tickets). Nullable -
-- Password Management log lines don't need one.
alter table audit_log add column if not exists action_type text;

-- 2. Help Tickets: which system the ticket was filed from, so IT Support
--    can show a visual "Hub" vs "VxSync" tag in the ticket inbox.
alter table help_tickets add column if not exists source text not null default 'hub';
alter table help_tickets add column if not exists source_client_name text;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'help_tickets_source_check'
  ) then
    alter table help_tickets add constraint help_tickets_source_check
      check (source in ('hub', 'vxsync'));
  end if;
end $$;

-- 3. Hub <-> VxSync data sync tracking. One row per client; updated every
--    time that client's VxSync copy pushes its stats to the Hub (or fails
--    to). last_synced_at is what lets the Hub tell an admin "this
--    client's numbers are current as of ___" or flag them as stale.
create table if not exists client_vxsync_sync (
  client_id bigint primary key references clients(id) on delete cascade,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_status text not null default 'never' check (last_status in ('never', 'success', 'failed')),
  last_records_synced integer,
  last_error_message text
);
