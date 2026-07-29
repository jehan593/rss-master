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
- Feeds are fetched automatically every 30 minutes in the background
  (`pg_cron`), plus an on-demand **Refresh** button
- Click an article to expand it inline (only one open at a time) — read/unread
  tracking synced across devices through your account
- A searchable feed picker with a distinct auto-generated color per feed, and
  drag-free up/down reordering
- Rename any feed's display name without it being overwritten on the next fetch
- Import/export your feed list as **OPML**, compatible with any other reader
- Articles older than 30 days are deleted automatically — see [Storage design](#storage-design)
- Mobile-first responsive layout

## Tech stack

- Vanilla JavaScript, HTML, and CSS — no build tooling or framework
- [Supabase](https://supabase.com) for auth (magic-link email sign-in), Postgres storage, and a Deno Edge Function that fetches/parses feeds
- `pg_cron` + `pg_net` for scheduled background fetching and cleanup
- Self-hosted Martian Mono webfont

## Setup

### 1. Create a Supabase project

Create a new project at [supabase.com](https://supabase.com) (the free tier is
enough — see [Storage design](#storage-design)).

### 2. Run the schema migrations

Open **SQL Editor** in the Supabase dashboard and run each file in
[`supabase/migrations/`](supabase/migrations) **in order**:

1. `0001_init.sql` — schema, RLS, retention/cap functions, cron jobs
2. `0002_feed_position.sql` — adds feed reordering
3. `0003_feed_display_name.sql` — adds feed renaming

Before running `0001_init.sql`, edit the bottom
`cron.schedule('fetch-feeds-every-30-min', ...)` block:
- replace `<PROJECT-REF>` with your project ref (visible in the project URL)
- replace `<SERVICE-ROLE-KEY>` with your API secret key (Project Settings → API)

You can re-run just that `cron.schedule(...)` block later (e.g. `select
cron.schedule(...)`) if you need to change the schedule or rotate the key —
`cron.schedule` upserts by job name.

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
supabase/migrations/0001_init.sql                Schema, RLS, retention/cap functions, cron jobs
supabase/migrations/0002_feed_position.sql       Feed reordering
supabase/migrations/0003_feed_display_name.sql   Feed renaming
supabase/functions/fetch-feeds/                  Edge function: fetches/parses feeds, feed autodiscovery
```

## Storage design

The free Supabase plan caps database storage at 500MB. This app is designed
so that usage stays small and **bounded** regardless of how long it runs or
how many feeds you add:

- **Only metadata is stored** — title, link, published date, and a summary
  truncated to 500 characters. Full article HTML/content is never stored;
  articles link out to the original source.
- **30-day retention**: a daily `pg_cron` job deletes every article older
  than 30 days (`cleanup_old_articles()`).
- **Per-feed cap**: each feed is capped at its 200 most recent articles,
  enforced both right after every fetch and by a daily sweep
  (`cap_articles_per_feed()`). This bounds total rows to roughly
  `(number of feeds) × 200`, independent of the 30-day window — a
  high-volume feed can never balloon storage on its own.
- **Read-state cascades**: `article_reads` rows are deleted automatically
  (`ON DELETE CASCADE`) whenever their article is removed by either cleanup
  job, so that table can never outgrow `articles`.
- **Deduplication**: articles are upserted on `(feed_id, guid)`, so re-fetching
  a feed never creates duplicate rows.
- **Conditional fetching**: the Edge Function sends `If-None-Match` /
  `If-Modified-Since` on every request and skips parsing entirely on a
  `304 Not Modified` response, keeping fetch cost low as feed count grows.

With these bounds, even a large personal subscription list (dozens of feeds)
stays at a few MB — far under the 500MB limit — indefinitely.
