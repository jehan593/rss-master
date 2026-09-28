-- Run against a provisioned database with at least one user. All changes roll back.
begin;
do $$
declare
  test_user uuid;
  test_feed uuid;
begin
  select id into test_user from auth.users limit 1;
  if test_user is null then
    raise exception 'Read-retention test requires an existing user';
  end if;
  insert into public.feeds (user_id, url, title)
    values (test_user, 'https://example.invalid/' || gen_random_uuid(), 'Retention regression')
    returning id into test_feed;
  insert into public.articles (feed_id, guid, link, title, created_at)
    values (test_feed, 'old-entry', 'https://example.invalid/entry', 'Old entry', now() - interval '8 days');
  insert into public.article_reads (user_id, feed_id, guid, link, read_at)
    values (test_user, test_feed, 'old-entry', 'https://example.invalid/entry', now() - interval '90 days');

  perform public.cleanup_old_articles();
  perform public.cleanup_old_read_markers();
  if exists (select 1 from public.articles where feed_id = test_feed) then
    raise exception 'Seven-day article cleanup did not run';
  end if;
  if not exists (select 1 from public.article_reads where feed_id = test_feed) then
    raise exception 'Cleanup erased read history for a slow feed';
  end if;

  insert into public.articles (feed_id, guid, link, title)
    values (test_feed, 'old-entry', 'https://example.invalid/entry', 'Old entry');
  if not exists (
    select 1 from public.articles a join public.article_reads r
      on r.feed_id = a.feed_id and r.guid = a.guid
    where a.feed_id = test_feed and r.user_id = test_user
  ) then
    raise exception 'Reinserted article lost its read status';
  end if;

  -- Reading age alone is irrelevant; observing an entry clears absence.
  perform public.record_feed_presence(test_feed,
    '[{"guid":"old-entry","link":"https://example.invalid/entry"}]', now() - interval '92 days');
  perform public.record_feed_presence(test_feed,
    '[{"guid":"other","link":"https://example.invalid/other"}]', now() - interval '91 days');
  if not exists (select 1 from public.article_reads where feed_id = test_feed
    and absent_since = now() - interval '91 days') then
    raise exception 'First confirmed absence was not recorded';
  end if;
  -- An old response arriving late must not reset newer absence tracking.
  perform public.record_feed_presence(test_feed,
    '[{"guid":"old-entry"}]', now() - interval '92 days');
  delete from public.articles where feed_id = test_feed;
  perform public.cleanup_old_read_markers();
  if not exists (select 1 from public.article_reads where feed_id = test_feed) then
    raise exception 'Stale observation incorrectly expired a marker';
  end if;
  -- A changed GUID with the same link is still present, even without an article row.
  perform public.record_feed_presence(test_feed,
    '[{"guid":"changed-guid","link":"https://example.invalid/entry"}]', now() - interval '90 days');
  if exists (select 1 from public.article_reads where feed_id = test_feed and absent_since is not null) then
    raise exception 'Link identity did not reset absence';
  end if;
  if not exists (select 1 from public.article_reads where feed_id = test_feed and guid = 'changed-guid') then
    raise exception 'GUID change did not migrate read identity';
  end if;
  perform public.record_feed_presence(test_feed, '[{"guid":"other"}]', now() - interval '89 days');
  perform public.record_feed_presence(test_feed, '[{"guid":"other"}]', now() - interval '1 hour');
  perform public.cleanup_old_read_markers();
  if not exists (select 1 from public.article_reads where feed_id = test_feed) then
    raise exception 'Marker expired before 90 days of absence';
  end if;
  update public.article_reads set absent_since = now() - interval '91 days' where feed_id = test_feed;
  update public.feeds set error_count = 1 where id = test_feed;
  perform public.cleanup_old_read_markers();
  if not exists (select 1 from public.article_reads where feed_id = test_feed) then
    raise exception 'Failed feed lost read history';
  end if;
  update public.feeds set error_count = 0, active = false where id = test_feed;
  perform public.cleanup_old_read_markers();
  if not exists (select 1 from public.article_reads where feed_id = test_feed) then
    raise exception 'Paused feed lost read history';
  end if;
  update public.feeds set active = true where id = test_feed;
  perform public.record_feed_presence(test_feed, '[{"guid":"other"}]', now());
  insert into public.articles (feed_id, guid, link, title)
    values (test_feed, 'changed-guid', 'https://example.invalid/entry', 'Still in reader');
  perform public.cleanup_old_read_markers();
  if not exists (select 1 from public.article_reads where feed_id = test_feed) then
    raise exception 'An article still stored in the reader lost its marker';
  end if;
  delete from public.articles where feed_id = test_feed;
  perform public.cleanup_old_read_markers();
  if exists (select 1 from public.article_reads where feed_id = test_feed) then
    raise exception 'Confirmed 90-day absence did not expire marker';
  end if;
  insert into public.article_reads (user_id, feed_id, guid) values (test_user, test_feed, 'new-marker');
  perform public.cleanup_old_read_markers();
  if not exists (select 1 from public.article_reads where feed_id = test_feed) then
    raise exception 'Unobserved marker was expired';
  end if;
  -- Stable GUID repairs a moved link, which later allows GUID migration after purge.
  perform public.record_feed_presence(test_feed,
    '[{"guid":"new-marker","link":"https://example.invalid/moved"}]', now() + interval '1 second');
  insert into public.article_reads (user_id, feed_id, guid, link)
    values (test_user, test_feed, 'new-guid', 'https://example.invalid/moved');
  perform public.record_feed_presence(test_feed,
    '[{"guid":"new-guid","link":"https://example.invalid/moved"}]', now() + interval '2 seconds');
  if (select count(*) from public.article_reads where feed_id = test_feed) <> 1
    or not exists (select 1 from public.article_reads where feed_id = test_feed and guid = 'new-guid') then
    raise exception 'GUID alias conflict was not consolidated';
  end if;
  if has_function_privilege('authenticated', 'public.record_feed_presence(uuid,jsonb,timestamptz)', 'execute')
    or has_function_privilege('anon', 'public.cleanup_old_read_markers()', 'execute') then
    raise exception 'Maintenance RPC is exposed to clients';
  end if;
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.article_reads (user_id, feed_id, guid)
      values (auth.uid(), test_feed, 'cross-user');
    raise exception 'A user could create a marker on another user''s feed';
  exception when insufficient_privilege then
    null; -- Expected RLS rejection, before foreign-key validation.
  end;
  execute 'reset role';
  delete from public.feeds where id = test_feed;
  if exists (select 1 from public.article_reads where feed_id = test_feed) then
    raise exception 'Removing a feed did not remove its read history';
  end if;
end;
$$;
rollback;
