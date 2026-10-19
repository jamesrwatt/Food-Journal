-- When a recipe last landed on the shelf it is sitting on.
--
-- The board drew each shelf in whatever order the recipes happened to occupy the array,
-- which is sync order, not an order anyone chose. Sorting by this puts the oldest at the
-- top and whatever just arrived at the bottom, so a shelf reads as a queue.
--
-- Made already records lastMade, and for a recipe on that shelf the two stamps are the
-- same event: moving something to Made sets both. The reason this column exists as well
-- is the other two shelves, where nothing has been made yet and there was no timestamp
-- of any kind to sort by.
--
-- Per profile, beside shelf and rating, for the same reason those are: moving a recipe
-- is something a person did on their own board and says nothing about anyone else's.
--
-- Left null for every row that already exists. There is no honest value to backfill --
-- the app never recorded it -- and the client falls back to lastMade and then to the
-- recipe's own dateAdded, which is a real date and orders the existing shelves
-- sensibly. A row fills in the first time the recipe is moved.

alter table public.profile_recipes
  add column if not exists shelf_changed_at timestamptz;
