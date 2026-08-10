-- Removes the scratch rows left by the security audit.
--
-- These were created deliberately to test what the public key can do, and are cleaned up
-- here rather than through the API because the audit's own conclusion was to take DELETE
-- away from that key. Needing a migration to tidy them is the fix working.

delete from public.profile_recipes where recipe_id like '\_audit%' or profile_id like '\_audit%';
delete from public.recipes  where id like '\_audit%';
delete from public.profiles where id like '\_audit%';
