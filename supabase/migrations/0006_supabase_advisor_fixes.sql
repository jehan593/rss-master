-- Addresses Supabase Advisor warnings:
--   * Function Search Path Mutable (feeds_set_next_position)
--   * Extension in Public (pg_net)
--   * Public/Signed-In Users Can Execute SECURITY DEFINER Function
--     (cap_articles_per_feed, cleanup_old_articles)
-- "Leaked Password Protection Disabled" is an Auth setting, not a SQL
-- object — enable it in Dashboard → Authentication → Policies → Password.

-- 1) Pin search_path so the trigger function can't be hijacked by a caller
--    manipulating search_path before the insert.
create or replace function feeds_set_next_position()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.position is null then
    select coalesce(max(position) + 1, 0) into new.position from feeds where user_id = new.user_id;
  end if;
  return new;
end;
$$;

-- 2) pg_net was installed but is never used (fetch-feeds runs as an edge
--    function triggered from the client, not via pg_net HTTP calls) —
--    drop it rather than relocate it out of public.
drop extension if exists pg_net;

-- 3) These are maintenance functions invoked only by the pg_cron job in
--    0001_init.sql (which runs as the scheduling role) — they have no
--    business being callable by anon/authenticated clients. Revoking from
--    PUBLIC alone isn't enough: Supabase grants EXECUTE on new public-schema
--    functions to anon/authenticated directly, so both need explicit revokes.
revoke execute on function cleanup_old_articles() from public, anon, authenticated;
revoke execute on function cap_articles_per_feed(int) from public, anon, authenticated;
