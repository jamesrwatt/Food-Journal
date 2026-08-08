// Recipe importer for the Food Journal.
//
// A browser cannot fetch a recipe site directly (those pages send no CORS headers), and
// GitHub Pages is static with nowhere to proxy. This edge function is that missing
// server-side hop: give it a URL and it returns structured recipe fields, or fetches a
// single image off the page so the app can store its own copy in the bucket instead of
// hotlinking someone else's server.
//
// withSupabase handles auth and CORS. auth: "publishable" accepts exactly the key the
// app already ships in its page, so no JWT juggling is needed and the endpoint is not
// open to the whole internet. Nothing privileged happens here regardless — it reads
// public pages and returns text — and the URL guards below are the real protection.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

// Sites reject unknown agents: altonbrown.com refuses outright without this.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MAX_HTML_BYTES = 5_000_000;
const MAX_IMAGE_BYTES = 10_000_000;
const FETCH_TIMEOUT_MS = 15_000;

// This endpoint fetches whatever URL it is handed, so it must not become a probe for
// private networks or non-web schemes.
function assertSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("That does not look like a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http and https addresses can be imported.");
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith("[");
  if (blocked) throw new Error("That address is not reachable from here.");
  return u;
}

async function fetchCapped(url: string, accept: string, cap: number) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`The site returned ${res.status}.`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > cap) throw new Error("That page or image is too large to import.");
    return { buf, contentType: res.headers.get("content-type") || "" };
  } finally {
    clearTimeout(timer);
  }
}

// ISO 8601 durations ("PT2H30M") are what schema.org uses; nobody wants that on a card.
function humanDuration(iso: unknown): string {
  if (typeof iso !== "string") return "";
  const m = iso.match(/^P(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?)?/);
  if (!m) return "";
  let [d, h, min] = [m[1], m[2], m[3]].map((x) => (x ? parseFloat(x) : 0));
  // Sites often express long times as raw minutes — altonbrown.com gives an overnight
  // ice cream as PT540M, which should read "9 hr", not "540 min".
  h += Math.floor(min / 60);
  min = Math.round(min % 60);
  d += Math.floor(h / 24);
  h = h % 24;
  const parts: string[] = [];
  if (d) parts.push(`${d} day${d > 1 ? "s" : ""}`);
  if (h) parts.push(`${h} hr`);
  if (min) parts.push(`${min} min`);
  return parts.join(" ");
}

function stripTags(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// recipeInstructions arrives in three shapes across sites: plain strings, HowToStep
// objects, or HowToSection objects wrapping a nested list.
function flattenInstructions(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n === "string") {
      const t = stripTags(n);
      if (t) out.push(t);
      return;
    }
    const o = n as Record<string, unknown>;
    const type = String(o["@type"] ?? "");
    if (type.includes("HowToSection")) {
      const name = stripTags(o.name);
      if (name) out.push(`— ${name.toUpperCase()} —`);
      return walk(o.itemListElement);
    }
    const t = stripTags(o.text ?? o.name);
    if (t) out.push(t);
  };
  walk(node);
  return out;
}

function collectImages(node: unknown, pageUrl: string): string[] {
  const urls: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string") urls.push(v);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.url === "string") urls.push(o.url);
      else if (typeof o.contentUrl === "string") urls.push(o.contentUrl);
    }
  };
  if (Array.isArray(node)) node.forEach(push);
  else push(node);
  const seen = new Set<string>();
  return urls
    .map((u) => {
      try {
        return new URL(u, pageUrl).toString();
      } catch {
        return "";
      }
    })
    .filter((u) => u && !seen.has(u) && seen.add(u))
    .slice(0, 8);
}

// JSON-LD hides the Recipe in a few different places: bare object, top-level array, or
// inside an @graph. Check all of them.
function findRecipeNode(parsed: unknown): Record<string, unknown> | null {
  const queue: unknown[] = [parsed];
  while (queue.length) {
    const n = queue.shift();
    if (!n) continue;
    if (Array.isArray(n)) {
      queue.push(...n);
      continue;
    }
    if (typeof n !== "object") continue;
    const o = n as Record<string, unknown>;
    const type = o["@type"];
    const types = Array.isArray(type) ? type.map(String) : [String(type ?? "")];
    if (types.some((t) => t === "Recipe" || t.endsWith("/Recipe"))) return o;
    if (o["@graph"]) queue.push(o["@graph"]);
  }
  return null;
}

function parseRecipe(html: string, pageUrl: string) {
  const blocks = [...html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )];
  for (const b of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(b[1].trim());
    } catch {
      continue;
    }
    const node = findRecipeNode(parsed);
    if (!node) continue;

    const ingredients = (Array.isArray(node.recipeIngredient) ? node.recipeIngredient : [])
      .map(stripTags)
      .filter(Boolean);
    const instructions = flattenInstructions(node.recipeInstructions);
    if (!ingredients.length && !instructions.length) continue;

    const yieldRaw = node.recipeYield;
    const servings = Array.isArray(yieldRaw) ? stripTags(yieldRaw[0]) : stripTags(yieldRaw);
    const prep = humanDuration(node.prepTime);
    const total = humanDuration(node.totalTime);

    return {
      ok: true,
      title: stripTags(node.name),
      ingredients,
      instructions,
      prepTime: prep && total && prep !== total ? `${prep} active / ${total} total` : prep || total,
      bakeTime: humanDuration(node.cookTime),
      servings,
      images: collectImages(node.image, pageUrl),
      source: pageUrl,
    };
  }
  return null;
}

export default {
  fetch: withSupabase({ auth: "publishable", cors: "default" }, async (req: Request) => {
    if (req.method !== "POST") {
      return Response.json({ ok: false, error: "POST only." }, { status: 405 });
    }
    try {
      const { url, mode } = await req.json();
      if (typeof url !== "string" || !url.trim()) throw new Error("No URL provided.");
      const safe = assertSafeUrl(url.trim());

      // Image mode: pull one picture off the page so the app keeps its own copy in the
      // bucket rather than depending on the source site staying up.
      if (mode === "image") {
        const { buf, contentType } = await fetchCapped(safe.toString(), "image/*", MAX_IMAGE_BYTES);
        if (!contentType.startsWith("image/")) throw new Error("That link is not an image.");
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) {
          bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        }
        return Response.json({ ok: true, dataUrl: `data:${contentType};base64,${btoa(bin)}` });
      }

      const { buf } = await fetchCapped(safe.toString(), "text/html", MAX_HTML_BYTES);
      const html = new TextDecoder("utf-8").decode(buf);
      const recipe = parseRecipe(html, safe.toString());
      if (!recipe) {
        return Response.json({
          ok: false,
          error:
            "Couldn't find a recipe on that page. It may not publish structured recipe data — you can still type it in by hand.",
        });
      }
      return Response.json(recipe);
    } catch (e) {
      return Response.json({
        ok: false,
        error: e instanceof Error ? e.message : "Import failed.",
      });
    }
  }),
};
