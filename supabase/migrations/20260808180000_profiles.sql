-- Profiles for the Food Journal.
--
-- Until now the journal was a single shared copy: one shelf position and one rating per
-- recipe, and whoever moved it last won. This splits what is an opinion from what is a
-- fact about the dish.
--
--   recipes          recipe content and its photo. Shared by everyone. A photo of a
--                    finished dish is a fact, so there is one, last write wins.
--   profile_recipes  shelf, rating and visibility, per person. Your 9/10 and your kid's
--                    6/10 for the same dish coexist instead of overwriting each other.
--
-- Deliberately NOT stripping shelf/rating out of recipes.data in this migration. Devices
-- running the previous build keep reading those fields, and they would break the moment
-- the columns vanished. They become dead weight once every device has updated, and a
-- later migration can drop them.

create table if not exists public.profiles (
  id         text primary key,
  name       text not null,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.profile_recipes (
  profile_id           text not null references public.profiles(id) on delete cascade,
  recipe_id            text not null,
  shelf                text not null default 'To Make',
  rating               integer,
  -- Hiding is how a non-admin removes a recipe from their own board. It never affects
  -- anyone else; only an admin delete removes the recipe itself.
  hidden               boolean not null default false,
  next_photo_prompt_at bigint,
  updated_at           timestamptz not null default now(),
  primary key (profile_id, recipe_id)
);

create index if not exists profile_recipes_profile_idx on public.profile_recipes (profile_id);

alter table public.profiles enable row level security;
alter table public.profile_recipes enable row level security;

-- Same posture as the recipes table: the publishable key may read and write, and the
-- family is trusted. Admin-only deletion is enforced in the app, not here.
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_write  on public.profiles;
create policy profiles_read  on public.profiles for select using (true);
create policy profiles_write on public.profiles for all    using (true) with check (true);

drop policy if exists profile_recipes_read  on public.profile_recipes;
drop policy if exists profile_recipes_write on public.profile_recipes;
create policy profile_recipes_read  on public.profile_recipes for select using (true);
create policy profile_recipes_write on public.profile_recipes for all    using (true) with check (true);

-- James is the admin. Everything currently in the journal is his, so his profile
-- inherits the existing shelves and ratings exactly as they stand.
insert into public.profiles (id, name, is_admin)
values ('dad', 'Dad', true)
on conflict (id) do update set is_admin = true;

insert into public.profile_recipes (profile_id, recipe_id, shelf, rating, next_photo_prompt_at)
select
  'dad',
  r.id,
  coalesce(nullif(r.data->>'shelf', ''), 'To Make'),
  case when jsonb_typeof(r.data->'rating') = 'number'
       then (r.data->>'rating')::int end,
  case when jsonb_typeof(r.data->'nextPhotoPromptAt') = 'number'
       then (r.data->>'nextPhotoPromptAt')::bigint end
from public.recipes r
where coalesce((r.data->>'deleted')::boolean, false) = false
on conflict (profile_id, recipe_id) do nothing;
