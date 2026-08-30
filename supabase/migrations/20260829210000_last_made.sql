-- When a recipe reaches the Made shelf, record the day it got there.
--
-- The board could already say a recipe had been made, but not when, so "we had this in
-- the spring" was a memory exercise. The date belongs next to shelf and rating in
-- profile_recipes rather than on the shared recipe: making a dish is something a person
-- did, and Dad cooking it in August says nothing about whether Lucy ever has.
--
-- A plain date, not a timestamptz. What is wanted is the day it was cooked, and a
-- timestamp would invite a timezone question that has no interesting answer here.
--
-- Recipes already sitting on Made stay null. There is no honest value to backfill --
-- the app never recorded when they were moved -- and guessing a date would be worse
-- than the card simply not claiming one. They fill in the next time they are cooked.

alter table public.profile_recipes
  add column if not exists last_made date;
