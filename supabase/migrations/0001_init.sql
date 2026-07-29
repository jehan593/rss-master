-- RSS Reader schema
-- Mirrors habit-tracker's pattern: per-user rows via auth.uid(), RLS-secured,
-- anon key safe to ship client-side. Run this whole file once in the
-- Supabase SQL editor (Project → SQL Editor → New query) on a fresh project.

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgcrypto; -- gen_random_uuid()

-- ─── FEEDS ────────────────────────────────────────────────────────────────
create table if not exists feeds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,
  title text,
  site_url text,
  last_fetched_at timestamptz,
  etag text,
  last_modified text,
  error_count int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, url)
);

create index if not exists feeds_active_idx on feeds (active) where active;

alter table feeds enable row level security;

create policy "feeds_select_own" on feeds
  for select using (auth.uid() = user_id);
create policy "feeds_insert_own" on feeds
  for insert with check (auth.uid() = user_id);
create policy "feeds_update_own" on feeds
  for update using (auth.uid() = user_id);
create policy "feeds_delete_own" on feeds
  for delete using (auth.uid() = user_id);

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
-- Cascades on article deletion so this table can never outgrow articles —
-- the 30-day retention job automatically bounds it too.
create table if not exists article_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  article_id uuid not null references articles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, article_id)
);

alter table article_reads enable row level security;

create policy "article_reads_select_own" on article_reads
  for select using (auth.uid() = user_id);
create policy "article_reads_insert_own" on article_reads
  for insert with check (auth.uid() = user_id);
create policy "article_reads_delete_own" on article_reads
  for delete using (auth.uid() = user_id);

-- ─── STORAGE-BOUNDING MAINTENANCE ────────────────────────────────────────
-- 1) Hard retention window: nothing older than 30 days ever stays around,
--    regardless of how many feeds exist. article_reads rows cascade-delete
--    with their article automatically.
create or replace function cleanup_old_articles()
returns void language sql security definer set search_path = public as $$
  delete from articles where published_at < now() - interval '30 days';
$$;

-- 2) Per-feed cap: even a very high-volume feed can never accumulate more
--    than max_per_feed rows, independent of the 30-day window above. This is
--    what actually guarantees total storage stays bounded as feed count
--    grows — total rows <= (active feeds) * max_per_feed, always.
create or replace function cap_articles_per_feed(max_per_feed int default 200)
returns void language sql security definer set search_path = public as $$
  delete from articles a
  using (
    select id, row_number() over (partition by feed_id order by published_at desc) as rn
    from articles
  ) ranked
  where a.id = ranked.id and ranked.rn > max_per_feed;
$$;

select cron.schedule(
  'cleanup-old-articles-daily',
  '30 3 * * *',
  $$ select cleanup_old_articles(); select cap_articles_per_feed(200); $$
);

-- Feed fetching is no longer cron-driven — the frontend triggers fetch-feeds
-- itself (on load, on manual refresh, and on feed adding). If a
-- fetch-feeds-every-30-min job was previously scheduled on this project,
-- remove it with: select cron.unschedule('fetch-feeds-every-30-min');
