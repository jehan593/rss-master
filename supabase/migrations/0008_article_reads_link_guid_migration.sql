-- Fix: cross-device read state going backwards when a feed drifts guids
--
-- read markers are keyed on (feed_id, guid), but guid is mutable: a feed can
-- change its <guid>/<id> scheme, or the link-derived fallback guid can move
-- when the feed rewrites its links (see the fetch-feeds header for why the
-- object falls back to link). When a refreshed row comes in under a new guid,
-- every marker still parked under the OLD guid is orphaned, so the article
-- reverts to unread on every device that re-fetches — even device B that
-- re-fetched after device A read it. That reads as "one device says read,
-- another says unread".
--
-- The identity that survives this churn is the link. To let fetch-feeds
-- migrate markers forward when a guid drifts, article_reads now stores the
-- article's link at write time. fetch-feeds uses it to relabel existing
-- markers to the current guid (see the migration loop it runs per feed).
--
-- The backfill below seeds `link` for markers that already exist, joining
-- through the article row where it still exists (markers that outlived their
-- article row via purge+reinsert can't be matched by guid — they'll simply
-- remain until cleanup_old_read_markers() reclaims them).

alter table article_reads
  add column if not exists link text;

-- Backfill existing markers with the link of the article row they point at.
update article_reads ar
  set link = a.link
from articles a
where ar.feed_id = a.feed_id
  and ar.guid = a.guid
  and ar.link is null;