// ============================================================
// [COMPANY_NAME] Hub - Supabase Edge Function ("api")
//
// This replaces your Google Apps Script doGet(). One function, one route,
// dispatches on an `action` field just like your old backend did - the
// frontend's callBackend() barely had to change.
//
// Deploy with the Supabase CLI from the folder that CONTAINS this
// "supabase-function-api" folder (rename it to just "api" first - see the
// walkthrough for exact commands):
//   supabase functions deploy api
//
// SUPABASE_URL is provided automatically. SERVICE_ROLE_KEY is NOT auto-provided
// on this project (its "automatically expose new tables" setting is off) - you
// must add it yourself as a Function secret named exactly SERVICE_ROLE_KEY,
// containing your service_role (or secret) key from Project Settings > API Keys.
// ============================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ============================================================
// EMAIL - works with EITHER a Gmail or a Yahoo account, whichever you set
// these Function secrets to. Both providers require an "app password" (NOT
// your normal login password) generated from that account's security
// settings, with 2-step verification turned on first:
//   Gmail:  smtp.gmail.com, port 465, secure
//   Yahoo:  smtp.mail.yahoo.com, port 465, secure
// Set these as Supabase Function secrets (Project Settings > Edge Functions
// > Secrets, or `supabase secrets set NAME=value`):
//   EMAIL_SMTP_HOST      e.g. smtp.gmail.com
//   EMAIL_SMTP_PORT      e.g. 465
//   EMAIL_SMTP_USER      the full mailbox address (also the "from")
//   EMAIL_SMTP_PASSWORD  the app password (not your real password)
//   IT_SUPPORT_EMAIL     where "Contact IT Support" tickets are emailed -
//                        usually the same address as EMAIL_SMTP_USER
//   HUB_URL              your live Netlify URL, e.g.
//                        https://YOUR-HUB-SITE.netlify.app - used only
//                        to link back to the Hub from emails
// If these aren't set yet, email-sending functions log the error and
// return {success:false} instead of crashing the whole request - so the
// rest of the Hub keeps working even before you've set up email.
const EMAIL_SMTP_HOST = Deno.env.get("EMAIL_SMTP_HOST") || "";
const EMAIL_SMTP_PORT = parseInt(Deno.env.get("EMAIL_SMTP_PORT") || "465", 10);
const EMAIL_SMTP_USER = Deno.env.get("EMAIL_SMTP_USER") || "";
const EMAIL_SMTP_PASSWORD = Deno.env.get("EMAIL_SMTP_PASSWORD") || "";
const IT_SUPPORT_EMAIL = Deno.env.get("IT_SUPPORT_EMAIL") || EMAIL_SMTP_USER;
const HUB_URL = Deno.env.get("HUB_URL") || "";
// Optional: lets the Netlify maintenance-mode toggle publish a patch note
// in the same step as turning maintenance mode off, WITHOUT a logged-in
// Hub session (Netlify has no Hub session token to send). If you never
// wire that up, patch notes can still be posted normally from inside the
// Hub by a logged-in admin/IT Support account - this secret only matters
// for the "auto-post from the maintenance toggle" shortcut.
const MAINTENANCE_TOGGLE_SECRET = Deno.env.get("MAINTENANCE_TOGGLE_SECRET") || "";

// ============================================================
// VXSYNC AUTO-PROVISIONING - lets an admin stand up a brand new client's
// VxSync (Sheet + Apps Script Web App) with one click from the Hub,
// instead of manually copying the master Sheet, copying the Apps Script
// project, deploying it, and pasting the resulting URL back in here.
//
// Required Supabase Function secrets (Project Settings > Edge Functions >
// Secrets, or `supabase secrets set NAME=value`):
//   GOOGLE_OAUTH_CLIENT_ID      from the Google Cloud OAuth client (Web
//                               application type) used to mint the token
//   GOOGLE_OAUTH_CLIENT_SECRET  same OAuth client's secret
//   GOOGLE_OAUTH_REFRESH_TOKEN  minted once via OAuth Playground, signed
//                               in as the company's own Google account -
//                               this is what lets the Hub act as that
//                               account indefinitely without any human
//                               clicking through a login each time
//   GOOGLE_MASTER_SHEET_ID      the Drive file ID of the master VxSync
//                               data template Sheet (the one with
//                               Recipients_Master / Vaccine_Schedule_Master
//                               / Vaccinators_Master / etc. tabs) - this
//                               gets COPIED for every new client. Its own
//                               bound "sheet logic" script comes along for
//                               the ride automatically, which is correct -
//                               that script is unrelated to VxSync's own
//                               Code.gs/HTML files below.
//   (SUPABASE_ANON_KEY is NOT something you add - Supabase auto-injects
//   it into every Edge Function, same as SUPABASE_URL, and blocks you
//   from manually setting anything with the SUPABASE_ prefix. It's read
//   below for free.)
//
// Also required: a PRIVATE Supabase Storage bucket named exactly
// "vxsync-template" containing four files, uploaded once (Dashboard ->
// Storage -> create bucket "vxsync-template", mark it private, upload):
//   Code.gs               the master VxSyncCode.gs (this project's file)
//   Index.html
//   EntryForm.html
//   Dashboard.html        NOTE: uploaded/project file name is "Dashboard",
//                         not "VxSyncDashboard" - Index.html calls
//                         include('Dashboard'), so the pushed Apps Script
//                         file must be named exactly that or the deployed
//                         app throws at render time.
// These are fetched fresh on every provisioning call (not embedded in
// this source file - they're too large and contain backticks/JS template
// literals that would be unsafe to inline into a TS string literal), so
// updating the template later is just re-uploading to that bucket - no
// redeploy of this function needed. CONFIG's clientName/adminEmails/
// nurseEmails/clientEmails/hubApiUrl/hubAnonKey/hubClientId/hubLoginUrl/
// sheetId fields are rewritten by field name (see setConfigField_ below)
// regardless of whatever placeholder text sits in the uploaded template.
// ============================================================
const GOOGLE_OAUTH_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") || "";
const GOOGLE_OAUTH_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") || "";
const GOOGLE_OAUTH_REFRESH_TOKEN = Deno.env.get("GOOGLE_OAUTH_REFRESH_TOKEN") || "";
const GOOGLE_MASTER_SHEET_ID = Deno.env.get("GOOGLE_MASTER_SHEET_ID") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

// Exchanges the long-lived refresh token for a short-lived access token.
// Fetched fresh on every provisioning call rather than cached across
// invocations - Edge Function instances are short-lived/stateless anyway,
// and a provisioning run is rare enough (one per new client) that the
// extra round trip is irrelevant.
async function getGoogleAccessToken_(): Promise<string> {
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error("Google OAuth secrets aren't set yet (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN).");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error("Google token refresh failed: " + (data.error_description || data.error || res.status));
  }
  return data.access_token;
}

// Small fetch wrapper that throws with the real Google error message
// surfaced (instead of a generic non-2xx failure) - essential for
// debugging a multi-step provisioning chain where any one of several
// Google API calls could be the one that failed.
async function googleFetch_(url: string, accessToken: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init && init.headers),
      Authorization: "Bearer " + accessToken,
      "content-type": "application/json",
    },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON response body - see below */ }
  if (!res.ok) {
    let msg: string;
    if (data && data.error) {
      msg = data.error.message || JSON.stringify(data.error);
    } else if (text) {
      // Not JSON at all - most likely an HTML error/login/404 page from
      // Google (or a proxy in front of it) rather than a real API error
      // response. Dumping that whole page into the client-facing error
      // (as a previous version of this did) is useless noise and can run
      // to tens of KB. Show a short, clearly-labeled snippet instead, and
      // always name the URL that failed so this is actually diagnosable
      // from the Hub's error box without needing to check Function logs.
      const looksHtml = /^\s*<(!doctype|html)/i.test(text);
      const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
      msg = looksHtml
        ? `non-JSON (HTML) response, first 200 chars: "${snippet}${text.length > 200 ? "..." : ""}"`
        : `non-JSON response, first 200 chars: "${snippet}${text.length > 200 ? "..." : ""}"`;
    } else {
      msg = String(res.status);
    }
    throw new Error(`Google API call to ${url} failed (${res.status}): ${msg}`);
  }
  return data;
}

// Deliberately separate from googleFetch_ above (not a reuse) - a DELETE
// call where a 404 means "already gone, treat as success" is specific to
// file cleanup (deleteClient), and googleFetch_ is shared by provisioning
// calls where a 404 should stay a real failure. files.delete also returns
// 204 with no body on success, unlike the JSON responses googleFetch_
// expects.
async function deleteGoogleFile_(fileId: string, accessToken: string): Promise<{ status: "deleted" | "already_gone" }> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (res.status === 404) return { status: "already_gone" };
  if (!res.ok) {
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON response body */ }
    const msg = data && data.error ? (data.error.message || JSON.stringify(data.error)) : (text ? text.slice(0, 200) : String(res.status));
    throw new Error(`Drive delete of ${fileId} failed (${res.status}): ${msg}`);
  }
  return { status: "deleted" };
}

// Rewrites one CONFIG field in the template source by field NAME, not by
// matching specific placeholder text - so it doesn't matter what dummy
// value sits in the uploaded template. Matches a quoted string, a
// bracketed array, or a bare number after "fieldName:". Throws loudly if
// the field can't be found rather than silently deploying a client whose
// CONFIG never actually got the real value - a wrong VxSync deployment
// should fail the provisioning call, not go live half-configured.
// NOTE: only matches single-line values - the master template's
// arrays (adminEmails etc.) must stay on one line each for this to work.
// Turns an arbitrary string (a client name, an email address) into a
// safely single-quoted JS string literal for splicing into the pushed
// Code.gs source - escapes backslashes and single quotes so a client
// name like "O'Brien Clinic" can't break out of the quotes and corrupt
// the generated script.
function jsStringLiteral_(value: string): string {
  return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n") + "'";
}

// Defensive: normalize "smart"/typographic quotes back to plain ASCII
// quotes before any CONFIG field substitution runs. A Code.gs template
// that got opened, edited, or even just pasted through a word processor
// or notes app at ANY point before being uploaded to the vxsync-template
// bucket (Word, Google Docs, and several others auto-"curl" quotes by
// default) commonly turns straight ' " into curly '‘' '’' '“' '”' - which reads
// identically to a human but breaks setConfigField_'s regex below. Fixing
// only the one field that happens to throw first (clientName) would still
// leave every OTHER quoted CONFIG field (adminEmails, hubApiUrl, ...)
// silently corrupted the same way, just not yet discovered - sanitizing
// the whole file once, up front, is the actual fix, not a per-field patch.
function normalizeSmartQuotes_(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"');
}

function setConfigField_(source: string, field: string, valueLiteral: string): string {
  // Trailing comma is OPTIONAL and matched-but-not-required - whichever
  // CONFIG field the template happens to end the object with (no comma
  // before the closing "}") has to match just as reliably as one in the
  // middle. An earlier version of this required a trailing comma, which
  // broke the moment a template put a different field last.
  const re = new RegExp(`(\\b${field}\\s*:\\s*)(?:'[^']*'|\\[[^\\]]*\\]|-?\\d+)(\\s*,?)`);
  if (!re.test(source)) {
    // Show what's actually there for this field, if anything, so the NEXT
    // format mismatch (a different field, a shape neither straight nor
    // smart quotes explain) is diagnosable straight from the error message
    // instead of another round of guessing blind.
    const lineMatch = source.match(new RegExp(`^.*\\b${field}\\s*:.*$`, "m"));
    const detail = lineMatch
      ? ` Found this line instead: "${lineMatch[0].trim()}"`
      : " That key wasn't found in the file at all - check for a typo or a renamed field.";
    throw new Error(`Template error: CONFIG.${field} not found in the uploaded Code.gs - has its format changed?${detail}`);
  }
  return source.replace(re, `$1${valueLiteral}$2`);
}

// replyTo (optional): set this to the OTHER person's email on any
// notification you'd want to just reply-to-answer, e.g. a ticket email
// sent to IT_SUPPORT_EMAIL with replyTo set to the submitter's address -
// hitting "Reply" in Gmail/Outlook then goes straight to the submitter,
// no separate reply-handling system needed. denomailer's replyTo only
// accepts ONE address (not an array), which is fine here since every
// call site below only ever has one "the other person" to reply to.
async function sendEmail(to: string | string[], subject: string, html: string, replyTo?: string): Promise<boolean> {
  if (!EMAIL_SMTP_HOST || !EMAIL_SMTP_USER || !EMAIL_SMTP_PASSWORD) {
    console.error("sendEmail skipped - EMAIL_SMTP_* secrets are not set yet.");
    return false;
  }
  try {
    const client = new SMTPClient({
      connection: {
        hostname: EMAIL_SMTP_HOST,
        port: EMAIL_SMTP_PORT,
        tls: true,
        auth: { username: EMAIL_SMTP_USER, password: EMAIL_SMTP_PASSWORD },
      },
    });
    await client.send({
      from: `[COMPANY_NAME] Hub <${EMAIL_SMTP_USER}>`,
      to,
      subject,
      html,
      ...(replyTo ? { replyTo } : {}),
    });
    await client.close();
    return true;
  } catch (err) {
    console.error("sendEmail failed:", err);
    return false;
  }
}

