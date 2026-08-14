# Food Journal

### 👉 **[Open the app: jamesrwatt.github.io/Food-Journal](https://jamesrwatt.github.io/Food-Journal/)**

A family recipe journal. Recipes move across **To Make → Making → Made** shelves, each person keeps their own shelves and ratings, and the recipes and photos are shared between everyone.

Works on any phone, tablet or desktop browser. No install, no login.

---

## What it does

**Shelves and ratings, per person.** Pick who you are when you open it. Your shelf positions and your ratings are yours; someone else rating the same dish 6/10 does not touch your 9/10. The recipe text and its photo are shared, because those are facts about the dish rather than opinions of it.

**Send a recipe to someone.** It lands on their To Make shelf with no rating carried over — a suggestion, not a verdict.

**Add recipes three ways.**
- Paste a link. The importer reads the recipe from the page, filling in title, times, servings, ingredients and steps, and offers any photos it found on that page. Sites without structured recipe data get a best-guess read of the article text, flagged as such.
- Type it in by hand.
- Send a photo of a cookbook page, or a link to a site that blocks importers, to Claude in chat. Those go straight into the database via `tools/add-recipe.ps1` and appear on every device within about thirty seconds — no deploy, and `index.html` never changes.

**Photos.** Take one with the camera, choose an existing one, paste one (Ctrl+V, right-click, or long-press → Paste), or use one from the recipe's own page. Photos are downscaled before upload and stored once, shared by everyone.

**Editing.** Any recipe can be edited after logging, including a Notes field for what you served it with or what you would change next time.

**Deleting.** The admin profile deletes a recipe for everyone, permanently. Everyone else gets Remove, which hides it from their own journal and leaves everyone else's alone.

**Offline.** The app keeps working with no signal and syncs when the connection returns. A photo taken offline uploads on reconnect.

---

## How it is built

A single self-contained `index.html` — no build step, no framework, no dependencies — served by GitHub Pages straight from `main`. Pushing to `main` publishes it.

State lives in [Supabase](https://supabase.com):

| Table | Holds |
|---|---|
| `recipes` | recipe content and photo URL, shared by everyone |
| `profiles` | who exists, and who is admin |
| `profile_recipes` | shelf, rating and visibility, per person per recipe |

Photos go in a public `recipe-photos` storage bucket. `localStorage` is an offline cache, not the source of truth, and `index.html` ships no recipes at all — a fresh device gets everything from the database on its first sync.

Three edge functions in `supabase/functions/`:

- **`import-recipe`** — fetches a recipe page and parses it. A browser cannot do this itself (recipe sites send no CORS headers) and a static host has nowhere to proxy, which is why this exists.
- **`cleanup-photos`** — deletes photos no live recipe references. Runs automatically after a delete.
- **`prune-tombstones`** — removes old deletion markers. Defaults to 90 days, because pruning early lets a device that has not synced bring the recipe back.

Deploy a function with:

```
supabase functions deploy <name> --project-ref uhicczuwqolnowonqwfq
```

Database changes go in `supabase/migrations/` and apply with `supabase db push`.

---

## Backups

`tools/backup-journal.ps1` writes every recipe row, a plain-text copy of the recipes, and every photo to a timestamped folder **outside** this repo. It runs weekly via a scheduled task, and is worth running by hand before any schema change.

Recipes can be re-imported from their sources; photos of meals you actually cooked cannot be retaken. That asymmetry is the whole reason the backups exist.

---

## A note on privacy

This site is **public**. Anyone with the URL can read the recipes and photos, and can add or change them — the database key is in the page, as it has to be for a site with no login, and it is restricted to this data only.

That is a deliberate trade for a family recipe box with no passwords to remember. It would be the wrong trade for anything you would mind a stranger seeing or editing. Adding real accounts is possible later if that ever changes.
