-- Fix: guid-scheme change duplicated articles for feeds with real per-item guids
--
-- 0004_dedupe_articles.sql rewrote every existing article's guid to equal its
-- link. Later the same day, the fetch-feeds code changed to prefer a feed's
-- real <guid>/<id> tag over the link whenever it's provably not the library's
-- synthesized fallback (see fetch-feeds/index.ts header). No migration
-- re-synced existing rows to that new key, so for any feed whose items carry
-- a genuine guid that differs from their link (e.g. a CMS-issued id like
-- Ghost's ObjectIds), every subsequent refresh computed a guid that no longer
-- matched the stored (link-valued) guid — unique(feed_id, guid) missed the
-- existing row, and the upsert inserted a brand-new duplicate with no
-- article_reads entry, rendering unread articles that had already been read.
--
-- fetch-feeds now resolves incoming articles by link first and repairs the
-- guid on the existing row instead of ever inserting a duplicate this way
-- again. This migration is one-time cleanup for duplicates already created:
-- merge by (feed_id, link) — link never changed scheme and is the one
-- invariant across every duplicate of the same article — carrying read
-- status onto the row kept.

with dupes as (
  select id, feed_id, link,
         first_value(id) over (partition by feed_id, link order by created_at, id) as canonical_id
  from articles
)
insert into article_reads (user_id, article_id, read_at)
select ar.user_id, d.canonical_id, min(ar.read_at)
from article_reads ar
join dupes d on d.id = ar.article_id
where d.id <> d.canonical_id
group by ar.user_id, d.canonical_id
on conflict (user_id, article_id) do nothing;

with dupes as (
  select id, feed_id, link,
         first_value(id) over (partition by feed_id, link order by created_at, id) as canonical_id
  from articles
)
delete from articles a
using dupes d
where a.id = d.id and d.id <> d.canonical_id;
