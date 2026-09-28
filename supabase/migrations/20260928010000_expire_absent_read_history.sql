begin;

-- NULL means present or not checked yet; never infer absence from article cleanup.
alter table public.article_reads add column if not exists absent_since timestamptz;
alter table public.article_reads add column if not exists absence_confirmed_at timestamptz;
alter table public.feeds add column if not exists presence_checked_at timestamptz;

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
revoke execute on function public.cleanup_old_read_markers() from public, anon, authenticated;

select cron.schedule(
  'cleanup-old-articles-daily', '30 3 * * *',
  $$ select cap_total_articles(2000); select cleanup_old_articles(); select cap_articles_per_feed(200); select cleanup_old_read_markers(); $$
);

commit;
