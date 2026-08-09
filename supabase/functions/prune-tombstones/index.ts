// Tombstone pruning for the Food Journal.
//
// A deleted recipe keeps its row with deleted: true, because removing the row outright is
// undone by the next device that still holds the recipe — it sees something the server
// lacks and uploads it again. The tombstone is what tells every device to let go.
//
// So a tombstone can only be removed once every device has certainly seen it. There is no
// way to know that for sure, so this uses age as the proxy: a device that has not opened
// the app in three months is going to be told to reload anyway. The default is
// deliberately conservative, and the floor exists because the failure mode of pruning too
// early is a deleted recipe coming back from the dead on somebody's phone.
//
// POST { dryRun?: boolean, olderThanDays?: number, force?: boolean }
//   dryRun         list what would go, change nothing
//   olderThanDays  default 90; below the 30 day floor requires force
//   force          permits a deliberate immediate purge, e.g. clearing test data when
//                  every device is known to have synced

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const DEFAULT_DAYS = 90;
const FLOOR_DAYS = 30;

function projectUrl() {
  const u = Deno.env.get("SUPABASE_URL");
  if (!u) throw new Error("SUPABASE_URL is not set in this function's environment.");
  return u.replace(/\/$/, "");
}

function privilegedKey() {
  const dict = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (dict) {
    try {
      const parsed = JSON.parse(dict);
      const k = parsed.default ?? Object.values(parsed)[0];
      if (typeof k === "string" && k) return k;
    } catch { /* fall through to the single-key names */ }
  }
  const legacy = Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("No privileged key in this function's environment.");
  return legacy;
}

export default {
  fetch: withSupabase({ auth: "publishable", cors: "default" }, async (req: Request) => {
    if (req.method !== "POST") {
      return Response.json({ ok: false, error: "POST only." }, { status: 405 });
    }
    try {
      let dryRun = false, days = DEFAULT_DAYS, force = false;
      try {
        const body = await req.json();
        dryRun = body?.dryRun === true;
        force = body?.force === true;
        if (typeof body?.olderThanDays === "number" && body.olderThanDays >= 0) {
          days = body.olderThanDays;
        }
      } catch { /* no body: conservative defaults */ }

      if (days < FLOOR_DAYS && !force) {
        throw new Error(
          `Pruning tombstones younger than ${FLOOR_DAYS} days risks a device that has not synced bringing the recipe back. Pass force: true if every device is known to be current.`,
        );
      }

      const url = projectUrl();
      const key = privilegedKey();
      const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

      const res = await fetch(`${url}/rest/v1/recipes?select=id,data,updated_at`, { headers: h });
      if (!res.ok) throw new Error(`Could not read recipes (${res.status}).`);
      const rows: Array<{ id: string; data: { deleted?: boolean; deletedAt?: string }; updated_at: string }> =
        await res.json();

      const cutoff = Date.now() - days * 86400_000;
      const stale = rows.filter((r) => {
        if (!r.data?.deleted) return false;
        // deletedAt is written by the app; updated_at covers tombstones set by hand.
        const when = Date.parse(r.data.deletedAt || r.updated_at || "");
        return Number.isFinite(when) ? when <= cutoff : true;
      }).map((r) => r.id);

      const tombstoneTotal = rows.filter((r) => r.data?.deleted).length;

      if (dryRun) {
        return Response.json({
          ok: true, dryRun: true, olderThanDays: days,
          tombstonesTotal: tombstoneTotal, wouldPrune: stale,
        });
      }

      for (const id of stale) {
        // The per-profile rows go too, or they linger pointing at a recipe that no longer
        // exists — invisible, but they would quietly accumulate forever.
        const delState = await fetch(
          `${url}/rest/v1/profile_recipes?recipe_id=eq.${encodeURIComponent(id)}`,
          { method: "DELETE", headers: h },
        );
        if (!delState.ok) throw new Error(`Could not clear profile rows for ${id} (${delState.status}).`);
        const delRow = await fetch(
          `${url}/rest/v1/recipes?id=eq.${encodeURIComponent(id)}`,
          { method: "DELETE", headers: h },
        );
        if (!delRow.ok) throw new Error(`Could not delete ${id} (${delRow.status}).`);
      }

      return Response.json({
        ok: true, dryRun: false, olderThanDays: days,
        tombstonesTotal: tombstoneTotal, pruned: stale,
      });
    } catch (e) {
      return Response.json({
        ok: false,
        error: e instanceof Error ? e.message : "Prune failed.",
      });
    }
  }),
};
