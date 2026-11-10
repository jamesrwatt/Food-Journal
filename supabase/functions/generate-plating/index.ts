// AI plating-photo generation for the Food Journal.
//
// The plating strip is inspiration, not a record: five ways the dish could be presented,
// shown while a recipe is still on To Make, and sitting beside the photo of what was
// actually cooked once there is one.
//
// This runs server-side for one reason: the Gemini key. The app is a static page served
// from GitHub Pages with its source open to anyone, so a key in the page is a key given
// away. It lives in this function's secrets and never leaves the server.
//
// The function also uploads the result rather than handing the bytes back to be uploaded.
// Recipes arrive two ways -- typed into the app, and pushed by tools/add-recipe.ps1 with
// no browser involved at all -- and only a server-side upload serves both without
// writing the storage step twice.
//
// POST { recipeId, title, tags?, ingredients? } -> { ok, url }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const BUCKET = "recipe-photos";

// Overridable without touching this file, because model names move and a rename should
// not need a code change to fix.
const MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") || "gemini-2.5-flash-image";
const GEMINI_TIMEOUT_MS = 90_000;
const MAX_IMAGE_BYTES = 8_000_000;

function projectUrl() {
  const u = Deno.env.get("SUPABASE_URL");
  if (!u) throw new Error("SUPABASE_URL is not set in this function's environment.");
  return u.replace(/\/$/, "");
}

function privilegedKey() {
  const k = Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!k) {
    throw new Error(
      "No privileged key in this function's environment - set SUPABASE_SECRET_KEY in the function's secrets.",
    );
  }
  return k;
}

function geminiKey() {
  const k = Deno.env.get("GEMINI_API_KEY");
  if (!k) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to this function's secrets in the Supabase dashboard.",
    );
  }
  return k;
}

// The storage key is built from this, so it decides a path. Anything that is not a plain
// slug is refused rather than sanitised, because a silent rewrite would put the photo
// somewhere the recipe will never look for it.
function assertSlug(id: unknown): string {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,120}$/.test(id)) {
    throw new Error("recipeId must be a lowercase slug.");
  }
  return id;
}

// The wording here is the prompt James arrived at over several rounds with Gemini, and
// it is kept rather than improved on. Two details in it are load-bearing: one continuous
// background, so the strip reads as five plates on a counter rather than five pasted
// photographs, and plates centred with even margin, because an off-centre strip cannot
// be rescued afterwards - the app's trim only removes flat filler and deliberately will
// not touch a photographed surface.
function buildPrompt(title: string, tags: string[], ingredients: string[]) {
  const context = ingredients.length
    ? ` The dish is made with ${ingredients.slice(0, 12).join(", ")}.`
    : "";
  const kind = tags.length ? ` It is a ${tags.join(" / ").toLowerCase()}.` : "";
  return [
    "Generate a 2k output ultra-wide 21:9 horizontal strip showing five unique fine dining",
    `plating presentations of "${title.trim()}", arranged in one single row, evenly spaced,`,
    `all at identical scale and shot from the same three-quarter overhead angle.${kind}${context}`,
    "Clean neutral surfaces - pale linen, slate, matte ceramic. Restaurant food photography,",
    "soft diffused daylight from the left, shallow depth of field. No text, no labels, no",
    "borders or dividing lines between the plates. Make it one background like it is 5 plates",
    "side by side on a marble countertop. Keep the plates vertically centered with even",
    "margin above and below.",
  ].join(" ");
}

type InlinePart = { inlineData?: { mimeType?: string; data?: string } };

async function generateImage(prompt: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), GEMINI_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey() },
        signal: ctl.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: "21:9" },
          },
        }),
      },
    );
  } catch (e) {
    throw new Error(
      (e as Error)?.name === "AbortError"
        ? "Gemini took too long to answer."
        : `Could not reach Gemini: ${(e as Error)?.message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    // Google's own message is the useful half of diagnosing this - a wrong model name, a
    // key without image access, billing not enabled - so pass it through rather than
    // flattening every failure into "generation failed".
    let detail = text.slice(0, 400);
    try {
      detail = JSON.parse(text)?.error?.message || detail;
    } catch {
      // keep the raw text
    }
    throw new Error(`Gemini refused (${res.status}): ${detail}`);
  }

  let body: { candidates?: Array<{ content?: { parts?: InlinePart[] } }> };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned something that was not JSON.");
  }
  const parts = body?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p?.inlineData?.data);
  if (!img?.inlineData?.data) {
    throw new Error("Gemini returned no image. The model may not support image output.");
  }
  const bin = atob(img.inlineData.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `Generated image is ${Math.round(bytes.length / 1e6)} MB, which is too large to store.`,
    );
  }
  return { bytes, mime: img.inlineData.mimeType || "image/png" };
}

export default {
  fetch: withSupabase({ auth: "publishable", cors: "default" }, async (req: Request) => {
    if (req.method !== "POST") {
      return Response.json({ ok: false, error: "POST only." }, { status: 405 });
    }
    try {
      const body = await req.json().catch(() => ({}));
      const recipeId = assertSlug(body?.recipeId);
      const title = typeof body?.title === "string" && body.title.trim()
        ? body.title.trim()
        : recipeId.replace(/-/g, " ");
      const tags = Array.isArray(body?.tags)
        ? body.tags.filter((t: unknown): t is string => typeof t === "string")
        : [];
      const ingredients = Array.isArray(body?.ingredients)
        ? body.ingredients
          .filter((t: unknown): t is string => typeof t === "string")
          // Section headers are formatting, not food.
          .filter((t: string) => !/^\s*[-—].*[-—]\s*$/.test(t))
        : [];

      const { bytes, mime } = await generateImage(buildPrompt(title, tags, ingredients));

      const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
      const path = `${recipeId}-plating-${Date.now()}.${ext}`;
      const key = privilegedKey();
      const up = await fetch(`${projectUrl()}/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": mime },
        body: bytes,
      });
      if (!up.ok) {
        throw new Error(
          `Could not store the image (${up.status}): ${(await up.text()).slice(0, 300)}`,
        );
      }

      return Response.json({
        ok: true,
        url: `${projectUrl()}/storage/v1/object/public/${BUCKET}/${path}`,
        model: MODEL,
        bytes: bytes.length,
      });
    } catch (e) {
      return Response.json({
        ok: false,
        error: e instanceof Error ? e.message : "Generation failed.",
      });
    }
  }),
};
