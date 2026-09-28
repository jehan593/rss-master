-- RSS Master — full schema
--
-- Run this whole file once in the Supabase SQL editor (Project → SQL Editor
-- → New query) on a fresh project. It creates everything the app needs:
-- tables, RLS policies, and the storage-bounding maintenance jobs. Mirrors
-- habit-tracker's pattern: per-user rows via auth.uid(), RLS-secured, anon
-- key safe to ship client-side.

create extension if not exists pg_cron;
create extension if not exists pgcrypto; -- gen_random_uuid()

-- ─── FEEDS ────────────────────────────────────────────────────────────────
create table if not exists feeds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,
  title text,
  site_url text,
  display_name text, -- user-chosen name; when set, always wins over `title` client-side
  position integer not null,
  last_fetched_at timestamptz,
  presence_checked_at timestamptz,
  etag text,
  last_modified text,
  error_count int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, url)
);

create index if not exists feeds_active_idx on feeds (active) where active;
create index if not exists feeds_position_idx on feeds (user_id, position);

alter table feeds enable row level security;

create policy "feeds_select_own" on feeds
  for select using (auth.uid() = user_id);
create policy "feeds_insert_own" on feeds
  for insert with check (auth.uid() = user_id);
create policy "feeds_update_own" on feeds
  for update using (auth.uid() = user_id);
create policy "feeds_delete_own" on feeds
  for delete using (auth.uid() = user_id);

-- New feeds get the next position for their user automatically, so the
-- client never needs to compute it itself (avoids races between concurrent
-- inserts). search_path is pinned so this SECURITY-context trigger can't be
-- hijacked by a caller manipulating search_path before the insert.
create or replace function feeds_set_next_position()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.position is null then
    select coalesce(max(position) + 1, 0) into new.position from feeds where user_id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists feeds_set_next_position_trigger on feeds;
create trigger feeds_set_next_position_trigger
before insert on feeds
for each row execute function feeds_set_next_position();

-- ─── ARTICLES ─────────────────────────────────────────────────────────────
-- Only title/link/short summary/published_at are stored — never full article
-- HTML/content — to keep per-row size (and therefore total DB size) small
-- and bounded. Readers click through to the source to read the full piece.
create table if not exists articles (
  id uuid primary key default gen_random_uuid(),
  feed_id uuid not null references feeds(id) on delete cascade,
  guid text not null,
  link text not null,
  title text not null,
  summary text,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (feed_id, guid)
);

create index if not exists articles_feed_published_idx on articles (feed_id, published_at desc);
create index if not exists articles_published_idx on articles (published_at desc);

alter table articles enable row level security;

-- Readable by the owning user only (joins through feeds.user_id) — written
-- exclusively by the fetch-feeds edge function using the service_role key,
-- which bypasses RLS, so no insert/update policy is needed for normal users.
create policy "articles_select_via_own_feed" on articles
  for select using (
    exists (select 1 from feeds f where f.id = articles.feed_id and f.user_id = auth.uid())
  );

-- ─── ARTICLE READS ────────────────────────────────────────────────────────
-- Cross-device read/unread state, mirroring habit-tracker's sync model.
--
-- Keyed on the article's stable (feed_id, guid) identity, NOT articles.id.
-- The storage-bounding maintenance below legitimately deletes article rows
-- (retention, total cap, per-feed cap) — if a feed still serves that item on
-- a later poll, fetch-feeds has no row left to match against and inserts it
-- fresh with a new id. Keying reads on articles.id meant that cascade-deleted
-- the read receipt right along with the row, so the reinserted article came
-- back unread — reading to the user as an old, already-read article
-- "duplicating" itself back in. Keying on (feed_id, guid) instead means the
-- read receipt survives that churn regardless of which maintenance job (or
-- future one) caused it. Markers only expire after 90 days of observed absence
-- from successful source snapshots, never based on reading age or article caps.
create table if not exists article_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  feed_id uuid not null references feeds(id) on delete cascade,
  guid text not null,
  link text, -- article's link at read time; lets fetch-feeds migrate a marker
             -- across a guid drift (feeds change <guid> schemes, or the
             -- link-derived guid moves when a link is rewritten). Kept on the
             -- marker rather than the article row so the migration works even
             -- after the article row itself was purged and re-inserted.
  read_at timestamptz not null default now(),
  -- NULL means present or not checked yet, not absent since the reading date.
  absent_since timestamptz,
  absence_confirmed_at timestamptz,
  primary key (user_id, feed_id, guid)
);

alter table article_reads enable row level security;

create policy "article_reads_select_own" on article_reads
  for select using (auth.uid() = user_id);
create policy "article_reads_insert_own" on article_reads
  for insert with check (auth.uid() = user_id and exists (
    select 1 from feeds f where f.id = article_reads.feed_id and f.user_id = auth.uid()
  ));
create policy "article_reads_update_own" on article_reads
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id and exists (
    select 1 from feeds f where f.id = article_reads.feed_id and f.user_id = auth.uid()
  ));
create policy "article_reads_delete_own" on article_reads
  for delete using (auth.uid() = user_id);

