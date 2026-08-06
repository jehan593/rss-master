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
-- future one) caused it. No FK to articles.id, so it's now bounded instead
-- by cleanup_old_read_markers() below rather than cascading.
create table if not exists article_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  feed_id uuid not null references feeds(id) on delete cascade,
  guid text not null,
  read_at timestamptz not null default now(),
  primary key (user_id, feed_id, guid)
);

alter table article_reads enable row level security;

create policy "article_reads_select_own" on article_reads
  for select using (auth.uid() = user_id);
create policy "article_reads_insert_own" on article_reads
  for insert with check (auth.uid() = user_id);
create policy "article_reads_update_own" on article_reads
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "article_reads_delete_own" on article_reads
  for delete using (auth.uid() = user_id);

-- ─── STORAGE-BOUNDING MAINTENANCE ────────────────────────────────────────
-- Three bounds, in order of precedence (most authoritative first) since the
-- free Supabase plan caps database storage at 500MB and this project is
-- built to stay far under that indefinitely:
--
-- 1) Total-article cap: the hard ceiling. Even if every feed were somehow
--    exempt from the rules below, no user can ever accumulate more than
--    max_total articles. This is what actually guarantees bounded storage —
--    the other two rules are hygiene on top of it, not the thing doing the
--    bounding.
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

-- Keyed on created_at (when we first ingested the row), not published_at
-- (whatever date the feed itself claims). A feed that keeps older items in
-- its XML — slow-cadence blogs, evergreen/backlog content, or a feed you
-- just added with backlog older than a week — would otherwise get those
-- rows deleted here and then re-inserted as a brand-new unread article on
-- the very next refresh (the dedup lookup in fetch-feeds can't match against
-- a row that's gone), which reads to the user as an old, already-read
-- article "duplicating" itself back in as unread.
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

-- article_reads is no longer FK-cascaded off articles.id (see the table's
-- own comment above), so it needs its own bound instead of inheriting the
-- articles table's. 30 days is deliberately much longer than the article
-- retention window above — it only exists to keep read-marker storage
-- bounded over the long run, not to make read status "expire".
create or replace function cleanup_old_read_markers()
returns void language sql security definer set search_path = public as $$
  delete from article_reads where read_at < now() - interval '30 days';
$$;

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

-- Feed fetching is triggered client-side (on load, on manual refresh, and
-- on feed adding), not by cron. If you're migrating an older deployment of
-- this project that still has a fetch-feeds cron job scheduled, remove it:
--   select cron.unschedule('fetch-feeds-every-30-min');
