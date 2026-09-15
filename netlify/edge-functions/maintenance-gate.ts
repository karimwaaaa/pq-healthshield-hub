// ============================================================
// Runs on EVERY request to the Hub, before the static index.html is
// served. This is what gives you a proper "no flash, real 503" outage
// screen instead of the SPA loading first and then swapping to a
// maintenance message.
//
// Deliberately does NOT call Supabase to decide whether maintenance mode
// is on. If the reason you're flipping this on is "Supabase is having
// problems," you don't want the switch that turns OFF traffic to
// Supabase to itself depend on Supabase being reachable. The on/off
// state lives in Netlify Blobs instead — a separate, Netlify-native
// key-value store with no dependency on your own backend at all.
//
// IMPORTANT: this Edge Function does NOT import "@netlify/blobs" itself.
// Edge Functions run on Deno, and in a plain drag-and-drop deploy (no
// package.json, no npm install step) Netlify's edge bundler cannot
// resolve that package at all — confirmed by testing both the bare
// specifier and the "npm:" prefix, both failed the same way. Instead,
// this calls the tiny maintenance-status Function below, which is a
// regular (Node) Function — the runtime that DOES bundle @netlify/blobs
// cleanly. All Blobs access lives there; this file just does a fetch.
// ============================================================
import type { Context } from "https://edge.netlify.com";

const MAINTENANCE_PAGE = (message: string) => `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>[COMPANY_NAME] Hub — Maintenance</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f4f7fb; color: #1e2a3a; font-family: 'Segoe UI', Arial, sans-serif; padding: 24px;
  }
  .card {
    max-width: 440px; background: #fff; border-radius: 12px; padding: 32px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.08); text-align: center;
  }
  h1 { color: #16296b; font-size: 1.3em; margin: 0 0 12px; }
  p { color: #4a5a70; line-height: 1.5; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>🛠️ Under Maintenance</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);

  // Never gate the toggle endpoint or the internal status check itself,
  // or you can lock yourself out of turning maintenance mode back off
  // (and/or cause this function to call itself in a loop).
  if (url.pathname === "/toggle-maintenance" || url.pathname === "/maintenance-status") {
    return context.next();
  }

  let enabled = false;
  let message = "The Hub is temporarily offline for maintenance. Please check back shortly.";

  try {
    // Internal same-site call — this is a real request that goes back
    // through Netlify, so it's exempted above to avoid re-entering this
    // same gate. ?strict=1 asks maintenance-status for a strongly
    // consistent read - this IS the request deciding whether to actually
    // serve or block the page, so it can't afford to read a stale value.
    // (The Hub frontend's own background warning-poll hits the same
    // endpoint WITHOUT ?strict=1, since a few seconds of staleness there
    // doesn't matter and the plain read is cheaper.)
    const statusRes = await fetch(new URL("/maintenance-status?strict=1", url.origin).toString());
    if (statusRes.ok) {
      const data = await statusRes.json();
      enabled = !!data.enabled;
      if (data.message) message = data.message;
    }
  } catch {
    // If the status check itself can't be reached, fail OPEN (serve the
    // site normally) rather than accidentally locking everyone out
    // because of a transient internal-fetch hiccup. Worst case: a brief
    // outage doesn't show the maintenance screen for a moment.
    return context.next();
  }

  if (!enabled) return context.next();

  // Bypass: a shared secret set once as a Netlify env var (Site
  // settings -> Environment variables -> MAINTENANCE_BYPASS_TOKEN), not
  // something that needs to change often, so it's fine that changing it
  // requires a redeploy. Visit the Hub once with ?bypass=<token> and
  // this sets a cookie so you don't have to keep the query param on
  // every link while you're testing during the outage.
  const bypassToken = Netlify.env.get("MAINTENANCE_BYPASS_TOKEN");
  const queryBypass = url.searchParams.get("bypass");
  const cookieBypass = context.cookies.get("hub_maintenance_bypass");

  if (bypassToken && (queryBypass === bypassToken || cookieBypass === bypassToken)) {
    if (queryBypass === bypassToken) {
      context.cookies.set({
        name: "hub_maintenance_bypass",
        value: bypassToken,
        path: "/",
        maxAge: 60 * 60 * 12, // 12 hours - long enough for one work session
        secure: true,
        httpOnly: true,
      });
    }
    return context.next();
  }

  return new Response(MAINTENANCE_PAGE(message), {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "retry-after": "1800", // hints 30 min to any monitor/crawler checking in
      "cache-control": "no-store",
    },
  });
};
