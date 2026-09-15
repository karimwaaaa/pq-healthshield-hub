// ============================================================
// The actual on/off switch. Hit this URL (GET or POST both work below)
// to flip maintenance mode instantly - no redeploy, takes effect on the
// very next request because maintenance-gate.ts reads with strong
// consistency.
//
// Usage (replace YOUR-SECRET with the same value as MAINTENANCE_BYPASS_TOKEN
// in Netlify env vars - reusing that one secret keeps this simple; swap in
// a second dedicated env var if you'd rather keep "read the site during
// an outage" and "turn the outage screen on/off" as separate permissions):
//
//   Turn ON,  default message:
//     https://your-hub.netlify.app/toggle-maintenance?token=YOUR-SECRET&state=on
//
//   Turn ON with a custom message:
//     https://your-hub.netlify.app/toggle-maintenance?token=YOUR-SECRET&state=on&message=Upgrading%20the%20database%2C%20back%20by%203%20PM.
//
//   Turn OFF:
//     https://your-hub.netlify.app/toggle-maintenance?token=YOUR-SECRET&state=off
//
//   Turn OFF and post patch notes in the same step (optional - only if
//   this was a significant-changes maintenance window):
//     https://your-hub.netlify.app/toggle-maintenance?token=YOUR-SECRET&state=off&patchTitle=Sept%2012%20update&patchBody=Fixed%20the%20PDF%20export%20bug.
//   Requires three more env vars set on this Netlify site: SUPABASE_URL,
//   SUPABASE_ANON_KEY (both from Supabase Project Settings -> API), and
//   MAINTENANCE_TOGGLE_SECRET (any string YOU make up - must match the
//   Supabase Function secret of the same name). If those aren't set, the
//   maintenance toggle itself still works fine - patch notes just won't
//   get posted, and the response tells you that plainly instead of
//   silently doing nothing.
//
// Just visit the URL in a browser tab - it returns a plain-text
// confirmation. No UI needed, though this can be wired into a button in
// the Hub's Admin panel later if you want that instead of a bookmarked URL.
// ============================================================
import { getStore } from "@netlify/blobs";
import type { Config, Context } from "@netlify/functions";

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const expected = Netlify.env.get("MAINTENANCE_BYPASS_TOKEN");

  if (!expected) {
    return new Response(
      "MAINTENANCE_BYPASS_TOKEN isn't set in this site's environment variables yet - set one in Netlify Site settings -> Environment variables, then redeploy once, then this endpoint will work.",
      { status: 500 }
    );
  }

  if (token !== expected) {
    return new Response("Forbidden - missing or incorrect token.", { status: 403 });
  }

  const state = (url.searchParams.get("state") || "").toLowerCase();
  if (state !== "on" && state !== "off") {
    return new Response("Pass state=on or state=off as a query parameter.", { status: 400 });
  }

  const store = getStore("hub-maintenance");

  if (state === "on") {
    const message = url.searchParams.get("message") ||
      "The Hub is temporarily offline for maintenance. Please check back shortly.";
    await store.set("enabled", "true");
    await store.set("message", message);
    return new Response(`Maintenance mode is now ON.\nMessage: ${message}`, { status: 200 });
  }

  await store.set("enabled", "false");
  let resultText = "Maintenance mode is now OFF.";

  const patchTitle = url.searchParams.get("patchTitle");
  const patchBody = url.searchParams.get("patchBody");
  if (patchTitle && patchBody) {
    const supabaseUrl = Netlify.env.get("SUPABASE_URL");
    const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
    const toggleSecret = Netlify.env.get("MAINTENANCE_TOGGLE_SECRET");
    if (!supabaseUrl || !supabaseAnonKey || !toggleSecret) {
      resultText += "\nPatch notes NOT posted - SUPABASE_URL / SUPABASE_ANON_KEY / MAINTENANCE_TOGGLE_SECRET aren't all set in this site's environment variables yet.";
    } else {
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/api`, {
          method: "POST",
          headers: { "content-type": "application/json", apikey: supabaseAnonKey, authorization: `Bearer ${supabaseAnonKey}` },
          body: JSON.stringify({
            action: "createPatchNotes",
            payload: { title: patchTitle, body: patchBody, serviceSecret: toggleSecret },
          }),
        });
        const data = await res.json();
        resultText += data && data.success
          ? "\nPatch notes posted."
          : `\nPatch notes NOT posted - Hub said: ${(data && data.error) || "unknown error"}`;
      } catch (err) {
        resultText += `\nPatch notes NOT posted - could not reach the Hub (${err instanceof Error ? err.message : String(err)}).`;
      }
    }
  }

  return new Response(resultText, { status: 200 });
};

export const config: Config = {
  path: "/toggle-maintenance",
};