// ============================================================
// Shared branded email shell - every outbound email routes through this
// so a password-reset email, a ticket notification, and a patch-notes
// email all look like they came from the same product instead of each
// being its own one-off inline HTML string. Matches the Hub's own navy/
// teal palette (same --navy/--teal values as the Hub's own frontend
// and VxSync). Deliberately plain: no logo image (an emailed <img> from an
// external URL gets blocked-by-default in most mail clients until the
// recipient clicks "show images", so a text wordmark is more reliable),
// table-based-ish simple layout (email HTML rendering is inconsistent
// enough that flexbox/grid isn't worth the risk), inline styles only (many
// mail clients strip <style> blocks entirely).
function emailShell(opts: { preheader?: string; title: string; bodyHtml: string; ctaLabel?: string; ctaUrl?: string; footerNote?: string }): string {
  const NAVY = "#16296b";
  const TEAL = "#1fb6a8";
  const cta = opts.ctaUrl && opts.ctaLabel
    ? `<tr><td style="padding:8px 0 4px;">
         <a href="${opts.ctaUrl}" style="display:inline-block;background:${TEAL};color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">${opts.ctaLabel}</a>
       </td></tr>`
    : "";
  return `<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f7fb;font-family:'Segoe UI',Arial,sans-serif;">
  ${opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${opts.preheader}</div>` : ""}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fb;padding:28px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.06);">
        <tr><td style="background:${NAVY};padding:18px 28px;">
          <span style="color:#fff;font-size:16px;font-weight:700;">[COMPANY_NAME] Hub</span>
        </td></tr>
        <tr><td style="padding:28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="font-size:17px;font-weight:700;color:${NAVY};padding-bottom:12px;">${opts.title}</td></tr>
            <tr><td style="font-size:14.5px;line-height:1.6;color:#33415c;">${opts.bodyHtml}</td></tr>
            ${cta}
          </table>
        </td></tr>
        ${opts.footerNote ? `<tr><td style="padding:0 28px 24px;">
          <p style="font-size:12.5px;color:#8a97ab;line-height:1.5;margin:0;">${opts.footerNote}</p>
        </td></tr>` : ""}
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Tighten this to your actual Netlify URL once the site is live, e.g.
// "https://YOUR-HUB-SITE.netlify.app" instead of "*".
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

// A minimal, self-contained page - only used as a FALLBACK when HUB_URL
// isn't configured (see approvalResultPage below for why this isn't the
// normal path anymore).
function approvalResultPage(title: string, message: string) {
  return html(`<!DOCTYPE html>
<html><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:#f7f6f2; color:#16296b;
    display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px; }
  .box { background:#fff; border-radius:14px; box-shadow:0 12px 32px rgba(0,0,0,0.12); padding:36px 32px;
    max-width:420px; text-align:center; }
  h1 { font-size:1.3em; margin:0 0 12px; }
  p { color:#606b85; line-height:1.5; }
</style></head>
<body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`);
}

// The "Approve" link in a forgot-password email used to get a small HTML
// page rendered DIRECTLY by this function (via approvalResultPage above).
// In production, Supabase's Edge Function gateway was found to strip the
// Content-Type header entirely on this route (confirmed via a browser's
// Network tab - the response came back with NO content-type at all, plus
// an X-Content-Type-Options: nosniff header this code never sets), so
// browsers fell back to rendering the whole response as raw text instead
// of parsing it as HTML. That's a platform/gateway behavior, not
// something fixable by changing what this function returns directly.
//
// The fix: don't try to serve HTML from this endpoint at all. Instead,
// 302-redirect to the Hub's own URL (served by Netlify, which sends
// correct headers 100% of the time) with the result encoded in the query
// string. The Hub's frontend reads ?approveResult=... on page load and
// shows the same message in a proper screen - see handleApprovalResultParams()
// in the frontend.
function approvalResultRedirect(status: string, title: string, message: string) {
  if (!HUB_URL) {
    // HUB_URL secret not set - fall back to the old inline page rather
    // than redirecting to nowhere. Strongly recommend setting HUB_URL.
    return approvalResultPage(title, message);
  }
  const sep = HUB_URL.indexOf("?") === -1 ? "?" : "&";
  const url = `${HUB_URL}${sep}approveResult=${encodeURIComponent(status)}` +
    `&approveTitle=${encodeURIComponent(title)}&approveMessage=${encodeURIComponent(message)}`;
  return new Response(null, { status: 302, headers: { ...CORS_HEADERS, Location: url } });
}

function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomPassword(len = 12) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Deliberately simple, not full RFC 5322 - just enough to catch the
// realistic typo cases (missing @, missing domain, stray spaces, a
// pasted name instead of an address) without rejecting a valid-but-
// unusual real address. Shared by every place an admin types an
// encoder/admin email in directly (createEncoder, updateEncoderInfo,
// addAdmin, assignEncoderByEmail) - the frontend's type="email" inputs
// are a convenience, not the actual check, since this backend is the
// real security boundary the same way requireAdmin() is.
function isValidEmail_(email: unknown): boolean {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function formatTimestamp() {
  return new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" });
}

// en-CA locale formats as YYYY-MM-DD, which is exactly the date-only string
// the audit log's date filter and default-to-today logic need.
function todayManilaDateStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
}

// Fire-and-log helper for the Activity Log feature. Never throws - a logging
// failure should never take down the actual action it's describing.
// actor is optional (a few call sites - like the VxSync/help-ticket
// server-to-server ones - log on behalf of someone who never held a Hub
// session, so there's no session-derived actor to look up) but should be
// passed whenever available: name+email are stored as real columns (not
// just baked into the message string) so the Activity Log UI can show/sort
// on them, per the "every log needs name, email, date, time" requirement.
// actionType is one of: "data_edit" | "access" | "system" | "ticket" | null
// - powers VxSync's own "Filter by Action Type" dropdown (Data Edits vs
// Access Changes). clientId (optional) is what the per-client "Activity
// Logs" modal on each client card filters by.
type ActionType = "data_edit" | "access" | "system" | "ticket";
async function logEvent(
  category: "vxsync" | "password",
  message: string,
  actor?: { name: string; email: string } | null,
  opts?: { clientId?: number | null; actionType?: ActionType | null }
) {
  try {
    await sb.from("audit_log").insert({
      category,
      message: message + " at " + formatTimestamp() + ".",
      actor_name: actor ? actor.name : null,
      actor_email: actor ? actor.email : null,
      client_id: opts && opts.clientId ? opts.clientId : null,
      action_type: opts && opts.actionType ? opts.actionType : null,
    });
  } catch (err) {
    console.error("logEvent failed:", err);
  }
}

// A ticket-related event (submitted/resolved) is relevant to BOTH the
// VxSync activity log AND the Password Management activity log (per
// client instruction) - this fires the same message into both categories
// in one call instead of every call site remembering to do it twice.
async function logTicketEvent(
  message: string,
  actor?: { name: string; email: string } | null,
  clientId?: number | null
) {
  await Promise.all([
    logEvent("vxsync", message, actor, { clientId, actionType: "ticket" }),
    logEvent("password", message, actor, { clientId, actionType: "ticket" }),
  ]);
}

// getSession() is also what enforces "logged out immediately when a
// encoder's temporary password expires" - it re-checks the user's
// expires_at on EVERY call (not just at login), and kills the session
// server-side the moment it's found stale, so a live tab loses access on its
// very next request rather than staying valid until the 12h session itself
// would have expired anyway.
async function getSession(token: string | null) {
  if (!token) return null;
  const { data } = await sb.from("sessions").select("*").eq("token", token).maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) {
    await sb.from("sessions").delete().eq("token", token);
    return null;
  }
  if (data.role === "encoder") {
    const { data: user } = await sb.from("users").select("expires_at").eq("id", data.user_id).maybeSingle();
    if (!user || (user.expires_at && new Date(user.expires_at) < new Date())) {
      await sb.from("sessions").delete().eq("token", token);
      return null;
    }
  }
  return data;
}

// IT Support has full admin parity (plus the help-ticket inbox, gated
// separately below) - so anywhere "admin-only" was enforced, an IT Support
// account passes too.
async function requireAdmin(token: string | null) {
  const session = await getSession(token);
  if (!session || (session.role !== "admin" && session.role !== "it_support")) return null;
  return session;
}