-- ─── STORAGE-BOUNDING MAINTENANCE ────────────────────────────────────────
-- Article storage has three bounds, separate from compact read-history retention:
--
-- 1) Total-article cap: the hard ceiling. Even if every feed were somehow
--    exempt from the rules below, each daily sweep keeps at most max_total
--    articles per user. Counts can exceed this between sweeps.
-- 2) 7-day retention: nothing stays around more than a week after we first
--    ingested it, regardless of volume. In practice this rarely even fires
--    once (1) is in place — a handful of high-volume feeds can fill the
--    total cap in well under 7 days, at which point (1) is already the rule
--    doing the trimming.
-- 3) Per-feed cap: keeps any single very high-volume feed from crowding out
--    every other feed's articles within the shared total-cap budget.
create or replace function cap_total_articles(max_total int default 2000)
returns void language sql security definer set search_path = public as $$
  delete from articles a
  using (
    select ar.id, row_number() over (
      partition by f.user_id order by ar.published_at desc
    ) as rn
    from articles ar
    join feeds f on f.id = ar.feed_id
  ) ranked
  where a.id = ranked.id and ranked.rn > max_total;
$$;

-- Retention measures time stored, not the publication date claimed by a feed.
-- Separate read markers preserve read status if a deleted article is reinserted.
create or replace function cleanup_old_articles()
returns void language sql security definer set search_path = public as $$
  delete from articles where created_at < now() - interval '7 days';
$$;

create or replace function cap_articles_per_feed(max_per_feed int default 200)
returns void language sql security definer set search_path = public as $$
  delete from articles a
  using (
    select id, row_number() over (partition by feed_id order by published_at desc) as rn
    from articles
  ) ranked
  where a.id = ranked.id and ranked.rn > max_per_feed;
$$;

-- Never infer source absence from article cleanup or storage caps.
create or replace function public.record_feed_presence(
  target_feed uuid, identities jsonb, checked_at timestamptz
)
returns void language plpgsql security definer set search_path = public as $$
declare
  previous_check timestamptz;
  identity_row record;
begin
  if identities is null or jsonb_typeof(identities) <> 'array' or checked_at is null then
    raise exception 'A complete feed identity array and check time are required';
  end if;
  -- Serialize overlapping refreshes; an older response cannot undo a newer snapshot.
  select presence_checked_at into previous_check from feeds
    where id = target_feed for update;
  if not found or previous_check >= checked_at then return; end if;

  -- Repair links by stable GUID before migrating changed GUIDs by stable link.
  -- This survives link changes followed later by GUID changes, even after purge.
  update article_reads r set link = source.link
    from jsonb_to_recordset(identities) as source(guid text, link text)
    where r.feed_id = target_feed and r.guid = source.guid
      and source.link is not null and r.link is distinct from source.link;
  for identity_row in
    select min(source.guid) as guid, source.link
    from jsonb_to_recordset(identities) as source(guid text, link text)
    where source.guid is not null and source.link is not null
    group by source.link having count(distinct source.guid) = 1
  loop
    insert into article_reads (user_id, feed_id, guid, link, read_at)
      select user_id, target_feed, identity_row.guid, identity_row.link, min(read_at)
      from article_reads
      where feed_id = target_feed and link = identity_row.link and guid <> identity_row.guid
      group by user_id
      on conflict (user_id, feed_id, guid) do nothing;
    -- Consolidate aliases so marking the current GUID unread cannot resurrect it.
    delete from article_reads where feed_id = target_feed
      and link = identity_row.link and guid <> identity_row.guid;
  end loop;

  with presence as (
    select r.user_id, r.guid, exists (
      select 1 from jsonb_to_recordset(identities) as entry(guid text, link text)
      where entry.guid = r.guid or (r.link is not null and entry.link = r.link)
    ) as present
    from article_reads r where r.feed_id = target_feed
  )
  update article_reads r
    set absent_since = case when p.present then null else coalesce(r.absent_since, checked_at) end,
        absence_confirmed_at = case when p.present then null else checked_at end
    from presence p
    where r.feed_id = target_feed and r.user_id = p.user_id and r.guid = p.guid;

  update feeds set presence_checked_at = checked_at where id = target_feed;
end;
$$;

create or replace function public.cleanup_old_read_markers()
returns void language sql security definer set search_path = public as $$
  delete from article_reads r using feeds f
  where r.feed_id = f.id and f.active and f.error_count = 0
    and r.absence_confirmed_at > r.absent_since + interval '90 days'
    and f.presence_checked_at > now() - interval '1 day'
    -- Preserve any article still available in the reader as an extra safeguard.
    and not exists (
      select 1 from articles a where a.feed_id = r.feed_id
        and (a.guid = r.guid or a.link = r.link)
    );
$$;

revoke execute on function public.record_feed_presence(uuid, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.record_feed_presence(uuid, jsonb, timestamptz) to service_role;
-- These are maintenance functions invoked only by the pg_cron job below
-- (which runs as the scheduling role) — they have no business being
-- callable by anon/authenticated clients. Revoking from PUBLIC alone isn't
-- enough: Supabase grants EXECUTE on new public-schema functions to
-- anon/authenticated directly, so both need explicit revokes.
revoke execute on function cap_total_articles(int) from public, anon, authenticated;
revoke execute on function cleanup_old_articles() from public, anon, authenticated;
revoke execute on function cap_articles_per_feed(int) from public, anon, authenticated;
revoke execute on function cleanup_old_read_markers() from public, anon, authenticated;

select cron.schedule(
  'cleanup-old-articles-daily',
  '30 3 * * *',
  $$ select cap_total_articles(2000); select cleanup_old_articles(); select cap_articles_per_feed(200); select cleanup_old_read_markers(); $$
);

-- Existing databases must use the incremental SQL files in migrations/;
-- this fresh-install schema is not an upgrade script.
-- Feed fetching is triggered client-side (on load, on manual refresh, and
-- on feed adding), not by cron. If you're migrating an older deployment of
-- this project that still has a fetch-feeds cron job scheduled, remove it:
--   select cron.unschedule('fetch-feeds-every-30-min');
