# PQ Healthshield Hub

*Built while working at PQ Healthshield Inc.*

An internal operations portal I designed and built for a healthcare logistics
company to replace a patchwork of manual spreadsheets and one-off Google
Apps Script tools with a single, role-based system for managing client
vaccination-program deployments end to end.

> This repo is a sanitized copy of a real internal system. Real IDs, API
> keys, company names, and personal data have been replaced with bracketed
> placeholders like `[COMPANY_NAME]`, `[SHEET_ID]`, `YOUR-PROJECT-REF`, etc.
> It is not runnable as-is without plugging in your own Supabase project,
> Google Cloud OAuth credentials, and Netlify site.

## Live Demo

**[https://karimwaaaa.github.io/pq-healthshield-hub/](https://karimwaaaa.github.io/pq-healthshield-hub/)**

A static, self-contained mockup of the Hub's UI, running entirely on sample
data baked into the page — no backend, no real clients. Enable via
**Settings → Pages → Source: Deploy from branch → main → /docs**.

## What it does

The Hub is the front door for a company managing multiple client vaccination
tracking deployments (see the companion [VxSync](https://github.com/karimwaaaa/vxsync-vaccination-tracker)
project) at once, and also drives provisioning-adjacent access for the
[Ops Dashboard](https://github.com/karimwaaaa/central-ops-dashboard) via
the same SSO token flow:

- **Single sign-on style access** for Admins, IT Support, and temporary
  Encoder accounts, with role-based views and per-client entry-form links.
- **One-click client provisioning** — clicking "Add Client" calls a Supabase
  Edge Function that copies a master Google Sheet template, spins up a
  brand-new standalone Google Apps Script project, patches in that client's
  configuration, deploys it as a web app, and shares both the new Sheet and
  script with every admin account automatically — all without anyone
  touching the Google Cloud Console or Apps Script editor by hand.
- **Central client directory ("Client Vault")** — status tracking (Ongoing /
  Active / Complete), quick links to each client's Sheet and live web app,
  activity logs, and encoder assignment management.
- **Full client teardown, not just a database row.** Deleting a client from
  the Vault removes the client end-to-end: its provisioned Google Sheet and
  Apps Script project are permanently deleted from Drive (not just moved to
  trash), the Supabase row is removed, and every encoder who had that client
  assigned gets a notice explaining what happened and what they're still
  assigned to. Each Drive resource's outcome (deleted / already gone /
  failed / never tracked) is reported back individually rather than as a
  single pass/fail.
- **Session security** — idle-timeout auto-lock with a persisted timer that
  survives a backgrounded tab being reloaded by the browser, and a
  refresh-without-relogin flow that restores an active session cleanly.
- **Built-in Help Ticket system** — a lightweight support inbox so encoders
  and admins can flag issues/bugs directly from inside the Hub, without a
  separate ticketing tool.
- **Patch Notes + version badge** — every release gets a version number and
  a changelog entry, surfaced automatically to anyone who hasn't seen it yet.
- **Maintenance mode** — a Netlify Edge Function gate that can take the whole
  Hub offline with a friendly maintenance page during planned downtime,
  toggled remotely via a signed URL.

## Architecture

```
┌─────────────────┐      ┌──────────────────────┐      ┌─────────────────┐
│  frontend/       │─────▶│  Supabase Edge        │─────▶│  Supabase        │
│  hub.html         │      │  Function (Deno)      │      │  Postgres         │
│  (single-file SPA)│      │  backend/api_index.ts │      │  (RLS locked down,│
└─────────────────┘      └──────────┬───────────┘      │  service-role      │
                                       │                  │  access only)     │
                                       │                  └─────────────────┘
                                       ▼
                          ┌──────────────────────┐
                          │  Google Drive / Apps   │
                          │  Script API             │
                          │  (per-client VxSync     │
                          │  provisioning)          │
                          └──────────────────────┘
```

- **`frontend/hub.html`** — the entire Hub UI: one dependency-free HTML file
  with inline CSS/JS, deployed as a static site (originally on Netlify).
  No build step, no framework — deliberately simple to deploy and debug.
- **`backend/api_index.ts`** — a single Supabase Edge Function (Deno/
  TypeScript) that is the only thing with database access. The frontend's
  public anon key can only invoke this function; all real authorization
  happens server-side against a `sessions` table.
- **`backend/schema.sql`** + **`backend/migrations/`** — the Postgres schema
  and every incremental migration applied to it over the project's life, in
  chronological order — left un-squashed on purpose, as a record of how the
  system actually evolved (see notable engineering decisions below).
- **`netlify/`** — a maintenance-mode Edge Function + toggle API, deployed
  alongside the static site.

## Notable engineering decisions

- **Provisioning is fully automated, but conservative about it.** Auto-
  provisioning a client calls three separate Google APIs (Drive, Apps
  Script, and the Apps Script Execution API) in sequence, and a
  partially-failed run reports back exactly which Google-side resources
  were already created so nothing is silently orphaned.
- **Every "best-effort" step degrades gracefully and says so.** Sharing a
  new Sheet with every admin, and remotely installing a helper trigger in
  the new Apps Script project, are both nice-to-haves layered on top of a
  fully working core flow — if either fails (e.g. a stale OAuth scope), the
  client is still usable, and the UI tells the admin exactly what still
  needs a manual step, rather than failing silently or blocking the whole
  operation.
- **Client-side inactivity locking is harder than it looks.** The idle
  timer persists its last-activity timestamp to `sessionStorage` so that a
  backgrounded browser tab getting discarded and reloaded by the OS doesn't
  silently reset the clock to "now" — a real bug that shipped once and got
  fixed by making the timer state survive a forced reload.
- **Migrations are kept, not squashed**, so the history of intentional
  schema changes (e.g. renaming a user role across the whole system,
  loosening an unnecessary NOT NULL constraint after a bug report) stays
  readable rather than getting flattened into one opaque `schema.sql`.
- **Deletion is deliberately destructive, not "safe by default."** An
  earlier version of client deletion only ever removed the Supabase row —
  the client's actual Google Sheet and Apps Script project were silently
  orphaned in Drive forever. The fix was to make deletion match what an
  admin actually means by "delete this client": real, permanent removal of
  every resource that client owns. That meant solving a real ordering
  problem first — the Drive file IDs needed for cleanup weren't being
  persisted at provisioning time at all, and the row referencing which
  encoders were assigned to the client gets cascade-deleted the instant the
  `clients` row goes, so anyone who needs to be notified has to be captured
  *before* the delete runs, not looked up after. Drive deletes are treated
  as best-effort and reported per-resource; the database row is removed
  regardless of whether Drive cleanup fully succeeded, so a flaky Google API
  call can never leave a "zombie" client stuck half-deleted in the Vault.

## Tech stack

Deno (Supabase Edge Functions) · PostgreSQL (Supabase, with Row Level
Security) · vanilla HTML/CSS/JS (no framework) · Netlify (static hosting +
Edge Functions) · Google Drive API · Google Apps Script API

## Part of a 3-repo system

This was one of three connected projects I built for the same employer, each
kept as its own repo here since they're independently useful and readable
on their own:

- **Hub** (this repo) — the admin portal and client-provisioning backend.
- **[VxSync](https://github.com/karimwaaaa/vxsync-vaccination-tracker)** — the
  per-client vaccination tracker the Hub provisions.
- **[Ops Dashboard](https://github.com/karimwaaaa/central-ops-dashboard)**
  — the AR/order-management/inventory dashboard, authenticated through the
  same Hub session token.

They share one sign-on flow (a token the Hub issues and the other two
verify against), which is the main thing that ties them together
architecturally.

## Setup (if you want to run your own copy)

1. Create a Supabase project, run `backend/schema.sql` in the SQL editor,
   then apply each file in `backend/migrations/` in order.
2. Generate your first admin's password hash with `backend/hash-password.js`
   and paste it into `schema.sql` where indicated, then re-run that insert.
3. Deploy `backend/api_index.ts` as a Supabase Edge Function, and set its
   secrets (Google OAuth client/secret/refresh token, master Sheet ID, SMTP
   credentials, etc. — see the comments at the top of the file for the full
   list).
4. Fill in `BACKEND_URL` and `SUPABASE_ANON_KEY` near the top of
   `frontend/hub.html`, then deploy that file as a static site.
5. (Optional) Deploy `netlify/` alongside it for maintenance-mode support.
   If you're on Supabase's free tier, set up your own scheduled ping
   (e.g. a GitHub Actions cron job in a repo you control) to keep the
   project from auto-pausing — not included in this repo, since a demo
   repo has no real backend to keep alive.