// Looks up the display name AND email of whoever is calling, for log
// messages like "... by Maria Santos at ..." and for the Activity Log's
// structured actor_name/actor_email columns. Session rows don't carry
// display_name/email directly, so this is one extra lookup per admin
// action - fine at this volume, and keeps sessions from going stale if a
// name changes later.
async function getActor(session: any): Promise<{ name: string; email: string }> {
  if (!session) return { name: "Unknown", email: "" };
  const { data } = await sb.from("users").select("display_name, email").eq("id", session.user_id).maybeSingle();
  return {
    name: (data && data.display_name) || "Unknown",
    email: (data && data.email) || "",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  // The "Approve" link inside a forgot-password email is a plain GET click
  // from someone's inbox, not a fetch() call from the Hub - it can't carry
  // a session token or POST a JSON body. Handled entirely outside the
  // action switch below, and answered with a small standalone HTML page
  // (the browser tab opened from the email), not JSON.
  if (req.method === "GET") {
    const url = new URL(req.url);
    const approveToken = url.searchParams.get("approve_reset");
    if (!approveToken) return json({ success: false, error: "Use POST" }, 405);

    try {
      const { data: approval } = await sb
        .from("password_reset_approvals")
        .select("*, password_reset_requests(*)")
        .eq("token", approveToken)
        .maybeSingle();

      if (!approval || !approval.password_reset_requests) {
        return approvalResultRedirect(
          "not_found",
          "Link not recognized",
          "This approval link doesn't match any request - it may have been copied incorrectly, or the request no longer exists."
        );
      }

      const request = approval.password_reset_requests as any;
      const isSelfVerify = approval.admin_user_id === request.requester_user_id;

      if (request.status === "expired" || new Date(request.expires_at) < new Date()) {
        if (request.status === "pending") {
          await sb.from("password_reset_requests").update({ status: "expired" }).eq("id", request.id);
        }
        return approvalResultRedirect(
          "expired",
          "This request expired",
          isSelfVerify
            ? "This verification link is no longer active. Go back to the Hub and click \"Forgot your current password?\" again to send a new one."
            : "This password reset request is no longer active. Ask the requester to submit a new one from the Hub's login page."
        );
      }

      if (request.status !== "pending") {
        return approvalResultRedirect(
          "already_handled",
          "Already handled",
          isSelfVerify
            ? `This has already been verified. ${request.requester_display_name} can go ahead and set their new password.`
            : (request.approved_by_name ? `${request.approved_by_name} already approved` : "Someone already approved") +
              ` this request. No further action is needed - ${request.requester_display_name} can go ahead and set their new password.`
        );
      }

      const { data: approverUser } = await sb
        .from("users")
        .select("display_name")
        .eq("id", approval.admin_user_id)
        .maybeSingle();
      const approverName = approverUser ? approverUser.display_name : "An admin";

      await sb
        .from("password_reset_requests")
        .update({
          status: "approved",
          approved_by_user_id: approval.admin_user_id,
          approved_by_name: approverName,
          approved_at: new Date().toISOString(),
        })
        .eq("id", request.id);

      logEvent("password", `Password reset for ${request.requester_display_name} approved by ${approverName}`);

      // Let every OTHER admin/IT Support know this is handled, so they don't
      // have to go back to their own copy of the request email - their
      // approve link still "works" if clicked (email can't be edited after
      // sending), but will now just show the same "Already handled" page.
      // Skipped entirely for a self-verify (approver === requester) - there
      // was never anyone else's copy of a request email to begin with, so
      // this would just be noise in every other admin's inbox.
      if (!isSelfVerify) {
        const { data: others } = await sb.from("users").select("id, email").in("role", ["admin", "it_support"]);
        const otherEmails = (others || [])
          .filter((u: any) => u.id !== request.requester_user_id && u.id !== approval.admin_user_id)
          .map((u: any) => u.email)
          .filter(Boolean);
        if (otherEmails.length > 0) {
          sendEmail(
            otherEmails,
            `Resolved: ${request.requester_display_name}'s password reset`,
            emailShell({
              title: "Password Reset Already Handled",
              bodyHtml: `<p style="margin:0;">${approverName} approved ${request.requester_display_name}'s (${request.requester_email}) request. No action needed from you - this is just so you can skip your own copy of the original email.</p>`,
            })
          );
        }
      }

      return approvalResultRedirect(
        "approved",
        isSelfVerify ? "Verified" : "Approved",
        isSelfVerify
          ? "You've verified this is really you. Go back to the Hub tab you had open and set your new password - if you closed it, just log in again and try Change Password once more."
          : `You've approved ${request.requester_display_name}'s password reset request. They can now set a new password from the Hub.`
      );
    } catch (err) {
      console.error("approve_reset GET handler failed:", err);
      return approvalResultRedirect("error", "Something went wrong", "Please try again, or ask the requester to submit a new request.");
    }
  }

  if (req.method !== "POST") return json({ success: false, error: "Use POST" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const { action, token, payload = {} } = body;

  try {
    switch (action) {
      // --------------------------------------------------------
      case "login": {
        const { email, password } = payload;
        const { data: user } = await sb.from("users").select("*").eq("email", email).maybeSingle();
        if (!user) return json({ success: false, error: "Invalid credentials" });

        // Locked out after 5 failed attempts - needs an admin/IT Support to
        // clear it from the Admin Accounts panel. Checked BEFORE the
        // password compare so a locked account can't be brute-forced.
        if (user.login_locked) {
          return json({
            success: false,
            error: "This account is locked after too many failed login attempts. Ask an admin or IT Support to unlock it.",
            locked: true,
          });
        }

        if (user.role === "encoder" && user.expires_at && new Date(user.expires_at) < new Date()) {
          return json({ success: false, error: "This temporary password has expired. Ask your administrator for a new one." });
        }

        // A "pending" encoder: an admin has assigned them to a client project
        // but hasn't generated a password yet. Distinguish this from wrong
        // credentials so nobody wastes time guessing a password that was
        // never set.
        if (!user.password_hash) {
          return json({ success: false, error: "No password has been set for this account yet. Ask your administrator to generate one in Password Management." });
        }

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) {
          const attempts = (user.failed_login_attempts || 0) + 1;
          const remaining = Math.max(0, 5 - attempts);
          const nowLocked = attempts >= 5;
          await sb
            .from("users")
            .update({ failed_login_attempts: attempts, login_locked: nowLocked })
            .eq("id", user.id);

          if (nowLocked) {
            return json({
              success: false,
              error: "Too many failed attempts. This account is now locked - ask an admin or IT Support to unlock it.",
              locked: true,
            });
          }
          return json({
            success: false,
            error: "Invalid credentials",
            attemptsRemaining: remaining,
          });
        }

        // Correct password - clear any accumulated failed-attempt count.
        if (user.failed_login_attempts) {
          await sb.from("users").update({ failed_login_attempts: 0 }).eq("id", user.id);
        }

        // First successful login for an encoder: the temp password's
        // short 10-minute pre-login window is over - switch it to the real
        // access duration the admin picked when generating it, counted from
        // right now. Later logins (first_login_at already set) leave
        // expires_at alone; it's already the real duration's expiry.
        if (user.role === "encoder" && !user.first_login_at) {
          const realExpiresAt = new Date(Date.now() + (user.duration_days || 7) * 24 * 60 * 60 * 1000);
          await sb
            .from("users")
            .update({ first_login_at: new Date().toISOString(), expires_at: realExpiresAt.toISOString() })
            .eq("id", user.id);
        }

        const sessionToken = randomToken();
        const sessionExpires = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12-hour session
        await sb.from("sessions").insert({
          token: sessionToken,
          user_id: user.id,
          role: user.role,
          expires_at: sessionExpires.toISOString(),
        });

        return json({
          success: true,
          token: sessionToken,
          role: user.role,
          displayName: user.display_name,
          mustChangePassword: !!user.must_change_password,
        });
      }

      // --------------------------------------------------------
      // Cheap heartbeat the frontend polls every ~45s while someone is
      // logged in. Piggybacks entirely on getSession()'s expiry checks, so
      // the moment an encoder's temp password expires, this starts
      // returning false and the frontend logs them out - without waiting
      // for them to click anything.
      // --------------------------------------------------------
      // Re-authenticates the CURRENT session's own user without rotating or
      // replacing their session token - used only to unlock the inactivity
      // lockout overlay (admins must re-enter their password to clear it).
      // Not a login: no new token is issued, and a wrong password doesn't
      // touch the existing session at all.
      case "verifyPassword": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Your session has expired. Please log in again." });

        const { password } = payload;
        const { data: user } = await sb.from("users").select("password_hash").eq("id", session.user_id).maybeSingle();
        if (!user || !user.password_hash) return json({ success: false, error: "Account not found." });

        const ok = await bcrypt.compare(password || "", user.password_hash);
        return json({ success: ok, error: ok ? undefined : "Incorrect password." });
      }

      // --------------------------------------------------------
      case "pingSession": {
        const session = await getSession(token);
        return json({ success: !!session });
      }

      // --------------------------------------------------------
      // Actually invalidates the session token server-side. Called both on
      // a deliberate Sign Out click and, best-effort, whenever the page is
      // closed/refreshed/navigated away from without clicking Sign Out -
      // so a token is never left valid for up to 12 more hours just because
      // someone closed the tab instead of logging out. No-op (still
      // success) if the token doesn't exist or is already gone.
      case "logout": {
        if (token) await sb.from("sessions").delete().eq("token", token);
        return json({ success: true });
      }

      // --------------------------------------------------------
      case "changePassword": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Session expired, please log in again." });

        const { currentPassword, newPassword } = payload;
        const { data: user } = await sb.from("users").select("*").eq("id", session.user_id).maybeSingle();
        if (!user) return json({ success: false, error: "User not found" });

        const ok = await bcrypt.compare(currentPassword, user.password_hash);
        if (!ok) return json({ success: false, error: "Current password is incorrect." });

        if (!newPassword || newPassword.length < 8) {
          return json({ success: false, error: "New password must be at least 8 characters." });
        }

        const newHash = await bcrypt.hash(newPassword, 10);
        await sb.from("users")
          .update({ password_hash: newHash, must_change_password: false })
          .eq("id", user.id);

        return json({ success: true });
      }

      // --------------------------------------------------------
      // FORGOT PASSWORD (admin/IT Support only) - no session token exists
      // yet, since the whole point is they can't log in. Every OTHER
      // admin/IT Support account gets its own uniquely-tokened "Approve"
      // link by email; whichever one is clicked first wins, and the
      // requester's browser finds out via polling getPasswordResetStatus.
      case "requestPasswordReset": {
        const { email } = payload;
        if (!email) return json({ success: false, error: "Email is required." });

        const { data: user } = await sb.from("users").select("*").eq("email", email).maybeSingle();
        // Deliberately the same error whether the email doesn't exist at all
        // or belongs to an encoder - this is the "only admins" rule
        // from the requirements, and it shouldn't reveal which emails exist.
        if (!user || (user.role !== "admin" && user.role !== "it_support")) {
          return json({ success: false, error: "Only admin and IT Support accounts can use Forgot Password. If you're an encoder, ask your administrator for help instead." });
        }

        const { data: otherAdmins } = await sb
          .from("users")
          .select("id, email, display_name")
          .in("role", ["admin", "it_support"])
          .neq("id", user.id);

        if (!otherAdmins || otherAdmins.length === 0) {
          return json({ success: false, error: "There are no other admin or IT Support accounts to approve this request. This needs to be resolved directly in the database." });
        }

        const pollToken = randomToken();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
        const { data: request, error: reqErr } = await sb
          .from("password_reset_requests")
          .insert({
            requester_user_id: user.id,
            requester_email: user.email,
            requester_display_name: user.display_name,
            poll_token: pollToken,
            status: "pending",
            expires_at: expiresAt.toISOString(),
          })
          .select()
          .single();
        if (reqErr || !request) return json({ success: false, error: reqErr?.message || "Could not create request." });

        const functionUrl = `${SUPABASE_URL}/functions/v1/api`;
        let anySent = false;
        for (const admin of otherAdmins) {
          const approveToken = randomToken();
          await sb.from("password_reset_approvals").insert({
            request_id: request.id,
            admin_user_id: admin.id,
            token: approveToken,
          });
          const approveUrl = `${functionUrl}?approve_reset=${approveToken}`;
          const sent = await sendEmail(
            admin.email,
            `Approval needed: ${user.display_name}'s password reset`,
            emailShell({
              preheader: `${user.display_name} requested a password reset - approve or ignore.`,
              title: "Password Reset Request",
              bodyHtml: `<p style="margin:0 0 8px;"><strong>${user.display_name}</strong> (${user.email}) requested to reset their Hub password.</p>
                         <p style="margin:0;">If that's expected, approve it below - they'll be able to set a new password right away.</p>`,
              ctaLabel: "Approve Password Reset",
              ctaUrl: approveUrl,
              footerNote: "This link expires in 30 minutes and works once - if another admin approves first, it'll just show that it's already handled.",
            })
          );
          if (sent) anySent = true;
        }

        if (!anySent) {
          console.error("requestPasswordReset: no approval emails were actually sent - check EMAIL_SMTP_* secrets.");
        }

        return json({ success: true, pollToken });
      }

      // --------------------------------------------------------
      // SELF-SERVICE VERIFY (admin/IT Support, already logged in) - for
      // "I'm in the Hub right now but forgot my CURRENT password so I
      // can't fill in Change Password." Reuses the exact same
      // password_reset_requests / password_reset_approvals tables and the
      // exact same getPasswordResetStatus / completePasswordReset flow as
      // the admin-approval version above - the only difference is WHO
      // approves it: instead of emailing every other admin, this emails
      // the requester's OWN address and makes them their own approver.
      // Clicking that link proves control of the registered email, which
      // is a reasonable bar for someone who already has a valid session -
      // no other admin needs to get involved.
      case "requestSelfPasswordVerify": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Please log in again." });

        const { data: user } = await sb.from("users").select("email, display_name").eq("id", session.user_id).maybeSingle();
        if (!user || !user.email) return json({ success: false, error: "Could not find your account email." });

        const pollToken = randomToken();
        // Tighter expiry than the admin-approval flow (30 min) - this is a
        // self-service action the same person is actively waiting on, not
        // something that might sit in someone else's inbox for a while.
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        const { data: request, error: reqErr } = await sb
          .from("password_reset_requests")
          .insert({
            requester_user_id: session.user_id,
            requester_email: user.email,
            requester_display_name: user.display_name || user.email,
            poll_token: pollToken,
            status: "pending",
            expires_at: expiresAt.toISOString(),
          })
          .select()
          .single();
        if (reqErr || !request) return json({ success: false, error: reqErr?.message || "Could not create request." });

        const approveToken = randomToken();
        await sb.from("password_reset_approvals").insert({
          request_id: request.id,
          admin_user_id: session.user_id, // approver IS the requester - that's the whole point of self-verify
          token: approveToken,
        });

        const verifyUrl = `${SUPABASE_URL}/functions/v1/api?approve_reset=${approveToken}`;
        const sent = await sendEmail(
          user.email,
          "Confirm your password change",
          emailShell({
            preheader: "Confirm it's really you before setting a new Hub password.",
            title: "Verify Password Change",
            bodyHtml: `<p style="margin:0;">You asked to change your Hub password without entering your current one. Confirm it's really you, and you'll be able to set a new password right after.</p>`,
            ctaLabel: "Verify Password Change",
            ctaUrl: verifyUrl,
            footerNote: "This link expires in 15 minutes. Didn't request this? You can ignore this email - nothing changes on your account unless you click through.",
          })
        );
        if (!sent) {
          console.error("requestSelfPasswordVerify: verification email was not actually sent - check EMAIL_SMTP_* secrets.");
        }

        return json({ success: true, pollToken });
      }

      // --------------------------------------------------------
      // Polled by the requester's own browser (no session token - they're
      // still logged out) while the "Waiting for approval..." screen is up.
      case "getPasswordResetStatus": {
        const { pollToken } = payload;
        if (!pollToken) return json({ success: false, error: "pollToken is required." });

        const { data: request } = await sb
          .from("password_reset_requests")
          .select("status, expires_at, requester_display_name")
          .eq("poll_token", pollToken)
          .maybeSingle();
        if (!request) return json({ success: false, error: "Request not found." });

        if (request.status === "pending" && new Date(request.expires_at) < new Date()) {
          await sb.from("password_reset_requests").update({ status: "expired" }).eq("poll_token", pollToken);
          return json({ success: true, status: "expired" });
        }

        return json({ success: true, status: request.status });
      }

      // --------------------------------------------------------
      // Sets the new password once an admin has approved. Still no session
      // token involved - pollToken IS the authorization here, exactly like
      // the email approve links are.
      case "completePasswordReset": {
        const { pollToken, newPassword } = payload;
        if (!pollToken || !newPassword) return json({ success: false, error: "pollToken and newPassword are required." });
        if (newPassword.length < 8) return json({ success: false, error: "New password must be at least 8 characters." });

        const { data: request } = await sb
          .from("password_reset_requests")
          .select("*")
          .eq("poll_token", pollToken)
          .maybeSingle();
        if (!request) return json({ success: false, error: "Request not found." });
        if (request.status !== "approved") return json({ success: false, error: "This request hasn't been approved yet." });

        const newHash = await bcrypt.hash(newPassword, 10);
        await sb
          .from("users")
          .update({ password_hash: newHash, must_change_password: false, login_locked: false, failed_login_attempts: 0 })
          .eq("id", request.requester_user_id);

        await sb
          .from("password_reset_requests")
          .update({ status: "used", completed_at: new Date().toISOString() })
          .eq("id", request.id);

        logEvent("password", `Password reset completed for ${request.requester_display_name} (approved by ${request.approved_by_name})`);
        return json({ success: true });
      }

      // --------------------------------------------------------
      case "getClients": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Session expired, please log in again." });

        let rows: any[] = [];
        if (session.role === "admin" || session.role === "it_support") {
          const { data } = await sb.from("clients").select("*").order("id");
          rows = data || [];
        } else {
          // Encoders only see clients an admin has explicitly assigned them to.
          const { data: assigned } = await sb
            .from("assignments")
            .select("client_id")
            .eq("user_id", session.user_id);
          const ids = (assigned || []).map((a: any) => a.client_id);
          if (ids.length > 0) {
            const { data } = await sb.from("clients").select("*").in("id", ids).order("id");
            rows = data || [];
          }
        }

        const clients = rows.map((c: any) => ({
          id: c.id,
          name: c.name,
          category: c.category,
          initials: c.initials,
          lastUpdated: c.last_updated,
          status: c.status,
          appUrl: c.app_url,
          sheetUrl: c.sheet_url,
        }));
        return json({ success: true, clients });
      }

      // --------------------------------------------------------
      // Returns EVERY encoder account, whether or not they have a
      // password yet - deliberately not filtered by expiry, since the
      // whole point of the assign-first flow is that a "pending" encoder
      // (assigned, no password) has to show up here to be assignable.
      case "getEncoders": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const [{ data }, { data: assignRows }] = await Promise.all([
          sb.from("users").select("id, email, display_name, password_hash, expires_at").eq("role", "encoder").order("display_name"),
          sb.from("assignments").select("id, user_id, client_id, clients(name)"),
        ]);

        const assignMap: Record<string, any[]> = {};
        (assignRows || []).forEach((a: any) => {
          if (!assignMap[a.user_id]) assignMap[a.user_id] = [];
          assignMap[a.user_id].push({
            assignmentId: a.id,
            clientId: a.client_id,
            clientName: a.clients ? a.clients.name : "-",
          });
        });

        const now = Date.now();
        const encoders = (data || []).map((u: any) => {
          let status = "active";
          if (!u.password_hash) status = "pending";
          else if (u.expires_at && new Date(u.expires_at).getTime() < now) status = "expired";
          return {
            id: u.id,
            email: u.email,
            displayName: u.display_name,
            expires: u.expires_at ? new Date(u.expires_at).getTime() : null,
            status,
            assignments: assignMap[u.id] || [],
          };
        });
        return json({ success: true, encoders });
      }

      // --------------------------------------------------------
      case "getAssignments": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { data, error } = await sb
          .from("assignments")
          .select("id, client_id, user_id, clients(name), users(email, display_name, password_hash, expires_at)")
          .order("id");

        if (error) return json({ success: false, error: error.message });

        const now = Date.now();
        const assignments = (data || []).map((a: any) => {
          const u = a.users;
          let status = "active";
          if (!u || !u.password_hash) status = "pending";
          else if (u.expires_at && new Date(u.expires_at).getTime() < now) status = "expired";
          return {
            id: a.id,
            clientId: a.client_id,
            clientName: a.clients ? a.clients.name : null,
            userId: a.user_id,
            email: u ? u.email : null,
            displayName: u ? u.display_name : null,
            status,
          };
        });
        return json({ success: true, assignments });
      }

      // --------------------------------------------------------
      case "assignEncoder": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { clientId, userId } = payload;
        const { error } = await sb
          .from("assignments")
          .upsert({ client_id: clientId, user_id: userId }, { onConflict: "client_id,user_id" });

        if (error) return json({ success: false, error: error.message });
        return json({ success: true });
      }

      // --------------------------------------------------------
      case "unassignEncoder": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        // Fetch names before deleting - nothing to log against once the row is gone.
        const { data: existing } = await sb
          .from("assignments")
          .select("client_id, clients(name), users(display_name)")
          .eq("id", payload.assignmentId)
          .maybeSingle();

        await sb.from("assignments").delete().eq("id", payload.assignmentId);

        if (existing) {
          const actor = await getActor(session);
          const clientName = (existing as any).clients ? (existing as any).clients.name : "a client";
          const encoderName = (existing as any).users ? (existing as any).users.display_name : "An encoder";
          logEvent("vxsync", `${encoderName} unassigned from ${clientName} by ${actor.name}`, actor, {
            clientId: (existing as any).client_id,
            actionType: "access",
          });
        }
        return json({ success: true });
      }

      // --------------------------------------------------------
      // Bulk version of unassignEncoder - removes several specific
      // assignment rows (by id) in one call, so the "Unassign Selected"
      // button doesn't have to fire one request per checkbox.
      case "unassignEncodersBulk": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { assignmentIds } = payload;
        if (!Array.isArray(assignmentIds) || !assignmentIds.length) {
          return json({ success: false, error: "At least one assignmentId is required." });
        }

        const { data: existing } = await sb
          .from("assignments")
          .select("id, client_id, clients(name), users(display_name)")
          .in("id", assignmentIds);

        await sb.from("assignments").delete().in("id", assignmentIds);

        const actor = await getActor(session);
        (existing || []).forEach((row: any) => {
          const clientName = row.clients ? row.clients.name : "a client";
          const encoderName = row.users ? row.users.display_name : "An encoder";
          logEvent("vxsync", `${encoderName} unassigned from ${clientName} by ${actor.name}`, actor, {
            clientId: row.client_id,
            actionType: "access",
          });
        });
        return json({ success: true, count: (existing || []).length });
      }

      // --------------------------------------------------------
      // "Add New Encoder" (separate from assigning): creates a passwordless
      // encoder with NO client assignment yet. Distinct from
      // assignEncoderByEmail, which does both at once from within a
      // specific client's context.
      case "createEncoder": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { email, name } = payload;
        if (!email || !name) return json({ success: false, error: "Email and name are required." });
        if (!isValidEmail_(email)) return json({ success: false, error: `"${email}" doesn't look like a valid email address.` });

        const { data: existingUser } = await sb.from("users").select("id, role").eq("email", email).maybeSingle();
        if (existingUser) {
          return json({ success: false, error: "An account with that email already exists." });
        }

        const { error } = await sb.from("users").insert({
          email,
          display_name: name,
          password_hash: null,
          role: "encoder",
          must_change_password: true,
          expires_at: null,
          duration_days: null,
        });
        if (error) return json({ success: false, error: error.message });

        const actor = await getActor(session);
        logEvent("vxsync", `Encoder ${name} added (no client assignments yet) by ${actor.name}`, actor);
        return json({ success: true });
      }

      // --------------------------------------------------------
      // Fixes a typo in an encoder's name/email after the fact. Never
      // touches password_hash/role - purely a details edit.
      case "updateEncoderInfo": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { userId, name, email } = payload;
        if (!userId || !name || !email) {
          return json({ success: false, error: "userId, name, and email are required." });
        }
        if (!isValidEmail_(email)) return json({ success: false, error: `"${email}" doesn't look like a valid email address.` });

        const { error } = await sb
          .from("users")
          .update({ display_name: name, email })
          .eq("id", userId)
          .eq("role", "encoder");
        if (error) return json({ success: false, error: error.message });

        const actor = await getActor(session);
        logEvent("vxsync", `Encoder details updated for ${name} by ${actor.name}`, actor);
        return json({ success: true });
      }

      // --------------------------------------------------------
      case "addClient": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const c = payload.client;
        const { data: inserted } = await sb
          .from("clients")
          .insert({
            name: c.name,
            category: c.category,
            initials: c.initials,
            last_updated: c.lastUpdated,
            status: c.status,
            app_url: c.appUrl,
            sheet_url: c.sheetUrl,
          })
          .select("id")
          .single();

        const actor = await getActor(session);
        logEvent("vxsync", `Client project ${c.name} initialized by ${actor.name}`, actor, {
          clientId: inserted ? inserted.id : null,
          actionType: "data_edit",
        });
        return json({ success: true });
      }

      // --------------------------------------------------------
      // One-click VxSync onboarding - see the big comment block near
      // GOOGLE_OAUTH_CLIENT_ID above for the required secrets/Storage
      // bucket. Does everything the manual checklist in VxSyncCode.gs's
      // CONFIG comment describes (copy the master Sheet, copy/configure
      // the Apps Script project, deploy it as a Web App) except the
      // human has to do none of it - admin just types a name/category.
      case "provisionVxSyncClient": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const name = (payload.name || "").toString().trim();
        const category = (payload.category || "").toString().trim();
        const initials = (payload.initials || "").toString().trim();
        if (!name) return json({ success: false, error: "Client name is required." });

        if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
          return json({ success: false, error: "Google OAuth secrets aren't set up yet - see the comment above GOOGLE_OAUTH_CLIENT_ID in this file." });
        }
        if (!GOOGLE_MASTER_SHEET_ID) {
          return json({ success: false, error: "GOOGLE_MASTER_SHEET_ID isn't set yet." });
        }
        if (!SUPABASE_ANON_KEY) {
          // This one is auto-injected by Supabase itself (not a secret you
          // can set) - if it's empty, something is unusually wrong with the
          // runtime rather than a missing setup step.
          return json({ success: false, error: "SUPABASE_ANON_KEY came back empty from the runtime - this is auto-provided by Supabase, not a secret you set, so this points to a platform issue rather than a config step you missed." });
        }

        // A real row (with a real id) up front, so that id can be baked
        // into the new deployment's CONFIG.hubClientId - marked "Ongoing"
        // (the existing "setup in progress" status option, same one the
        // manual Add Client form already offers) rather than "Active"
        // until every Google step below actually succeeds.
        // Plain "en-US" (no options) gives the same short M/D/YYYY shape
        // the manual Add Client form's new Date().toLocaleDateString()
        // produces in a browser - client cards shouldn't show two
        // different date formats depending on how the client was created.
        const todayStr = new Date().toLocaleDateString("en-US");
        const { data: clientRow, error: insertErr } = await sb
          .from("clients")
          .insert({ name, category, initials, last_updated: todayStr, status: "Ongoing", app_url: "", sheet_url: "" })
          .select("id")
          .single();
        if (insertErr || !clientRow) {
          return json({ success: false, error: "Could not create the client record: " + (insertErr ? insertErr.message : "unknown error") });
        }
        const clientId = clientRow.id;

        // From here on, ANY failure needs to remove the placeholder row
        // (an admin shouldn't see a permanently-broken "Ongoing" client
        // sitting in their list forever) - but if a Google-side resource
        // (the Sheet copy or the script project) was already created
        // before the failure, that's reported back rather than silently
        // orphaned, since this function can't roll THOSE back.
        let createdSheetId: string | null = null;
        let createdScriptId: string | null = null;
        try {
          const accessToken = await getGoogleAccessToken_();

          // Admins/IT Support for this client's VxSync CONFIG come
          // straight from the Hub's own users table - not re-typed by
          // hand, and not something the "Add Client" form needs to ask
          // for at all.
          const { data: hubAdmins } = await sb
            .from("users")
            .select("email")
            .in("role", ["admin", "it_support"]);
          const adminEmails = (hubAdmins || []).map((u: any) => u.email).filter(Boolean);

          // 1) Copy the master data Sheet (its own bound "sheet logic"
          // script comes along automatically - that's fine, it's
          // unrelated to VxSync's Code.gs below).
          const sheetCopy = await googleFetch_(
            `https://www.googleapis.com/drive/v3/files/${GOOGLE_MASTER_SHEET_ID}/copy?fields=id`,
            accessToken,
            { method: "POST", body: JSON.stringify({ name: `${name} - VxSync Data` }) }
          );
          createdSheetId = sheetCopy.id;

          // 2) A brand new STANDALONE Apps Script project (deliberately
          // NOT bound to the copied Sheet - see the getSheet_() helper
          // in VxSyncCode.gs and the long comment above
          // GOOGLE_OAUTH_CLIENT_ID for why: there's no reliable way to
          // discover a container-bound script's ID after a Drive copy,
          // so this script opens the Sheet explicitly by ID instead).
          const scriptProject = await googleFetch_(
            "https://script.googleapis.com/v1/projects",
            accessToken,
            { method: "POST", body: JSON.stringify({ title: `VxSync — ${name}` }) }
          );
          createdScriptId = scriptProject.scriptId;

          // 2b) Share both new Drive files (the Sheet copy and the Apps
          // Script project - Apps Script projects are Drive files too,
          // same permissions API) with every current admin/IT Support
          // account, using the same adminEmails list baked into CONFIG
          // above. Without this, both files are owned solely by whatever
          // Google account the OAuth refresh token belongs to, and every
          // other admin clicking "sheet_url" on the client card would
          // hit Drive's "Request access" wall instead of opening it.
          // Best-effort per address: one bad/stale email shouldn't fail
          // the whole client creation, since the client is still fully
          // usable without any given admin having direct Sheet access
          // (they use the VxSync web app itself day-to-day, not the raw
          // Sheet) - this only affects the "open the Sheet directly"
          // convenience. Newly added admins after this point aren't
          // retroactively granted access to already-provisioned clients;
          // this only covers clients created from here on.
          const shareFailures: string[] = [];
          for (const fileId of [createdSheetId, createdScriptId]) {
            for (const email of adminEmails) {
              try {
                await googleFetch_(
                  `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false`,
                  accessToken,
                  { method: "POST", body: JSON.stringify({ type: "user", role: "writer", emailAddress: email }) }
                );
              } catch (shareErr: any) {
                const msg = `${email} (${fileId}): ${shareErr && shareErr.message}`;
                shareFailures.push(msg);
                console.error("Drive share failed:", msg);
              }
            }
          }

          // 3) Pull the master template files (kept in Storage, not
          // inlined in this source - see the comment above
          // GOOGLE_OAUTH_CLIENT_ID) and patch in this client's values.
          const templateFiles = ["Code.gs", "Index.html", "EntryForm.html", "Dashboard.html"];
          const downloaded: Record<string, string> = {};
          for (const fname of templateFiles) {
            const { data: blob, error: dlErr } = await sb.storage.from("vxsync-template").download(fname);
            if (dlErr || !blob) {
              throw new Error(`Could not download template file "${fname}" from the vxsync-template Storage bucket: ${dlErr ? dlErr.message : "not found"}`);
            }
            downloaded[fname] = await blob.text();
          }

          // Sanitize BEFORE any field substitution runs - see
          // normalizeSmartQuotes_'s comment for why this has to happen to
          // the whole file up front, not just to whichever field
          // setConfigField_ happens to hit first.
          let code = normalizeSmartQuotes_(downloaded["Code.gs"]);
          code = setConfigField_(code, "clientName", jsStringLiteral_(name));
          code = setConfigField_(code, "adminEmails", "[" + adminEmails.map(jsStringLiteral_).join(", ") + "]");
          code = setConfigField_(code, "nurseEmails", "[]");
          code = setConfigField_(code, "clientEmails", "[]");
          code = setConfigField_(code, "hubApiUrl", jsStringLiteral_(`${SUPABASE_URL}/functions/v1/api`));
          code = setConfigField_(code, "hubAnonKey", jsStringLiteral_(SUPABASE_ANON_KEY));
          code = setConfigField_(code, "hubClientId", String(clientId));
          code = setConfigField_(code, "hubLoginUrl", jsStringLiteral_(HUB_URL));
          code = setConfigField_(code, "sheetId", jsStringLiteral_(createdSheetId!));

          const manifest = {
            timeZone: "Asia/Manila",
            dependencies: {},
            exceptionLogging: "STACKDRIVER",
            runtimeVersion: "V8",
            webapp: { access: "ANYONE", executeAs: "USER_ACCESSING" },
            // No executionApi entry: this deployment no longer needs
            // scripts.run exposed. The Hub used to remotely invoke
            // setupRecipientAutoIdTrigger here to install an auto-ID
            // trigger in this standalone project - removed as of the
            // investigation that found a completely separate script,
            // bound directly to the client's Sheet (carried forward from
            // the master template on every Drive copy), already assigns
            // Recipient IDs on direct edit and always has, independent of
            // this project entirely. See the removed
            // setupRecipientAutoIdTrigger / recipientsMasterOnEdit_ /
            // isRecipientAutoIdTriggerInstalled functions' git history in
            // Code.gs for the full writeup if this ever needs revisiting.
          };

          // 4) Push all four files (+ the manifest) into the new project.
          // NOTE: projects.updateContent is PUT .../v1/projects/{id}/content,
          // not a ":updateContent" colon-suffixed RPC-style POST (that was
          // a real bug here - it 404'd against Google's generic frontend,
          // which is why the response was an HTML "page not found" page in
          // the account's own locale rather than a JSON API error).
          await googleFetch_(
            `https://script.googleapis.com/v1/projects/${createdScriptId}/content`,
            accessToken,
            {
              method: "PUT",
              body: JSON.stringify({
                files: [
                  { name: "Code", type: "SERVER_JS", source: code },
                  { name: "Index", type: "HTML", source: downloaded["Index.html"] },
                  { name: "EntryForm", type: "HTML", source: downloaded["EntryForm.html"] },
                  { name: "Dashboard", type: "HTML", source: downloaded["Dashboard.html"] },
                  { name: "appsscript", type: "JSON", source: JSON.stringify(manifest) },
                ],
              }),
            }
          );

          // 5) Version, then deploy as a Web App.
          const version = await googleFetch_(
            `https://script.googleapis.com/v1/projects/${createdScriptId}/versions`,
            accessToken,
            { method: "POST", body: JSON.stringify({ description: `Provisioned ${todayStr}` }) }
          );
          const deployment = await googleFetch_(
            `https://script.googleapis.com/v1/projects/${createdScriptId}/deployments`,
            accessToken,
            {
              method: "POST",
              body: JSON.stringify({
                versionNumber: version.versionNumber,
                manifestFileName: "appsscript",
                description: `VxSync — ${name}`,
              }),
            }
          );
          const webAppEntry = (deployment.entryPoints || []).find(
            (ep: any) => ep.entryPointType === "WEB_APP"
          );
          const webAppUrl = webAppEntry && webAppEntry.webApp && webAppEntry.webApp.url;
          if (!webAppUrl) {
            throw new Error("Deployment succeeded but no Web App URL came back - check this client's Apps Script project manually.");
          }

          // Recipient-ID auto-generation on direct Sheet edit is NOT this
          // project's job and never needs installing here: it's handled
          // by a separate script bound directly to the client's Sheet
          // (carried forward from the master template on every Drive
          // copy), confirmed working independently of anything in this
          // standalone project. See the manifest comment above for the
          // full writeup of what used to live here.

          const sheetUrl = `https://docs.google.com/spreadsheets/d/${createdSheetId}/edit`;
          // Status stays "Ongoing" even on a clean success - provisioning
          // the Sheet/Web App is only the infrastructure step. "Active" is
          // a deliberate call an admin makes once encoders are actually
          // assigned and the client is really live, same as a manually
          // added client - auto-provisioning shouldn't skip that judgment.
          const { error: updateErr } = await sb
            .from("clients")
            .update({
              app_url: webAppUrl,
              sheet_url: sheetUrl,
              drive_sheet_id: createdSheetId,
              drive_script_id: createdScriptId,
            })
            .eq("id", clientId);
          if (updateErr) throw new Error("Google provisioning succeeded but saving the URLs back to the client record failed: " + updateErr.message);

          const actor = await getActor(session);
          const logSuffix =
            shareFailures.length ? ` [Drive sharing failed for: ${shareFailures.join("; ")}]` : "";
          logEvent("vxsync", `Client project ${name} auto-provisioned by ${actor.name}${logSuffix}`, actor, {
            clientId,
            actionType: "data_edit",
          });
          return json({
            success: true,
            clientId,
            appUrl: webAppUrl,
            sheetUrl,
            shareFailuresCount: shareFailures.length,
          });
        } catch (err: any) {
          // Remove the placeholder row so nothing broken shows up in the
          // client list - but if Google-side resources were already
          // created, surface their IDs so an admin can find/clean them
          // up in Drive rather than them existing invisibly.
          await sb.from("clients").delete().eq("id", clientId);
          const cleanupNote =
            createdSheetId || createdScriptId
              ? ` (Google already created: ${createdSheetId ? "Sheet " + createdSheetId : ""}${createdSheetId && createdScriptId ? ", " : ""}${createdScriptId ? "Script project " + createdScriptId : ""} - you may want to delete ${createdSheetId && createdScriptId ? "these" : "this"} manually in Drive.)`
              : "";
          return json({ success: false, error: (err && err.message ? err.message : String(err)) + cleanupNote });
        }
      }

      // --------------------------------------------------------
      case "updateClientStatus": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { data: client } = await sb.from("clients").select("name, status").eq("id", payload.clientId).maybeSingle();
        const previousStatus = client ? client.status : null;
        await sb.from("clients").update({ status: payload.status }).eq("id", payload.clientId);

        const actor = await getActor(session);
        const clientName = client ? client.name : "A client";
        logEvent(
          "vxsync",
          previousStatus && previousStatus !== payload.status
            ? `${clientName} status changed from ${previousStatus} to ${payload.status} by ${actor.name}`
            : `${clientName} status has been updated to ${payload.status} by ${actor.name}`,
          actor,
          { clientId: payload.clientId, actionType: "data_edit" }
        );
        return json({ success: true });
      }

      // --------------------------------------------------------
      case "generateTempPassword": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { email, name, duration } = payload;
        const plain = randomPassword();
        const hash = await bcrypt.hash(plain, 10);
        // Pre-login window: the temp password itself expires in 10 minutes
        // if the encoder never logs in with it. The admin-set duration only
        // starts counting once they DO log in for the first time - see the
        // "login" case below, which recomputes expires_at at that moment.
        const preLoginExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await sb.from("users").upsert(
          {
            email,
            display_name: name,
            password_hash: hash,
            role: "encoder",
            must_change_password: false,
            expires_at: preLoginExpiresAt.toISOString(),
            duration_days: duration || 7,
            first_login_at: null,
          },
          { onConflict: "email" }
        );

        const genActor = await getActor(session);
        logEvent("password", `Temporary password/s made for ${name} by ${genActor.name}`, genActor);

        // The plaintext password is returned exactly once, here. It is never
        // retrievable again after this response - that's the whole point of
        // hashing it before storage.
        return json({ success: true, password: plain, expires: preLoginExpiresAt.getTime() });
      }

      // --------------------------------------------------------
      case "getTempPasswords": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { data } = await sb
          .from("users")
          .select("email, display_name, created_at, expires_at, duration_days, password_hash, first_login_at")
          .eq("role", "encoder")
          .order("created_at", { ascending: false });

        // A pending encoder (no password generated yet) has no generated/
        // expires date to show - the frontend renders those columns blank
        // and shows "Inactive" instead of computing a (false) expired state.
        // firstLoginAt lets the frontend tell "still within the 10-minute
        // pre-login window" apart from "logged in, real duration applies".
        const tempPasswords = (data || []).map((u: any) => ({
          email: u.email,
          displayName: u.display_name,
          hasPassword: !!u.password_hash,
          generated: u.password_hash ? new Date(u.created_at).getTime() : null,
          expires: u.expires_at ? new Date(u.expires_at).getTime() : null,
          durationDays: u.duration_days,
          firstLoginAt: u.first_login_at ? new Date(u.first_login_at).getTime() : null,
        }));
        return json({ success: true, tempPasswords });
      }

      // --------------------------------------------------------
      case "revokeTempPassword": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { data: user } = await sb
          .from("users")
          .select("display_name")
          .eq("email", payload.email)
          .eq("role", "encoder")
          .maybeSingle();

        await sb.from("users").delete().eq("email", payload.email).eq("role", "encoder");

        const revokeActor = await getActor(session);
        logEvent("password", `Temporary password/s revoked for ${user ? user.display_name : payload.email} by ${revokeActor.name}`, revokeActor);
        return json({ success: true });
      }

      // --------------------------------------------------------
      // Deletes an encoder account entirely (not just their password) -
      // distinct from revokeTempPassword, which is reached from Password
      // Management and only clears credentials. This one is reached from the
      // Edit Encoder modal and removes the user row outright; assignments and
      // sessions cascade-delete with it via their FK constraints.
      case "deleteEncoder": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { userId } = payload;
        if (!userId) return json({ success: false, error: "userId is required." });

        const { data: user } = await sb
          .from("users")
          .select("display_name")
          .eq("id", userId)
          .eq("role", "encoder")
          .maybeSingle();
        if (!user) return json({ success: false, error: "Encoder not found." });

        const { error } = await sb.from("users").delete().eq("id", userId).eq("role", "encoder");
        if (error) return json({ success: false, error: error.message });

        const actor = await getActor(session);
        logEvent("vxsync", `Encoder ${user.display_name} deleted by ${actor.name}`, actor);
        return json({ success: true });
      }

      // --------------------------------------------------------
      // Called by the Dashboard's Apps Script (server-to-server), not by the
      // Hub frontend. Verifies the token the Hub handed the user when they
      // clicked "Launch Dashboard", so the Dashboard can drop them straight
      // in with the right role instead of asking them to log in again.
      case "verifySession": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Invalid or expired session." });

        const { data: user } = await sb.from("users").select("display_name").eq("id", session.user_id).maybeSingle();
        return json({
          success: true,
          role: session.role,
          displayName: user ? user.display_name : null,
        });
      }

      // --------------------------------------------------------
      // Called by each client's copy of VxSync's Code.gs (server-to-server),
      // not by the Hub frontend. VxSync keeps its own real Google sign-in -
      // this just answers "is this Google email allowed into THIS client's
      // VxSync, and as admin or encoder?" using the same assignment data the
      // Hub's admin manages. No session token involved, since the person
      // calling this never logged into the Hub at all.
      case "checkVxSyncAccess": {
        const { clientId, email } = payload;
        if (!clientId || !email) {
          return json({ success: false, error: "clientId and email are required." });
        }

        const { data: user } = await sb.from("users").select("id, role").eq("email", email).maybeSingle();
        if (!user) return json({ success: true, authorized: false });

        // Any admin (or IT Support, which has full admin parity) gets into
        // every client's VxSync automatically.
        if (user.role === "admin" || user.role === "it_support") {
          return json({ success: true, authorized: true, role: "admin" });
        }

        // Encoders only get in if an admin assigned them to this specific client.
        const { data: assignment } = await sb
          .from("assignments")
          .select("id")
          .eq("client_id", clientId)
          .eq("user_id", user.id)
          .maybeSingle();

        return json({ success: true, authorized: !!assignment, role: "encoder" });
      }

      // --------------------------------------------------------
      // Hub <-> VxSync data sync. Called server-to-server by each client's
      // VxSync Code.gs on a time-driven trigger (see syncStatsToHub_ /
      // installHubSyncTrigger in VxSyncCode.gs) - no Hub session, same
      // trust level as checkVxSyncAccess. Pushes a snapshot of that
      // client's current dashboard stats so the Hub can show "data as of
      // ___" without needing live Google Sheets access itself, and records
      // whether the push succeeded so a stale/broken sync is visible to
      // admins instead of silently showing old numbers forever.
      case "syncClientVxSyncData": {
        const { clientId, recordsSynced, stats } = payload;
        if (!clientId) return json({ success: false, error: "clientId is required." });

        const { error } = await sb.from("client_vxsync_sync").upsert(
          {
            client_id: clientId,
            last_attempt_at: new Date().toISOString(),
            last_success_at: new Date().toISOString(),
            last_status: "success",
            last_records_synced: Number(recordsSynced) || 0,
            last_error_message: null,
          },
          { onConflict: "client_id" }
        );
        if (error) return json({ success: false, error: error.message });

        const { data: client } = await sb.from("clients").select("name").eq("id", clientId).maybeSingle();
        logEvent(
          "vxsync",
          `Sync successful: ${(client && client.name) || "A client"}'s data synced to the Hub (${Number(recordsSynced) || 0} records)`,
          null,
          { clientId, actionType: "system" }
        );
        return json({ success: true, stats: stats || null });
      }

      // --------------------------------------------------------
      // Called by VxSync's Code.gs when a scheduled sync attempt itself
      // fails (e.g. the Sheet lookup threw) - VxSync can't log to the
      // Hub's audit_log directly (it has no DB access, only this API), so
      // it reports the failure here instead of the numbers.
      case "reportSyncFailure": {
        const { clientId, errorMessage } = payload;
        if (!clientId) return json({ success: false, error: "clientId is required." });

        await sb.from("client_vxsync_sync").upsert(
          {
            client_id: clientId,
            last_attempt_at: new Date().toISOString(),
            last_status: "failed",
            last_error_message: (errorMessage || "Unknown error").toString().slice(0, 500),
          },
          { onConflict: "client_id" }
        );

        const { data: client } = await sb.from("clients").select("name").eq("id", clientId).maybeSingle();
        logEvent(
          "vxsync",
          `Sync failed: ${(client && client.name) || "A client"}'s data could not be synced to the Hub (Error: ${(errorMessage || "Unknown error").toString().slice(0, 200)})`,
          null,
          { clientId, actionType: "system" }
        );
        return json({ success: true });
      }

      // --------------------------------------------------------
      // Read-side: lets the Hub frontend show "Data as of ___" / a stale-
      // data warning on each client card.
      case "getClientSyncStatus": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const clientId = Number(payload.clientId);
        if (!clientId) return json({ success: false, error: "clientId is required." });

        const { data } = await sb.from("client_vxsync_sync").select("*").eq("client_id", clientId).maybeSingle();
        return json({
          success: true,
          status: data
            ? {
                lastAttemptAt: data.last_attempt_at,
                lastSuccessAt: data.last_success_at,
                lastStatus: data.last_status,
                lastRecordsSynced: data.last_records_synced,
                lastErrorMessage: data.last_error_message,
              }
            : { lastStatus: "never" },
        });
      }

      // --------------------------------------------------------
      // Lets an existing admin add a new admin account. Unlike encoder temp
      // passwords (7-day expiry, role="encoder"), an admin account has no
      // expiry and must_change_password is forced true, same as the very
      // first seed admin in schema.sql - this is the UI-driven version of
      // that same bootstrap, so nobody has to hand-run SQL to add one.
      case "addAdmin": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { email, name } = payload;
        const newRole = payload.role === "it_support" ? "it_support" : "admin";
        if (!email || !name) return json({ success: false, error: "Email and name are required." });
        if (!isValidEmail_(email)) return json({ success: false, error: `"${email}" doesn't look like a valid email address.` });

        const plain = randomPassword();
        const hash = await bcrypt.hash(plain, 10);

        const { error } = await sb.from("users").upsert(
          {
            email,
            display_name: name,
            password_hash: hash,
            role: newRole,
            must_change_password: true,
            expires_at: null,
            duration_days: null,
          },
          { onConflict: "email" }
        );
        if (error) return json({ success: false, error: error.message });

        const actor = await getActor(session);
        const roleLabel = newRole === "it_support" ? "IT Support" : "Admin";
        logEvent("password", `${roleLabel} account created for ${name} by ${actor.name}`, actor);

        // Same one-time-reveal rule as encoder temp passwords - shown here,
        // never retrievable again after this response.
        return json({ success: true, password: plain });
      }

      // --------------------------------------------------------
      case "getAdmins": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { data } = await sb
          .from("users")
          .select("email, display_name, created_at, must_change_password, role, login_locked")
          .in("role", ["admin", "it_support"])
          .order("created_at", { ascending: false });

        const admins = (data || []).map((u: any) => ({
          email: u.email,
          displayName: u.display_name,
          created: new Date(u.created_at).getTime(),
          pendingSetup: !!u.must_change_password,
          role: u.role,
          loginLocked: !!u.login_locked,
        }));
        return json({ success: true, admins });
      }

      // --------------------------------------------------------
      // Removes an admin/IT Support account entirely. Two hard safety
      // rails, since this is permanent and this account type has full
      // system access: you can't remove your own currently-logged-in
      // account (log in as a different one to do that), and you can't
      // remove the last admin/IT Support account left - the Hub always
      // needs at least one that can log in and manage it.
      case "deleteAdmin": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { email } = payload;
        if (!email) return json({ success: false, error: "Email is required." });

        const { data: target } = await sb
          .from("users")
          .select("id, email, display_name, role")
          .eq("email", email)
          .maybeSingle();
        if (!target || (target.role !== "admin" && target.role !== "it_support")) {
          return json({ success: false, error: "Admin/IT Support account not found." });
        }

        if (target.id === session.user_id) {
          return json({
            success: false,
            error: "You can't remove your own account while logged in as it. Log in as a different admin/IT Support account to remove this one.",
          });
        }

        const { count } = await sb
          .from("users")
          .select("id", { count: "exact", head: true })
          .in("role", ["admin", "it_support"]);
        if ((count || 0) <= 1) {
          return json({
            success: false,
            error: "This is the only admin/IT Support account left - the Hub needs at least one to keep working.",
          });
        }

        const { error } = await sb.from("users").delete().eq("id", target.id);
        if (error) return json({ success: false, error: error.message });

        // Sign them out immediately rather than leaving their session
        // valid until it naturally expires on its own.
        await sb.from("sessions").delete().eq("user_id", target.id);

        const actor = await getActor(session);
        const roleLabel = target.role === "it_support" ? "IT Support" : "Admin";
        logEvent("password", `${roleLabel} account removed for ${target.display_name} by ${actor.name}`, actor);
        return json({ success: true });
      }

      // --------------------------------------------------------
      // Accounts (any role) currently locked out after 5 failed login
      // attempts - surfaced as an alert in the Admin Accounts panel so an
      // admin/IT Support can clear it without digging through the database.
      case "getLockedAccounts": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { data } = await sb
          .from("users")
          .select("id, email, display_name, role")
          .eq("login_locked", true)
          .order("display_name", { ascending: true });

        const locked = (data || []).map((u: any) => ({
          userId: u.id,
          email: u.email,
          displayName: u.display_name,
          role: u.role,
        }));
        return json({ success: true, locked });
      }

      // --------------------------------------------------------
      case "unlockAccount": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { userId } = payload;
        if (!userId) return json({ success: false, error: "userId is required." });

        const { data: target } = await sb.from("users").select("display_name").eq("id", userId).maybeSingle();
        const { error } = await sb
          .from("users")
          .update({ login_locked: false, failed_login_attempts: 0 })
          .eq("id", userId);
        if (error) return json({ success: false, error: error.message });

        const actor = await getActor(session);
        logEvent("password", `Login lockout cleared for ${target ? target.display_name : "an account"} by ${actor.name}`, actor);
        return json({ success: true });
      }

      // --------------------------------------------------------
      // "Contact IT Support" - submitted from the Help modal by ANY logged-in
      // user (not admin-gated; a locked-out encoder still needs to be able to
      // reach IT). Emails IT_SUPPORT_EMAIL immediately with who/when/what,
      // and also stores the ticket so an IT Support account has a real
      // in-Hub inbox instead of only ever seeing raw email.
      case "submitHelpTicket": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Please log in again." });

        const message = (payload.message || "").toString().trim();
        if (!message) return json({ success: false, error: "Please describe the issue before sending." });

        const allowedPriorities = ["low", "normal", "high", "urgent"];
        const priority = allowedPriorities.includes(payload.priority) ? payload.priority : "normal";

        const { data: user } = await sb
          .from("users")
          .select("email, display_name")
          .eq("id", session.user_id)
          .maybeSingle();
        const submitterEmail = (user && user.email) || session.role;
        const submitterName = (user && user.display_name) || "Unknown user";

        const { error } = await sb.from("help_tickets").insert({
          submitter_user_id: session.user_id,
          submitter_email: submitterEmail,
          submitter_name: submitterName,
          message,
          priority,
          source: "hub",
        });
        if (error) return json({ success: false, error: error.message });

        const now = new Date();
        const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
        const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        const priorityLabel = priority.charAt(0).toUpperCase() + priority.slice(1);

        await sendEmail(
          IT_SUPPORT_EMAIL,
          `PQ Hub - [${priorityLabel}] Help Request from ${submitterName}`,
          emailShell({
            title: "❓ Help Request",
            bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
                        <tr><td style="padding:2px 0;color:#8a97ab;width:90px;">Priority</td><td style="padding:2px 0;font-weight:600;">${priorityLabel}</td></tr>
                        <tr><td style="padding:2px 0;color:#8a97ab;">From</td><td style="padding:2px 0;">${submitterName} (${submitterEmail})</td></tr>
                        <tr><td style="padding:2px 0;color:#8a97ab;">When</td><td style="padding:2px 0;">${dateStr}, ${timeStr}</td></tr>
                       </table>
                       <p style="margin:16px 0 0;padding:12px 14px;background:#f4f7fb;border-radius:8px;white-space:pre-wrap;">${message.replace(/\n/g, "<br>")}</p>
                       <p style="margin:14px 0 0;font-size:13px;color:#8a97ab;">Just hit Reply to respond directly to ${submitterName}.</p>`,
          }),
          submitterEmail
        );

        logTicketEvent(`Help ticket submitted by ${submitterName} (from the Hub)`, {
          name: submitterName,
          email: submitterEmail,
        });
        return json({ success: true });
      }

      // --------------------------------------------------------
      // Same as submitHelpTicket above, but for VxSync's own "Contact IT
      // Support" fallback (the help widget's issues don't cover it) - called
      // server-to-server from Code.gs, same trust model as
      // checkVxSyncAccess/logVxSyncActivity, since a VxSync user never holds
      // a Hub session token.
      case "submitHelpTicketFromVxSync": {
        const { clientId, clientName, submitterName, submitterEmail, message, priority } = payload;
        const cleanMessage = (message || "").toString().trim();
        if (!cleanMessage) return json({ success: false, error: "Please describe the issue before sending." });
        if (!submitterEmail) return json({ success: false, error: "submitterEmail is required." });

        const allowedPriorities = ["low", "normal", "high", "urgent"];
        const ticketPriority = allowedPriorities.includes(priority) ? priority : "normal";
        const name = submitterName || submitterEmail;

        const { error } = await sb.from("help_tickets").insert({
          submitter_user_id: null,
          submitter_email: submitterEmail,
          submitter_name: name,
          message: cleanMessage,
          priority: ticketPriority,
          source: "vxsync",
          source_client_name: clientName || null,
        });
        if (error) return json({ success: false, error: error.message });

        const now = new Date();
        const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
        const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        const priorityLabel = ticketPriority.charAt(0).toUpperCase() + ticketPriority.slice(1);

        await sendEmail(
          IT_SUPPORT_EMAIL,
          `PQ Hub - [${priorityLabel}] VxSync Help Request from ${name}${clientName ? " (" + clientName + ")" : ""}`,
          emailShell({
            title: `❓ Help Request — VxSync${clientName ? " · " + clientName : ""}`,
            bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
                        <tr><td style="padding:2px 0;color:#8a97ab;width:90px;">Priority</td><td style="padding:2px 0;font-weight:600;">${priorityLabel}</td></tr>
                        <tr><td style="padding:2px 0;color:#8a97ab;">From</td><td style="padding:2px 0;">${name} (${submitterEmail})</td></tr>
                        <tr><td style="padding:2px 0;color:#8a97ab;">When</td><td style="padding:2px 0;">${dateStr}, ${timeStr}</td></tr>
                       </table>
                       <p style="margin:16px 0 0;padding:12px 14px;background:#f4f7fb;border-radius:8px;white-space:pre-wrap;">${cleanMessage.replace(/\n/g, "<br>")}</p>
                       <p style="margin:14px 0 0;font-size:13px;color:#8a97ab;">Just hit Reply to respond directly to ${name}.</p>`,
          }),
          submitterEmail
        );

        logTicketEvent(
          `Help ticket submitted by ${name}${clientName ? " (VxSync — " + clientName + ")" : " (from VxSync)"}`,
          { name, email: submitterEmail },
          clientId || null
        );
        return json({ success: true });
      }

      // --------------------------------------------------------
      // "Report a Bug" - deliberately NOT stored in help_tickets and never
      // shows up in the Hub's ticket inbox. It's a pure email-to-IT-Support
      // path: any logged-in user can free-type a bug report, it goes
      // straight to IT_SUPPORT_EMAIL with Reply-To set to the reporter, and
      // it's logged to the audit trail for a paper trail - but there is no
      // database row to triage, resolve, or archive. Keeping this
      // completely separate from submitHelpTicket is intentional so the
      // ticket inbox only ever contains real support tickets.
      case "reportBug": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Please log in again." });

        const message = (payload.message || "").toString().trim();
        if (!message) return json({ success: false, error: "Please describe the bug before sending." });

        const { data: user } = await sb
          .from("users")
          .select("email, display_name")
          .eq("id", session.user_id)
          .maybeSingle();
        const submitterEmail = (user && user.email) || session.role;
        const submitterName = (user && user.display_name) || "Unknown user";

        const now = new Date();
        const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
        const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

        await sendEmail(
          IT_SUPPORT_EMAIL,
          `PQ Hub - 🐛 Bug Report from ${submitterName}`,
          emailShell({
            title: "🐛 Bug Report",
            bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
                        <tr><td style="padding:2px 0;color:#8a97ab;width:90px;">From</td><td style="padding:2px 0;">${submitterName} (${submitterEmail})</td></tr>
                        <tr><td style="padding:2px 0;color:#8a97ab;">When</td><td style="padding:2px 0;">${dateStr}, ${timeStr}</td></tr>
                       </table>
                       <p style="margin:16px 0 0;padding:12px 14px;background:#f4f7fb;border-radius:8px;white-space:pre-wrap;">${message.replace(/\n/g, "<br>")}</p>
                       <p style="margin:14px 0 0;font-size:13px;color:#8a97ab;">Just hit Reply to respond directly to ${submitterName}.</p>`,
          }),
          submitterEmail
        );

        logEvent("password", `Bug report submitted by ${submitterName} (from the Hub)`, {
          name: submitterName,
          email: submitterEmail,
        });
        return json({ success: true });
      }

      // --------------------------------------------------------
      // Same as reportBug above, but for VxSync's help widget's bug-report
      // path - server-to-server, same trust model as
      // submitHelpTicketFromVxSync. Also email-only, no help_tickets row.
      case "reportBugFromVxSync": {
        const { clientId, clientName, submitterName, submitterEmail, message } = payload;
        const cleanMessage = (message || "").toString().trim();
        if (!cleanMessage) return json({ success: false, error: "Please describe the bug before sending." });
        if (!submitterEmail) return json({ success: false, error: "submitterEmail is required." });

        const name = submitterName || submitterEmail;
        const now = new Date();
        const dateStr = now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
        const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

        await sendEmail(
          IT_SUPPORT_EMAIL,
          `PQ Hub - 🐛 Bug Report (VxSync) from ${name}${clientName ? " (" + clientName + ")" : ""}`,
          emailShell({
            title: `🐛 Bug Report — VxSync${clientName ? " · " + clientName : ""}`,
            bodyHtml: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
                        <tr><td style="padding:2px 0;color:#8a97ab;width:90px;">From</td><td style="padding:2px 0;">${name} (${submitterEmail})</td></tr>
                        <tr><td style="padding:2px 0;color:#8a97ab;">When</td><td style="padding:2px 0;">${dateStr}, ${timeStr}</td></tr>
                       </table>
                       <p style="margin:16px 0 0;padding:12px 14px;background:#f4f7fb;border-radius:8px;white-space:pre-wrap;">${cleanMessage.replace(/\n/g, "<br>")}</p>
                       <p style="margin:14px 0 0;font-size:13px;color:#8a97ab;">Just hit Reply to respond directly to ${name}.</p>`,
          }),
          submitterEmail
        );

        logEvent(
          "vxsync",
          `Bug report submitted by ${name}${clientName ? " (VxSync — " + clientName + ")" : " (from VxSync)"}`,
          { name, email: submitterEmail },
          clientId ? { clientId } : undefined
        );
        return json({ success: true });
      }

      // --------------------------------------------------------
      case "getHelpTickets": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });
        if (session.role !== "it_support") return json({ success: false, error: "IT Support only." });

        const { data } = await sb
          .from("help_tickets")
          .select("*")
          .order("created_at", { ascending: false });

        const priorityRank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
        const tickets = (data || [])
          .map((t: any) => ({
            id: t.id,
            submitterName: t.submitter_name,
            submitterEmail: t.submitter_email,
            message: t.message,
            priority: t.priority || "normal",
            status: t.status,
            archived: !!t.archived,
            createdAt: t.created_at,
            resolvedAt: t.resolved_at,
            // Powers the Hub vs VxSync visual tag in the ticket inbox.
            source: t.source || "hub",
            sourceClientName: t.source_client_name || null,
          }))
          // Open tickets surface most-urgent-first; once resolved, priority
          // no longer matters, so those just stay in the newest-first order
          // the query already returned them in.
          .sort((a: any, b: any) => {
            if (a.status !== b.status) return a.status === "open" ? -1 : 1;
            if (a.status === "open") {
              const rankDiff = (priorityRank[a.priority] ?? 2) - (priorityRank[b.priority] ?? 2);
              if (rankDiff !== 0) return rankDiff;
            }
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          });
        return json({ success: true, tickets });
      }

      // --------------------------------------------------------
      case "resolveHelpTicket": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });
        if (session.role !== "it_support") return json({ success: false, error: "IT Support only." });

        const { ticketId } = payload;
        if (!ticketId) return json({ success: false, error: "ticketId is required." });

        const { data: ticket } = await sb
          .from("help_tickets")
          .select("submitter_email, submitter_name, message")
          .eq("id", ticketId)
          .maybeSingle();

        const { error } = await sb
          .from("help_tickets")
          .update({ status: "resolved", resolved_by_user_id: session.user_id, resolved_at: new Date().toISOString() })
          .eq("id", ticketId);
        if (error) return json({ success: false, error: error.message });

        // Whoever submitted this ticket may well not be logged into the Hub
        // right now (that's often exactly why they filed it) - email is the
        // one channel that reaches them regardless, same reasoning as every
        // other notification this feature set sends.
        if (ticket && ticket.submitter_email) {
          const resolvedNow = new Date();
          const dateStr = resolvedNow.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
          const timeStr = resolvedNow.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          sendEmail(
            ticket.submitter_email,
            "[COMPANY_NAME] Hub - Your help request has been resolved",
            `<p>Hi ${ticket.submitter_name || ""},</p>
             <p>Your help request has been marked resolved by IT Support as of ${dateStr} at ${timeStr}.</p>
             <p><strong>Your original request:</strong></p>
             <p>${(ticket.message || "").replace(/\n/g, "<br>")}</p>
             <p>If this didn't actually fix your issue, just submit a new request from the Help button in the Hub.</p>`
          );
        }

        const actor = await getActor(session);
        logTicketEvent(
          `Help ticket from ${ticket ? ticket.submitter_name : "someone"} marked resolved by ${actor.name}`,
          actor
        );

        return json({ success: true });
      }

      // --------------------------------------------------------
      // Moves a ticket into/out of the Archive drawer - a purely
      // organizational flag for IT Support (does NOT change status/
      // resolved-ness). Drag-and-drop on the frontend calls this both ways.
      case "setTicketArchived": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });
        if (session.role !== "it_support") return json({ success: false, error: "IT Support only." });

        const { ticketId, archived } = payload;
        if (!ticketId) return json({ success: false, error: "ticketId is required." });

        const { error } = await sb
          .from("help_tickets")
          .update({ archived: !!archived })
          .eq("id", ticketId);
        if (error) return json({ success: false, error: error.message });
        return json({ success: true });
      }

      // --------------------------------------------------------
      // Polled by EVERY logged-in role (not just IT Support) so whoever
      // filed a ticket gets an in-Hub toast the moment it's resolved, on
      // top of the email that already goes out from resolveHelpTicket.
      // Only ever returns this user's OWN tickets, and only ones not yet
      // acknowledged - see ackTicketNotices below.
      case "getMyTicketNotices": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Please log in again." });

        const { data } = await sb
          .from("help_tickets")
          .select("id, message, resolved_at")
          .eq("submitter_user_id", session.user_id)
          .eq("status", "resolved")
          .eq("submitter_notified", false);

        const tickets = (data || []).map((t: any) => ({
          id: t.id,
          message: t.message,
          resolvedAt: t.resolved_at,
        }));
        return json({ success: true, tickets });
      }

      // --------------------------------------------------------
      case "ackTicketNotices": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Please log in again." });

        const ticketIds = Array.isArray(payload.ticketIds) ? payload.ticketIds : [];
        if (!ticketIds.length) return json({ success: true });

        // Scoped to this user's own tickets too, not just the id list, so a
        // caller can never mark someone else's ticket as acknowledged.
        const { error } = await sb
          .from("help_tickets")
          .update({ submitter_notified: true })
          .in("id", ticketIds)
          .eq("submitter_user_id", session.user_id);
        if (error) return json({ success: false, error: error.message });
        return json({ success: true });
      }

      // --------------------------------------------------------
      // Same pattern as getMyTicketNotices - polled by every logged-in
      // role, only ever this user's own unacknowledged rows. Populated by
      // deleteClient when a client this user was assigned to gets deleted,
      // so an encoder finds out WHY a client vanished from their list
      // instead of just noticing it's gone.
      case "getMyAssignmentNotices": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Please log in again." });

        const { data } = await sb
          .from("assignment_notices")
          .select("id, message, created_at")
          .eq("user_id", session.user_id)
          .eq("acknowledged", false);

        const notices = (data || []).map((n: any) => ({
          id: n.id,
          message: n.message,
          createdAt: n.created_at,
        }));
        return json({ success: true, notices });
      }

      // --------------------------------------------------------
      case "ackAssignmentNotices": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Please log in again." });

        const noticeIds = Array.isArray(payload.noticeIds) ? payload.noticeIds : [];
        if (!noticeIds.length) return json({ success: true });

        // Scoped to this user's own notices too, not just the id list, so
        // a caller can never mark someone else's notice as acknowledged.
        const { error: ackErr } = await sb
          .from("assignment_notices")
          .update({ acknowledged: true })
          .in("id", noticeIds)
          .eq("user_id", session.user_id);
        if (ackErr) return json({ success: false, error: ackErr.message });
        return json({ success: true });
      }

      // --------------------------------------------------------
      // PATCH NOTES - a "what's changed" banner shown once to every Hub
      // user (admin/IT Support). Two ways to post one:
      //   1) From inside the Hub, logged in as an admin/IT Support (a real
      //      session token is sent) - this is the normal path.
      //   2) From the Netlify maintenance-mode toggle, which has no Hub
      //      session at all - it instead sends payload.serviceSecret
      //      matching MAINTENANCE_TOGGLE_SECRET. Lets "turn maintenance off"
      //      and "post what changed" happen in one step when you want that;
      //      entirely optional, and posting from inside the Hub works fine
      //      without ever setting that secret.
      case "createPatchNotes": {
        let publishedByName = "Admin";
        if (payload.serviceSecret && MAINTENANCE_TOGGLE_SECRET && payload.serviceSecret === MAINTENANCE_TOGGLE_SECRET) {
          publishedByName = "System (maintenance toggle)";
        } else {
          const session = await requireAdmin(token);
          if (!session) return json({ success: false, error: "Admins only." });
          if (session.role !== "it_support") return json({ success: false, error: "IT Support only." });
          const actor = await getActor(session);
          publishedByName = actor.name;
        }

        const title = (payload.title || "").toString().trim();
        const body = (payload.body || "").toString().trim();
        const version = (payload.version || "").toString().trim();
        if (!title || !body) return json({ success: false, error: "Title and body are both required." });
        if (!version) return json({ success: false, error: "Version number is required - it's what the version badge shown to everyone gets updated to." });

        const { data, error } = await sb
          .from("patch_notes")
          .insert({ title, body, published_by_name: publishedByName, version })
          .select()
          .single();
        if (error) return json({ success: false, error: error.message });

        logEvent("password", `Patch notes posted: "${title}" (v${version}) by ${publishedByName}`);
        return json({ success: true, id: data.id, version });
      }

      // --------------------------------------------------------
      // Powers the small version badge shown to EVERYONE, logged in or
      // not (the login page shows it too) - deliberately no auth check,
      // this is just a display string, not sensitive. The Hub's version
      // is whatever the most recently posted patch note's version field
      // says; the version bump and the "what changed" writeup are meant
      // to happen together, in the same Post Patch Notes form, rather
      // than being two things someone has to remember to keep in sync.
      // Falls back to "2.0" (the starting baseline) if no patch note has
      // ever been posted yet.
      case "getHubVersion": {
        const { data: latest } = await sb
          .from("patch_notes")
          .select("version")
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle();
        return json({ success: true, version: (latest && latest.version) || "2.0" });
      }

      // --------------------------------------------------------
      // Admin-only link to the master VxSync template Sheet (see
      // GOOGLE_MASTER_SHEET_ID above) - lets admins add/update default
      // vaccinators/vaccines etc. directly in Google Sheets before
      // provisioning new clients, without needing the raw file ID typed
      // anywhere in the frontend. Only affects clients provisioned AFTER
      // an edit here - existing clients are independent copies made at
      // provisioning time and are not retroactively affected.
      // --------------------------------------------------------
      case "getMasterSheetUrl": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });
        if (!GOOGLE_MASTER_SHEET_ID) {
          return json({ success: false, error: "GOOGLE_MASTER_SHEET_ID isn't set yet." });
        }
        return json({ success: true, url: `https://docs.google.com/spreadsheets/d/${GOOGLE_MASTER_SHEET_ID}/edit` });
      }

      // --------------------------------------------------------
      // Admin-only. Deletes the Hub's `clients` row (cascading to
      // `assignments` via its own ON DELETE CASCADE and to
      // `client_vxsync_sync` the same way; `audit_log.client_id` is
      // ON DELETE SET NULL, so history is kept, just unlinked) AND
      // permanently deletes the client's Google Sheet and Apps Script
      // project via Drive's files.delete - not a trash/soft-delete.
      // Drive cleanup runs FIRST, but the clients row is deleted
      // regardless of whether Drive cleanup succeeds: a client with a
      // lingering Drive file but no more Hub access is a smaller
      // problem than a client that still has live access because we
      // were waiting on Drive. Any Drive failure (or a client
      // provisioned before drive_sheet_id/drive_script_id existed) is
      // reported back in driveResults so it can be cleaned up by hand,
      // never silently swallowed.
      // --------------------------------------------------------
      case "deleteClient": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const clientId = payload.clientId;
        if (!clientId) return json({ success: false, error: "clientId is required." });

        const { data: client } = await sb
          .from("clients")
          .select("name, drive_sheet_id, drive_script_id")
          .eq("id", clientId)
          .maybeSingle();
        if (!client) return json({ success: false, error: "Client not found." });

        // Captured BEFORE the delete below - assignments.client_id cascades
        // away at the DB level the instant the clients row goes, so this is
        // the last point these encoders' user_ids are still findable via
        // this client. Used after the delete to notify each of them (see
        // assignment_notices insert further down).
        const { data: affectedAssignments } = await sb
          .from("assignments")
          .select("user_id")
          .eq("client_id", clientId);

        const driveResults: { sheet?: string; script?: string } = {};
        let accessToken: string | null = null;
        try {
          accessToken = await getGoogleAccessToken_();
        } catch (tokenErr: any) {
          const msg = "Drive cleanup skipped (" + (tokenErr && tokenErr.message ? tokenErr.message : String(tokenErr)) + ")";
          if (client.drive_sheet_id) driveResults.sheet = msg;
          if (client.drive_script_id) driveResults.script = msg;
        }

        if (accessToken) {
          if (client.drive_sheet_id) {
            try {
              const r = await deleteGoogleFile_(client.drive_sheet_id, accessToken);
              driveResults.sheet = r.status === "already_gone" ? "already gone" : "deleted";
            } catch (err: any) {
              driveResults.sheet = "FAILED: " + (err && err.message ? err.message : String(err));
            }
          } else {
            driveResults.sheet = "not recorded (provisioned before drive_sheet_id was tracked - clean up manually in Drive if needed)";
          }

          if (client.drive_script_id) {
            try {
              const r = await deleteGoogleFile_(client.drive_script_id, accessToken);
              driveResults.script = r.status === "already_gone" ? "already gone" : "deleted";
            } catch (err: any) {
              driveResults.script = "FAILED: " + (err && err.message ? err.message : String(err));
            }
          } else {
            driveResults.script = "not recorded (provisioned before drive_script_id was tracked - clean up manually in Drive if needed)";
          }
        }

        const { error: delErr } = await sb.from("clients").delete().eq("id", clientId);
        if (delErr) {
          return json({
            success: false,
            error: "Drive cleanup finished but the client row could not be deleted: " + delErr.message,
            driveResults,
          });
        }

        const actor = await getActor(session);
        const cleanupSummary = `Sheet: ${driveResults.sheet || "n/a"}; Script: ${driveResults.script || "n/a"}`;
        logEvent("vxsync", `Client ${client.name} deleted from the Hub by ${actor.name} (${cleanupSummary})`, actor, {
          clientId,
          actionType: "data_edit",
        });

        // Notify every encoder who was assigned to this now-deleted client -
        // never blocks the response on a failure here, since the delete
        // itself already succeeded above, but every notice is still
        // attempted, not silently skipped after the first error.
        for (const row of affectedAssignments || []) {
          const userId = (row as any).user_id;
          if (!userId) continue;
          const { data: remaining } = await sb
            .from("assignments")
            .select("clients(name)")
            .eq("user_id", userId);
          const remainingNames = (remaining || [])
            .map((r: any) => r.clients && r.clients.name)
            .filter(Boolean);
          const message = remainingNames.length
            ? `"${client.name}" was deleted. Your updated assignments are: ${remainingNames.join(", ")}.`
            : `"${client.name}" was deleted. You are now unassigned from all clients.`;
          const { error: noticeErr } = await sb.from("assignment_notices").insert({ user_id: userId, message });
          if (noticeErr) console.error("assignment_notices insert failed:", noticeErr.message);
        }

        return json({ success: true, driveResults });
      }

      // --------------------------------------------------------
      // Called on every Hub login/session check. Returns the newest patch
      // note ONLY if this user hasn't already dismissed it (or a later
      // one) - so it's a once-per-person banner, not a once-per-login one.
      case "getLatestPatchNotes": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Please log in again." });

        const { data: user } = await sb
          .from("users")
          .select("last_seen_patch_notes_id")
          .eq("id", session.user_id)
          .maybeSingle();
        const lastSeen = (user && user.last_seen_patch_notes_id) || 0;

        const { data: latest } = await sb
          .from("patch_notes")
          .select("id, title, body, created_at, published_by_name, version")
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!latest || latest.id <= lastSeen) return json({ success: true, note: null });

        return json({
          success: true,
          note: {
            id: latest.id,
            title: latest.title,
            body: latest.body,
            createdAt: latest.created_at,
            publishedByName: latest.published_by_name,
            version: latest.version,
          },
        });
      }

      // --------------------------------------------------------
      case "ackPatchNotes": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Please log in again." });

        const noteId = parseInt(payload.noteId, 10);
        if (!noteId) return json({ success: false, error: "noteId is required." });

        const { error } = await sb
          .from("users")
          .update({ last_seen_patch_notes_id: noteId })
          .eq("id", session.user_id);
        if (error) return json({ success: false, error: error.message });
        return json({ success: true });
      }

      // --------------------------------------------------------
      // On-demand re-view of the latest patch note - powers the small
      // persistent "What's New" link in the sidebar (visible to everyone,
      // any role). Unlike getLatestPatchNotes, this is NOT gated by
      // last_seen_patch_notes_id and has no ack side-effect - it just always
      // returns whatever the newest note is, so people can look it up again
      // any time after they've already dismissed the popup.
      case "getPatchNotesForViewing": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Please log in again." });

        const { data: latest } = await sb
          .from("patch_notes")
          .select("id, title, body, created_at, published_by_name, version")
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!latest) return json({ success: true, note: null });

        return json({
          success: true,
          note: {
            id: latest.id,
            title: latest.title,
            body: latest.body,
            createdAt: latest.created_at,
            publishedByName: latest.published_by_name,
            version: latest.version,
          },
        });
      }

      // --------------------------------------------------------
      // Full field edit for a client card - fixes typos in name/category/
      // links after the fact, separate from updateClientStatus (which only
      // ever touched the status dropdown).
      case "updateClient": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const c = payload.client || {};
        const { data: before } = await sb
          .from("clients")
          .select("name, category, app_url, sheet_url")
          .eq("id", payload.clientId)
          .maybeSingle();
        const { error } = await sb
          .from("clients")
          .update({
            name: c.name,
            category: c.category,
            initials: c.initials,
            last_updated: c.lastUpdated,
            app_url: c.appUrl,
            sheet_url: c.sheetUrl,
          })
          .eq("id", payload.clientId);
        if (error) return json({ success: false, error: error.message });

        const actor = await getActor(session);
        // Specific per-field wording per client instruction ("App URL
        // updated," "Google Sheet URL changed," "Category changed") rather
        // than one generic "card edited" line - falls back to the generic
        // line only if nothing we track actually changed (e.g. just
        // initials/last-updated text).
        const changedBits: string[] = [];
        if (before) {
          if (before.app_url !== c.appUrl) changedBits.push("App URL updated");
          if (before.sheet_url !== c.sheetUrl) changedBits.push("Google Sheet URL changed");
          if (before.category !== c.category) changedBits.push("Category changed");
        }
        logEvent(
          "vxsync",
          changedBits.length
            ? `${c.name}: ${changedBits.join(", ")} by ${actor.name}`
            : `Client ${c.name} card edited by ${actor.name}`,
          actor,
          { clientId: payload.clientId, actionType: "data_edit" }
        );
        return json({ success: true });
      }

      // --------------------------------------------------------
      // Assigns several ALREADY-KNOWN encoders (pending or active - see
      // getEncoders) to one client project in a single call. A given
      // encoder can be assigned to any number of different clients; the
      // only uniqueness constraint is per (client, encoder) pair, so
      // re-running this against a client they're already on just no-ops.
      case "assignEncodersBulk": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { clientId, userIds } = payload;
        if (!clientId || !Array.isArray(userIds) || !userIds.length) {
          return json({ success: false, error: "clientId and at least one userId are required." });
        }
        const rows = userIds.map((userId: string) => ({ client_id: clientId, user_id: userId }));
        const { error } = await sb.from("assignments").upsert(rows, { onConflict: "client_id,user_id" });
        if (error) return json({ success: false, error: error.message });

        const actor = await getActor(session);
        const [{ data: client }, { data: users }] = await Promise.all([
          sb.from("clients").select("name").eq("id", clientId).maybeSingle(),
          sb.from("users").select("display_name").in("id", userIds),
        ]);
        const clientName = client ? client.name : "a client";
        (users || []).forEach((u: any) => {
          logEvent("vxsync", `${u.display_name} assigned to ${clientName} by ${actor.name}`, actor, {
            clientId,
            actionType: "access",
          });
        });
        return json({ success: true, count: rows.length });
      }

      // --------------------------------------------------------
      // The "assign first, password later" flow: an admin picks a client
      // project and types in an encoder's email + name directly, WITHOUT
      // that encoder needing to exist yet. Creates a passwordless ("pending")
      // user row if one doesn't already exist for that email, then assigns
      // them to the client in the same call. An admin later generates a
      // password for that email in Password Management - nothing here
      // touches password_hash, so a real existing password is never
      // clobbered by re-assigning someone to another client.
      case "assignEncoderByEmail": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const { clientId, email, name } = payload;
        if (!clientId || !email || !name) {
          return json({ success: false, error: "clientId, email, and name are required." });
        }
        if (!isValidEmail_(email)) return json({ success: false, error: `"${email}" doesn't look like a valid email address.` });

        const { data: existingUser } = await sb.from("users").select("id, role").eq("email", email).maybeSingle();
        if (existingUser && (existingUser.role === "admin" || existingUser.role === "it_support")) {
          return json({ success: false, error: "That email belongs to an admin/IT Support account, not an encoder." });
        }

        let userId: string;
        if (existingUser) {
          userId = existingUser.id;
          // Keep display_name in sync (harmless typo-fix), but never touch
          // password_hash/expires_at here - that's Password Management's job.
          await sb.from("users").update({ display_name: name }).eq("id", userId);
        } else {
          const { data: inserted, error: insertErr } = await sb
            .from("users")
            .insert({
              email,
              display_name: name,
              password_hash: null,
              role: "encoder",
              must_change_password: true,
              expires_at: null,
              duration_days: null,
            })
            .select("id")
            .single();
          if (insertErr || !inserted) return json({ success: false, error: insertErr?.message || "Could not create encoder." });
          userId = inserted.id;
        }

        const { error: assignErr } = await sb
          .from("assignments")
          .upsert({ client_id: clientId, user_id: userId }, { onConflict: "client_id,user_id" });
        if (assignErr) return json({ success: false, error: assignErr.message });

        const actor = await getActor(session);
        const { data: client } = await sb.from("clients").select("name").eq("id", clientId).maybeSingle();
        logEvent("vxsync", `${name} assigned to ${client ? client.name : "a client"} by ${actor.name}`, actor, {
          clientId,
          actionType: "access",
        });

        return json({ success: true, userId });
      }

      // --------------------------------------------------------
      // Activity log for the "Action Log" side panel in the VxSync and
      // Password Management tabs. category is 'vxsync' or 'password'.
      // payload.date is a "YYYY-MM-DD" string in Asia/Manila local time -
      // the frontend defaults it to today and lets the admin page back
      // through past dates. Manila has no DST, so a fixed +08:00 offset is
      // always correct here.
      case "getAuditLog": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const category = payload.category === "password" ? "password" : "vxsync";
        const todayStr = todayManilaDateStr();
        // Nothing can be logged ahead of today - the frontend's date
        // picker already stops at today (max= plus a JS clamp on both
        // the shift buttons and manual typing), but this is the actual
        // security boundary: a future date passed directly to this
        // endpoint, bypassing the UI entirely, gets clamped here too
        // rather than trusted.
        let dateStr = /^\d{4}-\d{2}-\d{2}$/.test(payload.date || "") ? payload.date : todayStr;
        if (dateStr > todayStr) dateStr = todayStr;
        const dayStart = new Date(dateStr + "T00:00:00+08:00");
        const dayEnd = new Date(dateStr + "T23:59:59.999+08:00");
        // Optional "Filter by Action Type" - Data Edits / Access Changes /
        // System (sync events) / Help Tickets. Omit or pass "all" for no filter.
        const allowedActionTypes = ["data_edit", "access", "system", "ticket"];
        const actionType = allowedActionTypes.includes(payload.actionType) ? payload.actionType : null;

        let query = sb
          .from("audit_log")
          .select("id, message, created_at, actor_name, actor_email, client_id, action_type")
          .eq("category", category)
          .gte("created_at", dayStart.toISOString())
          .lte("created_at", dayEnd.toISOString());
        if (actionType) query = query.eq("action_type", actionType);
        const { data, error } = await query.order("created_at", { ascending: false }).limit(200);
        if (error) return json({ success: false, error: error.message });

        return json({
          success: true,
          entries: (data || []).map((e: any) => ({
            id: e.id,
            message: e.message,
            actorName: e.actor_name,
            actorEmail: e.actor_email,
            createdAt: e.created_at,
            clientId: e.client_id,
            actionType: e.action_type,
          })),
          date: dateStr,
        });
      }

      // --------------------------------------------------------
      // Powers the per-client "Activity Logs" button/modal on each client
      // card - every logged event tagged with this client_id, either
      // category, newest first.
      case "getClientActivityLog": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const clientId = Number(payload.clientId);
        if (!clientId) return json({ success: false, error: "clientId is required." });

        const { data, error } = await sb
          .from("audit_log")
          .select("id, category, message, created_at, actor_name, actor_email, action_type")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .limit(300);
        if (error) return json({ success: false, error: error.message });

        return json({
          success: true,
          entries: (data || []).map((e: any) => ({
            id: e.id,
            category: e.category,
            message: e.message,
            actorName: e.actor_name,
            actorEmail: e.actor_email,
            createdAt: e.created_at,
            actionType: e.action_type,
          })),
        });
      }

      // --------------------------------------------------------
      // Polled every ~15s while an admin/IT Support user is logged in (any
      // view, not just the Activity Log drawer) to power the "New activity
      // registered!" notification + unread badge. Returns whatever's been
      // logged - EITHER category - since the id the frontend last saw,
      // oldest first. sinceId=0 (a fresh login with nothing recorded yet)
      // deliberately returns nothing rather than the entire history, so a
      // brand-new session doesn't get flooded with "new" notifications for
      // things that happened before they ever logged in.
      case "getActivityFeedSince": {
        const session = await requireAdmin(token);
        if (!session) return json({ success: false, error: "Admins only." });

        const sinceId = Number(payload.sinceId) || 0;
        if (!sinceId) {
          const { data: latest } = await sb
            .from("audit_log")
            .select("id")
            .order("id", { ascending: false })
            .limit(1)
            .maybeSingle();
          return json({ success: true, entries: [], latestId: latest ? latest.id : 0 });
        }

        const { data, error } = await sb
          .from("audit_log")
          .select("id, category, message, created_at, actor_name, actor_email")
          .gt("id", sinceId)
          .order("id", { ascending: true })
          .limit(50);
        if (error) return json({ success: false, error: error.message });

        const entries = (data || []).map((e: any) => ({
          id: e.id,
          category: e.category,
          message: e.message,
          actorName: e.actor_name,
          actorEmail: e.actor_email,
          createdAt: e.created_at,
        }));
        const latestId = entries.length ? entries[entries.length - 1].id : sinceId;
        return json({ success: true, entries, latestId });
      }

      // --------------------------------------------------------
      // Logged from the encoder/admin side when they open VxSync for a
      // client (either the Entry Form or the Program Dashboard tab) -
      // gives admins visibility into VxSync usage without needing VxSync's
      // own logs. Any logged-in user may call this (not admin-gated - it's
      // the caller's own action being recorded), but it only ever writes a
      // log line, nothing else. This is called from VxSync's Code.gs
      // itself (server-to-server, via CONFIG.hubApiUrl/hubAnonKey), same as
      // checkVxSyncAccess - see logVxSyncActivity_ in VxSyncCode.gs.
      case "logEncoderActivity": {
        const session = await getSession(token);
        if (!session) return json({ success: false, error: "Session expired, please log in again." });

        const clientName = (payload.clientName || "").toString().trim();
        if (!clientName) return json({ success: false, error: "clientName is required." });
        const view = payload.view === "dashboard" ? "Program Dashboard" : "Entry Form";

        const actor = await getActor(session);
        logEvent("vxsync", `${clientName}'s ${view} has been accessed by ${actor.name}`, actor, {
          clientId: payload.clientId || null,
          actionType: "access",
        });
        return json({ success: true });
      }

      // --------------------------------------------------------
      // Same as logEncoderActivity above, but for a VxSync Google-account
      // user, who never held a Hub session token at all (VxSync's own
      // sign-in is Google, not the Hub's password login) - so this is
      // server-to-server, authenticated only by the anon key (same trust
      // level as checkVxSyncAccess), with the actor's name/email supplied
      // directly by VxSync rather than looked up from a Hub session.
      case "logVxSyncActivity": {
        const { clientId, clientName, actorName, actorEmail, view } = payload;
        if (!clientId || !clientName) {
          return json({ success: false, error: "clientId and clientName are required." });
        }
        const viewLabel = view === "dashboard" ? "Program Dashboard" : "Entry Form";
        logEvent(
          "vxsync",
          `${clientName}'s ${viewLabel} has been accessed by ${actorName || actorEmail || "a VxSync user"}`,
          { name: actorName || "Unknown", email: actorEmail || "" },
          { clientId, actionType: "access" }
        );
        return json({ success: true });
      }

      // --------------------------------------------------------
      default:
        return json({ success: false, error: "Unknown action" }, 400);
    }
  } catch (err) {
    return json({ success: false, error: String((err as any)?.message || err) }, 500);
  }
});