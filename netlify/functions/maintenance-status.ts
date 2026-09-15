// ============================================================
// Tiny read-only endpoint TWO different callers hit:
//   1) maintenance-gate.ts, on every real page request, deciding whether
//      to serve the site or the 503 screen - this MUST be correct the
//      instant you flip the toggle, so it asks for strong consistency
//      (passes ?strict=1).
//   2) The Hub frontend's own background poll (every 60s, only while the
//      tab is visible) that shows the in-app "maintenance is starting,
//      save your work" warning - a few seconds of staleness there is
//      completely fine, so it uses the plain (eventually consistent,
//      cheaper/faster) read by default.
// Kept as a separate regular Function (not inlined into the Edge
// Function) because this is a plain drag-and-drop deploy with no
// package.json/npm install step, and Netlify's Edge Function bundler
// cannot resolve the "@netlify/blobs" package in that setup — regular
// Functions bundle it fine, so all Blobs access is kept here.
// ============================================================
import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";

export default async (request: Request) => {
  const url = new URL(request.url);
  const strict = url.searchParams.get("strict") === "1";
  const consistency = strict ? "strong" : undefined;

  const store = getStore("hub-maintenance");
  const enabledRaw = await store.get("enabled", consistency ? { consistency } : undefined);
  const message = (await store.get("message", consistency ? { consistency } : undefined)) ||
    "The Hub is temporarily offline for maintenance. Please check back shortly.";

  return new Response(
    JSON.stringify({ enabled: enabledRaw === "true", message }),
    {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }
  );
};

export const config: Config = {
  path: "/maintenance-status",
};

