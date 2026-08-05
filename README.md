# RSS Master

**[Live demo](https://jehan593.github.io/rss-master/)**

A minimal, self-hosted RSS/Atom feed reader. No build step, no framework —
just HTML, CSS, and JavaScript, same as
[habit-tracker](https://github.com/jehan593/habbit-tracker), with a Supabase
Edge Function doing the server-side feed fetching that a static site can't do
on its own.

## Features

- **Add any feed** by URL, or paste a site's homepage — feed autodiscovery
  finds its RSS/Atom link(s) automatically and lets you pick if there's more than one
- Feeds refresh automatically whenever the app loads, plus an on-demand
  **Refresh** button
- Click an article to expand it inline (only one open at a time) — read/unread
  tracking synced across devices through your account
- A searchable feed picker with a distinct auto-generated color per feed, and
  drag-free up/down reordering
- Rename any feed's display name without it being overwritten on the next fetch
- Import/export your feed list as **OPML**, compatible with any other reader
- Articles older than 7 days are deleted automatically, and total storage is
  capped outright — see [Storage design](#storage-design)
- Mobile-first responsive layout

## Tech stack

- Vanilla JavaScript, HTML, and CSS — no build tooling or framework
- [Supabase](https://supabase.com) for auth (magic-link email sign-in), Postgres storage, and a Deno Edge Function that fetches/parses feeds
- `pg_cron` for the daily storage cleanup job (feed fetching is triggered client-side, not by cron)
- Self-hosted Martian Mono webfont

## Setup

### 1. Create a Supabase project

Create a new project at [supabase.com](https://supabase.com) (the free tier is
enough — see [Storage design](#storage-design)).

### 2. Run the schema

Open **SQL Editor** in the Supabase dashboard, paste in
[`supabase/schema.sql`](supabase/schema.sql), and run it once. It creates
every table, RLS policy, and the storage-bounding maintenance jobs — nothing
else to run.

### 3. Deploy the Edge Function

Requires the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase login
supabase link --project-ref <PROJECT-REF>
supabase functions deploy fetch-feeds
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically into
every Edge Function by Supabase — no manual secrets needed.

### 4. Configure the frontend

In `app.js`, set:

```js
const SUPABASE_URL = 'https://<PROJECT-REF>.supabase.co';
const SUPABASE_ANON_KEY = '<your anon/public key>'; // Project Settings → API
```

### 5. Run it locally / deploy

Static site, so any web server works:

```bash
npx serve .
# or: python -m http.server 5757
```

Or deploy to GitHub Pages (Settings → Pages → deploy from branch). Whichever
origin you deploy to, add it under **Authentication → URL Configuration →
Redirect URLs** in the Supabase dashboard, or magic-link sign-in will fail.
Opening `index.html` directly from disk also works, except sign-in and feed
fetching (browsers block `fetch`/auth from `file://` origins).

## Project structure

```
index.html                                      Markup and layout
style.css                                        Styling
app.js                                           App state, rendering, Supabase calls
fonts/                                           Self-hosted Martian Mono font
supabase/schema.sql                              Schema, RLS, retention/cap functions, cron job — run once
supabase/functions/fetch-feeds/                  Edge function: fetches/parses feeds, feed autodiscovery
```

## Storage design

The free Supabase plan caps database storage at 500MB. This app is designed
so that usage stays small and **bounded** regardless of how long it runs or
how many feeds you add:

- **Only metadata is stored** — title, link, published date, and a summary
  truncated to 500 characters. Full article HTML/content is never stored;
  articles link out to the original source.
- **Total article cap (primary bound)**: a daily `pg_cron` job
  (`cap_total_articles()`) keeps each user's 2000 most recent articles across
  all their feeds combined and deletes the rest. This is the rule that
  actually guarantees bounded storage on the free plan — the other two rules
  below are hygiene on top of it, not what does the bounding.
- **7-day retention**: the same daily sweep deletes every article older than
  7 days (`cleanup_old_articles()`), regardless of the total cap. In
  practice a handful of high-volume feeds can fill the total cap in well
  under a week, so this rule rarely ends up being the one that fires.
- **Per-feed cap**: each feed is additionally capped at its 200 most recent
  articles, enforced both right after every fetch and by the daily sweep
  (`cap_articles_per_feed()`), so one very high-volume feed can't crowd out
  every other feed's articles within the shared total-cap budget.
- **Read-state cascades**: `article_reads` rows are deleted automatically
  (`ON DELETE CASCADE`) whenever their article is removed by any cleanup
  job, so that table can never outgrow `articles`.
- **Deduplication**: incoming articles are resolved by `(feed_id, link)` OR
  `(feed_id, guid)` first — repairing whichever field drifted on a match
  instead of inserting — then upserted on `(feed_id, guid)` for anything new,
  so re-fetching a feed never creates duplicate rows even if the feed
  rewrites its links or changes its guid scheme.
- **Conditional fetching**: the Edge Function sends `If-None-Match` /
  `If-Modified-Since` on every request and skips parsing entirely on a
  `304 Not Modified` response, keeping fetch cost low as feed count grows.

With these bounds, even a large personal subscription list (dozens of feeds)
stays at a few MB — far under the 500MB limit — indefinitely.
