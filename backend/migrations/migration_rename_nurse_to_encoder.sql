-- ============================================================
-- [COMPANY_NAME] Hub - migration for: renaming the "nurse" role to "encoder"
-- everywhere. The role was always called "Encoder" in the UI already for
-- most labels - this just removes the last places that still said
-- "nurse" internally, to match the decision that this role is just
-- "Encoder," not "Nurse."
--
-- Run this in: Supabase Dashboard > SQL Editor > New query.
-- Run this AFTER redeploying the new index.ts and HTML (both now write/
-- expect role = 'encoder' instead of role = 'nurse'), so there's no gap
-- where the code and the data disagree about the role name. Safe to run
-- once - it only touches rows that currently say 'nurse'.
--
-- This needs THREE steps, not two, because of a chicken-and-egg problem:
-- the constraint can't allow only 'encoder' while rows still say 'nurse'
-- (existing rows would violate it immediately), and the UPDATE can't
-- write 'encoder' while the constraint doesn't allow it yet either. So
-- step 1 temporarily allows BOTH old and new values, step 2 does the
-- actual relabeling now that both are legal, and step 3 tightens the
-- constraint back down once no 'nurse' rows are left to conflict with it.
-- ============================================================

-- 1) Temporarily widen the constraint to accept BOTH 'nurse' (existing
--    rows) and 'encoder' (what step 2 is about to write) at the same
--    time. Postgres can't alter a check constraint in place, so this is
--    a drop + recreate.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('admin', 'nurse', 'encoder', 'it_support'));

-- 2) Now it's safe to relabel existing rows - both values are legal at
--    this point, so this can't violate the (temporarily permissive)
--    constraint from step 1.
update users set role = 'encoder' where role = 'nurse';

-- 3) Currently-active sessions - so anyone already logged in as an
--    encoder isn't left with a stale role value until they next log in.
--    (sessions.role has no check constraint, so no ordering concern here.)
update sessions set role = 'encoder' where role = 'nurse';

-- 4) With no 'nurse' rows left anywhere, tighten the constraint back
--    down to its real final form - 'nurse' is no longer a legal value
--    going forward.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('admin', 'encoder', 'it_support'));
