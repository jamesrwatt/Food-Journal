-- Clears the duplicated per-person state out of the shared recipe rows.
--
-- The profiles migration deliberately left shelf, rating and nextPhotoPromptAt inside
-- recipes.data so devices on the pre-profiles build kept working. Every device has now
-- reloaded, and the client stopped writing them as of the previous deploy, so the copies
-- left in the table are stale duplicates of what profile_recipes holds.
--
-- Only touches these three keys. Everything else in data - title, ingredients,
-- instructions, notes, image, source - is untouched, and tombstoned rows keep their
-- deleted flag.

update public.recipes
set data = data - 'shelf' - 'rating' - 'nextPhotoPromptAt'
where data ?| array['shelf', 'rating', 'nextPhotoPromptAt'];
