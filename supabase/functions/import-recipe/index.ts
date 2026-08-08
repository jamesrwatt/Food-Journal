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

// ---- Prose fallback -------------------------------------------------------------
// Plenty of good cooking sites publish no structured data at all — thefrenchcookingacademy
// writes the method as an article. For those, reconstruct the recipe from the page text.
// This is a best guess by nature, so the result is flagged and the app tells you to check
// it rather than pretending it is as reliable as JSON-LD.

// Like stripTags, but keeps block boundaries as newlines so list and paragraph structure
// survives — that structure is most of the signal for telling ingredients from prose.
function htmlToLines(html: string): string[] {
  const withBreaks = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n");
  return stripTags(withBreaks.replace(/\n/g, ""))
    .split("")
    .map((l) => l.trim())
    .filter(Boolean);
}

const UNIT = /\b(g|kg|ml|l|tbsp|tbs|tsp|teaspoons?|tablespoons?|cups?|oz|lb|lbs|pounds?|ounces?|grams?|cloves?|pinch|handful|sprigs?|slices?|sticks?|cans?|packets?)\b/i;
const QTY_START = /^(\d|[¼½¾⅓⅔⅛]|a\s|an\s|one\s|two\s|three\s|four\s|half\s|juice\s|zest\s|salt|pepper|enough\s)/i;

function looksLikeIngredient(line: string): boolean {
  if (line.length > 160) return false;
  if (/[.!?]\s+\S/.test(line)) return false; // more than one sentence reads like prose
  return QTY_START.test(line) || UNIT.test(line);
}

// "For the sauce" style headings become the same section markers used elsewhere.
function sectionHeading(line: string): string | null {
  if (line.length > 60) return null;
  const m = line.match(/^(?:for\s+the\s+|for\s+)(.+?)[:：]?$/i);
  if (!m || /\d/.test(line)) return null;
  return `— ${m[0].replace(/[:：]$/, "").toUpperCase()} —`;
}

function timeAfter(text: string, label: RegExp): string {
  const m = text.match(label);
  if (!m || m.index === undefined) return "";
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
  const d = tail.match(
    /^\s*(\d+\s*(?:h(?:ours?|rs?)?|min(?:utes?|s)?)(?:\s*\d+\s*min(?:utes?|s)?)?)/i,
  );
  return d ? d[1].trim() : "";
}

function findHeading(lines: string[], re: RegExp, from = 0): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].length <= 40 && re.test(lines[i])) return i;
  }
  return -1;
}

function metaContent(html: string, prop: string): string {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`,
    "i",
  );
  const m = html.match(re) || html.match(
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, "i"),
  );
  return m ? stripTags(m[1]) : "";
}

function parseProse(html: string, pageUrl: string) {
  const lines = htmlToLines(html);
  if (lines.length < 10) return null;

  const ingStart = findHeading(lines, /^ingredients?\b/i);
  const methodStart = findHeading(
    lines,
    /^(method|instructions?|directions?|preparation|steps|to\s+make)\b/i,
    ingStart >= 0 ? ingStart + 1 : 0,
  );
  if (ingStart < 0 || methodStart < 0 || methodStart <= ingStart) return null;

  const ingredients: string[] = [];
  for (const line of lines.slice(ingStart + 1, methodStart)) {
    const heading = sectionHeading(line);
    if (heading) { ingredients.push(heading); continue; }
    if (looksLikeIngredient(line)) ingredients.push(line);
  }

  // Steps run until the page stops looking like instructions — a short heading that is
  // not a step marker is usually the start of comments, related posts or a newsletter box.
  const instructions: string[] = [];
  for (const line of lines.slice(methodStart + 1)) {
    if (/^(related|you\s+may\s+also|comments?|leave\s+a\s+(reply|comment)|share\s+this|subscribe|print\s+recipe|nutrition|about\s+the\s+author)\b/i.test(line)) break;
    if (line.length < 25) {
      const heading = sectionHeading(line);
      if (heading) instructions.push(heading);
      continue;
    }
    // The tag cloud and category links that trail an article are long enough to pass the
    // length test but carry no sentence punctuation. Real steps are sentences.
    if (instructions.length >= 2 && !/[.!?]/.test(line)) break;
    instructions.push(line.replace(/^(?:step\s*)?\d+[).:]?\s*/i, ""));
  }

  if (ingredients.length < 2 || instructions.length < 2) return null;

  const text = lines.join(" ");
  const serves = text.match(/\b(?:serves|servings?|yield)\b[:\s]*([\d]+(?:\s*[-–]\s*\d+)?)/i);
  // Match a duration immediately after the label rather than "everything up to a full
  // stop": these labels usually sit in a pipe-separated strip with no punctuation, so a
  // loose match swallows whatever text follows it.
  const prep = timeAfter(text, /\bprep(?:aration)?\s*time\b[:\s]*/i);
  const cook = timeAfter(text, /\b(?:cook|cooking|baking|bake)\s*time\b[:\s]*/i);
  const oven = text.match(/\b(\d{3})\s*°?\s*(?:°|deg|degrees)?\s*(?:F|C)\b/i);

  const title = metaContent(html, "og:title") ||
    stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "") ||
    stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");

  const images: string[] = [];
  const og = metaContent(html, "og:image");
  if (og) images.push(og);
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    if (images.length >= 8) break;
    const src = m[1];
    if (/\.(svg|gif)(\?|$)/i.test(src)) continue;
    if (/logo|icon|avatar|sprite|badge|pixel/i.test(src)) continue;
    images.push(src);
  }

  return {
    ok: true,
    parsedFrom: "prose",
    title: title.replace(/\s*[|—–-]\s*[^|—–-]*$/, "").trim() || title,
    ingredients,
    instructions,
    prepTime: prep ? prep[1].trim() : "",
    bakeTime: cook ? cook[1].trim() : "",
    servings: serves ? serves[1].trim() : "",
    oven: oven ? oven[0].trim() : "",
    images: collectImages(images, pageUrl),
    source: pageUrl,
  };
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
