-- Fix: article dedup key drift
--
-- fetch-feeds used to key each article's guid off feed-extractor's own
-- id/guid field. For feeds without a real <guid>/<id> tag, that library
-- synthesizes one as hash(link) + '-' + timestamp(pubDate) — which embeds
-- the item's pubDate, not just its link. When such a feed re-serializes an
-- already-seen item with a slightly different pubDate on a later poll (e.g.
-- after a long gap between refreshes), the synthesized guid changes even
-- though it's the same article — so unique(feed_id, guid) no longer catches
-- it, and the upsert inserts a brand-new row instead of recognizing the
-- existing one. The new row has no matching article_reads entry, so it
-- renders unread even if the "same" article was already read, and if it
-- pushed the true original past the 200-per-feed cap, the original (and its
-- read record, via article_reads' on delete cascade) got deleted outright.
--
-- The edge function now keys guid off the article's link directly, which
-- doesn't drift. This migration is one-time cleanup: merge duplicate rows
-- already created by the old behavior (carrying read status onto the row we
-- keep), then re-key every remaining row's guid to match the new scheme so
-- future refreshes actually hit the unique constraint instead of
-- duplicating again.

-- 1) Carry read status from every duplicate onto the row being kept.
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

-- 2) Delete the duplicate rows (their own article_reads rows cascade away).
with dupes as (
  select id, feed_id, link,
         first_value(id) over (partition by feed_id, link order by created_at, id) as canonical_id
  from articles
)
delete from articles a
using dupes d
where a.id = d.id and d.id <> d.canonical_id;

-- 3) Re-key every remaining row's guid to the new link-based scheme. Safe
--    from unique-constraint violations: after steps 1-2 each (feed_id, link)
--    pair maps to exactly one row.
update articles set guid = left(link, 500) where guid is distinct from left(link, 500);
