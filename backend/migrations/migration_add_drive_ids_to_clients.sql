-- Add columns to persist the Google Drive file IDs created during provisioning,
-- so the delete-client flow can clean up the actual Sheet + Script files later
-- instead of only ever deleting the Supabase row.
alter table clients add column if not exists drive_sheet_id text;
alter table clients add column if not exists drive_script_id text;

-- Backfill drive_sheet_id for existing clients from their stored sheet_url,
-- since older rows were provisioned before this column existed.
update clients
set drive_sheet_id = substring(sheet_url from '/d/([a-zA-Z0-9_-]+)')
where drive_sheet_id is null
  and sheet_url is not null;

-- drive_script_id has no equivalent stored URL to backfill from, so legacy
-- clients provisioned before this column existed will show as
-- "not recorded" in the delete-client cleanup summary rather than
-- silently failing. One-off manual backfill example for a specific
-- legacy client, once its script ID is looked up in Drive:
-- update clients set drive_script_id = 'PASTE_SCRIPT_ID_HERE' where name = '[EXAMPLE_CLIENT_NAME]';
