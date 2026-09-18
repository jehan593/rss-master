# RSS Master

> FYI: This project is fully vibe coded.

**[Live demo](https://jehan593.github.io/rss-master/)**

A simple RSS and Atom reader with email sign-in and read status that syncs
across devices. Built with HTML, CSS, and JavaScript, with Supabase for
accounts, storage, and feed fetching. No build step required.

## Features

- Add a feed URL or paste a website address to find its feeds
- Refresh feeds on app load or with **Refresh**
- Expand articles inline, mark all visible articles read, or mark individual
  articles unread — read status syncs across devices through your account
- Load more articles from all feeds or a single feed
- Search, rename, and reorder feeds
- Import and export feed lists as **OPML**
- Daily article cleanup and storage caps — see [Storage design](#storage-design)
- Responsive Nord dark theme with Martian Mono, keyboard controls, and labelled dialogs

## Tech stack

- Vanilla JavaScript, HTML, and CSS — no build tooling or framework
- [Supabase](https://supabase.com) for email sign-in, Postgres storage, and a Deno function that fetches feeds
- `pg_cron` for daily storage cleanup
- Self-hosted Martian Mono webfont

## Setup

### 1. Create a Supabase project

Create a project at [supabase.com](https://supabase.com).

### 2. Run the schema

For a fresh project, open **SQL Editor** in the Supabase dashboard, paste in
[`supabase/schema.sql`](supabase/schema.sql), and run it once. It creates
the tables, access rules, and daily cleanup jobs.

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

### 5. Run locally or deploy

Static site, so any web server works:

```bash
npx serve .
# or: python -m http.server 5757
```

Or deploy to GitHub Pages (Settings → Pages → deploy from branch). Whichever
origin you deploy to, add it under **Authentication → URL Configuration →
Redirect URLs** in the Supabase dashboard so email sign-in can return to your app.
Opening `index.html` directly from disk also works, except sign-in and feed
fetching (browsers block `fetch`/auth from `file://` origins).

## Reading and sync

- Click an article to expand it. Collapsing it or opening another article
  marks the previous article read. **Open original** also marks it read.
- **Mark all read** applies to loaded articles in the current view.
- **Mark unread** is available on expanded read articles and collapses them.
- Feeds, articles, and read status reload when you return to the browser tab.
  Fetching new content from feed sources happens on app load, **Refresh**,
  and after adding or importing feeds.
- Read markers load in pages, so histories larger than Supabase's default
  1,000-row response limit still sync completely. Failed loads preserve
  existing markers, and stale responses cannot overwrite newer local changes.
- The browser caches loaded feeds, articles, and read status for offline
  viewing. Saving changes across devices requires a Supabase connection.

## Project structure

```
index.html                            Markup and layout
style.css                             Styling
icon.svg                              App icon
app.js                                App state, rendering, Supabase calls
fonts/                                Self-hosted Martian Mono font
supabase/schema.sql                   Schema, RLS, storage cleanup, cron job
supabase/functions/fetch-feeds/        Feed fetching, parsing, and discovery
tests/read-state.test.cjs             Read-status sync regression tests
```

## Tests

With Node.js 22 or newer, run from the project root:

```bash
node --test tests/read-state.test.cjs
node --check app.js
```

No dependency installation is needed. The tests use a mocked Supabase client
to cover pagination, failed loads, refresh races, pending writes, and
cross-device read/unread reconciliation.

## Storage design

The app uses article caps and retention windows to keep database storage
small. Cleanup runs daily at 03:30 UTC through `pg_cron`:

- **Only metadata is stored** — title, link, published date, and a summary
  truncated to 500 characters. Full article HTML/content is never stored;
  articles link out to the original source.
- **Total article cap (primary bound)**: a daily `pg_cron` job
  (`cap_total_articles()`) keeps each user's 2000 most recent articles across
  all their feeds combined and deletes the rest. Article counts can exceed
  this limit between daily sweeps.
- **7-day retention**: the same sweep deletes article rows stored for more
  than 7 days (`cleanup_old_articles()`). This uses `created_at`, when the row
  was inserted, rather than the feed's publication date.
- **Per-feed cap**: each feed is additionally capped at its 200 most recent
  articles, enforced both right after every fetch and by the daily sweep
  (`cap_articles_per_feed()`), so one very high-volume feed can't crowd out
  every other feed's articles within the shared total-cap budget.
- **Separate read history**: `article_reads` is keyed by
  `(user_id, feed_id, guid)`, so deleting and reinserting an article does not
  delete its read marker. Markers are removed when their feed or user is
  deleted, or when `read_at` is more than 30 days old
  (`cleanup_old_read_markers()`). An article still served by its feed can
  appear unread again after its marker expires.
- **Deduplication**: incoming articles are resolved by `(feed_id, link)` OR
  `(feed_id, guid)` first — repairing whichever field drifted on a match
  instead of inserting — then upserted on `(feed_id, guid)` for anything new,
  to avoid duplicates when either identity changes. Stored marker links
  also let the fetcher migrate read status when a feed changes an article's
  GUID but keeps its link.
- **Conditional fetching**: the Edge Function sends `If-None-Match` /
  `If-Modified-Since` on every request and skips parsing entirely on a
  `304 Not Modified` response, keeping fetch cost low as feed count grows.

Storage usage depends on feed count, article volume, and read activity within
these retention windows.
