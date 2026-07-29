-- Lets a user rename a feed in the UI without that name being silently
-- overwritten by fetch-feeds on the next refresh (which updates `title` from
-- whatever the feed itself publishes). display_name, when set, always wins
-- client-side — feedTitle() in app.js prefers it over title/url. Nothing
-- server-side needs to change: fetch-feeds never touches this column.

alter table feeds add column if not exists display_name text;
