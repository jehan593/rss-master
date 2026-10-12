-- Folders have no feed URL, including requests from older browser tabs.
begin;
create or replace function public.save_library_item(item_kind text, item_id uuid, destination uuid, before_id uuid, new_name text, new_url text)
returns void language plpgsql security definer set search_path = public as $$
declare owner_id uuid := auth.uid(); slot integer; old_parent uuid; current_url text;
begin
  new_url := case when item_kind = 'feed' then nullif(trim(new_url), '') else null end;
  if owner_id is null then raise exception 'Sign in first'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text, 0));
  if item_kind not in ('folder','feed') then raise exception 'Invalid item'; end if;
  if destination is not null and not exists(select 1 from folders where id=destination and user_id=owner_id) then raise exception 'Folder unavailable'; end if;
  if item_id is not null then
    if item_kind='folder' then
      select parent_id into old_parent from folders where id=item_id and user_id=owner_id;
      if not found then raise exception 'Folder unavailable'; end if;
      if exists(with recursive descendants as (
        select id from folders where id=item_id
        union all select f.id from folders f join descendants d on f.parent_id=d.id
      ) select 1 from descendants where id=destination) then raise exception 'A folder cannot move inside itself'; end if;
    else
      select url into current_url from feeds where id=item_id and user_id=owner_id;
      if not found then raise exception 'Feed unavailable'; end if;
    end if;
  elsif item_kind <> 'folder' then raise exception 'Invalid feed'; end if;
  if new_name is not null and (length(trim(new_name))=0 or length(new_name)>150) then raise exception 'Enter a name (up to 150 characters)'; end if;
  if new_url is not null and new_url !~* '^https?://' then raise exception 'Enter an HTTP(S) feed URL'; end if;
  select coalesce(max(position)+1,0) into slot from (
    select position from folders where user_id=owner_id union all select position from feeds where user_id=owner_id
  ) positions;
  if before_id is not null and before_id is distinct from item_id then
    select position into slot from (
      select id, position from folders where user_id=owner_id and parent_id is not distinct from destination
      union all select id, position from feeds where user_id=owner_id and folder_id is not distinct from destination
    ) siblings where id=before_id;
    if not found then raise exception 'Destination changed. Try again'; end if;
    update folders set position=position+1 where user_id=owner_id and position>=slot;
    update feeds set position=position+1 where user_id=owner_id and position>=slot;
  end if;
  if item_kind='folder' then
    if item_id is null then
      insert into folders(user_id,name,parent_id,position) values(owner_id,trim(new_name),destination,slot);
    else
      update folders set name=coalesce(trim(new_name),name),parent_id=destination,position=slot where id=item_id and user_id=owner_id;
    end if;
  else
    update feeds set display_name=coalesce(trim(new_name),display_name),url=coalesce(new_url,url),folder_id=destination,position=slot,
      etag=case when new_url is distinct from current_url and new_url is not null then null else etag end,
      last_modified=case when new_url is distinct from current_url and new_url is not null then null else last_modified end,
      last_fetched_at=case when new_url is distinct from current_url and new_url is not null then null else last_fetched_at end,
      active=case when new_url is not null and new_url is distinct from current_url then true else active end,
      error_count=case when new_url is not null and new_url is distinct from current_url then 0 else error_count end where id=item_id and user_id=owner_id;
  end if;
end;
$$;
commit;
