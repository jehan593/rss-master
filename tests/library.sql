-- Run against a populated project with `supabase db query --linked --file tests/library.sql`.
-- All test data and changes are rolled back.
begin;
do $$
declare owner_id uuid; root_id uuid; child_id uuid; feed_id uuid; rejected boolean := false;
begin
  select id into owner_id from auth.users limit 1;
  if owner_id is null then raise exception 'A test account is required'; end if;
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform public.save_library_item('folder',null,null,null,'Sidebar test root','');
  select id into root_id from public.folders where user_id=owner_id and name='Sidebar test root';
  perform public.save_library_item('folder',null,root_id,null,'Sidebar test child',null);
  select id into child_id from public.folders where user_id=owner_id and name='Sidebar test child';
  insert into public.feeds(user_id,url,folder_id) values(owner_id,'https://example.invalid/sidebar-test-' || root_id,child_id) returning id into feed_id;
  begin
    perform public.save_library_item('folder',root_id,child_id,null,null,null);
  exception when others then rejected := true;
  end;
  if not rejected then raise exception 'Cycle protection failed'; end if;
  perform public.save_library_item('feed',feed_id,root_id,child_id,'Renamed feed','https://example.invalid/updated-' || root_id);
  if not exists(select 1 from public.feeds where id=feed_id and folder_id=root_id and display_name='Renamed feed') then raise exception 'Feed editing or movement failed'; end if;
  if (select position from public.feeds where id=feed_id) >= (select position from public.folders where id=child_id) then raise exception 'Sibling ordering failed'; end if;
  perform public.delete_library_folder(root_id);
  if not exists(select 1 from public.feeds where id=feed_id and folder_id is null) or not exists(select 1 from public.folders where id=child_id and parent_id is null) then raise exception 'Folder deletion did not preserve children'; end if;
  perform public.save_library_item('folder',child_id,null,feed_id,null,null);
  if (select position from public.folders where id=child_id) >= (select position from public.feeds where id=feed_id) then raise exception 'Folder could not reorder before a feed'; end if;
  perform public.save_library_item('folder',child_id,null,null,null,null);
  if (select position from public.folders where id=child_id) <= (select position from public.feeds where id=feed_id) then raise exception 'Folder could not reorder after a feed'; end if;
end;
$$;
rollback;
