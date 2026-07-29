-- Adds a persisted display order to feeds, so the reorder (up/down) buttons
-- in the Feeds tab have somewhere to store their result. Existing feeds are
-- backfilled in their current created_at order; a trigger assigns new feeds
-- the next position for their user automatically, so the client never needs
-- to compute it itself (avoids races between concurrent inserts).

alter table feeds add column if not exists position integer;

with ordered as (
  select id, row_number() over (partition by user_id order by created_at asc) as rn
  from feeds
)
update feeds set position = ordered.rn
from ordered
where feeds.id = ordered.id;

create or replace function feeds_set_next_position()
returns trigger language plpgsql as $$
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

alter table feeds alter column position set not null;

create index if not exists feeds_position_idx on feeds (user_id, position);
