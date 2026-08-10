-- Takes SQL DELETE away from the key that ships in the public page.
--
-- The app never deletes rows. Removing a recipe sets deleted: true and removing it from
-- one person's journal sets hidden: true, both of which are updates — tombstones exist
-- precisely because a real delete cannot propagate. The only genuine deletes happen in
-- the cleanup-photos and prune-tombstones functions, which authenticate with the secret
-- key server-side and are not subject to these policies at all.
--
-- So the delete grant bought nothing and allowed anyone who viewed source to empty the
-- journal. Read and write stay open: this is a family recipe box with no login, and
-- someone editing a recipe is recoverable. Someone deleting every row and every photo
-- reference is the case worth closing, because the photos behind them cannot be retaken.

drop policy if exists recipes_delete on public.recipes;

-- profiles_write and profile_recipes_write were FOR ALL, which includes DELETE. Replace
-- each with the three verbs the app actually uses.
drop policy if exists profiles_write on public.profiles;
create policy profiles_insert on public.profiles for insert with check (true);
create policy profiles_update on public.profiles for update using (true) with check (true);

drop policy if exists profile_recipes_write on public.profile_recipes;
create policy profile_recipes_insert on public.profile_recipes for insert with check (true);
create policy profile_recipes_update on public.profile_recipes for update using (true) with check (true);
