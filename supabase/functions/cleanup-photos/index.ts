// Orphaned-photo cleanup for the Food Journal.
//
// Replacing a photo leaves the old object behind in the bucket, and a burst of taps can
// leave several. Tidying those up needs delete rights, which the app's publishable key
// deliberately does not have: that key ships in a public page, so a blanket delete policy
// would let any visitor wipe the family's photos.
//
// Instead the privilege lives here, behind a secret key that never leaves the server, and
// is narrowed by logic rather than by trust: this can only remove objects that no recipe
// row references. A photo in use is structurally unreachable, so the worst a caller can
// do is collect litter.
//
// POST {} or { dryRun: true } — dry run lists what would go without touching anything.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const BUCKET = "recipe-photos";

function projectUrl() {
  const u = Deno.env.get("SUPABASE_URL");
  if (!u) throw new Error("SUPABASE_URL is not set in this function's environment.");
  return u.replace(/\/$/, "");
}

// Edge functions are given a privileged key in their environment. Accept either name so
// this keeps working across the legacy service-role and current secret-key schemes.
function privilegedKey() {
  const k = Deno.env.get("SUPABASE_SECRET_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!k) {
    throw new Error(
      "No privileged key in this function's environment — set SUPABASE_SECRET_KEY in the function's secrets.",
    );
  }
  return k;
}

function adminHeaders(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

export default {
  fetch: withSupabase({ auth: "publishable", cors: "default" }, async (req: Request) => {
    if (req.method !== "POST") {
      return Response.json({ ok: false, error: "POST only." }, { status: 405 });
    }
    try {
      let dryRun = false;
      try {
        const body = await req.json();
        dryRun = body?.dryRun === true;
      } catch {
        // no body is fine — treat as a real run
      }

      const url = projectUrl();
      const key = privilegedKey();
      const h = adminHeaders(key);

      // Everything currently in the bucket.
      const listRes = await fetch(`${url}/storage/v1/object/list/${BUCKET}`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ prefix: "", limit: 1000 }),
      });
      if (!listRes.ok) throw new Error(`Could not list the bucket (${listRes.status}).`);
      const objects: Array<{ name: string }> = await listRes.json();

      // Every image any recipe points at.
      const rowsRes = await fetch(`${url}/rest/v1/recipes?select=data`, { headers: h });
      if (!rowsRes.ok) throw new Error(`Could not read recipes (${rowsRes.status}).`);
      const rows: Array<{ data: { image?: string | null } }> = await rowsRes.json();
      const inUse = new Set<string>();
      for (const row of rows) {
        const img = row?.data?.image;
        if (typeof img === "string" && img) {
          // Compare on the object name, since the row stores a full public URL.
          inUse.add(decodeURIComponent(img.split("/").pop()!.split("?")[0]));
        }
      }

      // If the recipe read came back empty, every object would look unreferenced and the
      // whole bucket would be swept. An empty table is far more likely to be a transient
      // fault than a real state worth acting on, so refuse rather than guess.
      if (!rows.length && objects.length) {
        throw new Error(
          "No recipes came back, so every photo would look orphaned. Refusing to delete anything.",
        );
      }

      // Anything Supabase itself put there is not ours to remove.
      const orphans = objects
        .map((o) => o.name)
        .filter((n) => n && !n.startsWith(".") && !inUse.has(n));

      if (dryRun) {
        return Response.json({
          ok: true,
          dryRun: true,
          total: objects.length,
          inUse: inUse.size,
          orphans,
        });
      }

      let deleted: string[] = [];
      if (orphans.length) {
        const delRes = await fetch(`${url}/storage/v1/object/${BUCKET}`, {
          method: "DELETE",
          headers: h,
          body: JSON.stringify({ prefixes: orphans }),
        });
        if (!delRes.ok) {
          throw new Error(`Delete failed (${delRes.status}): ${await delRes.text()}`);
        }
        deleted = orphans;
      }

      return Response.json({
        ok: true,
        dryRun: false,
        total: objects.length,
        inUse: inUse.size,
        deleted,
      });
    } catch (e) {
      return Response.json({
        ok: false,
        error: e instanceof Error ? e.message : "Cleanup failed.",
      });
    }
  }),
};
