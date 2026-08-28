// Supabase Edge Function: fetch-feeds
//
// Invoked on-demand from the frontend, authenticated with the signed-in
// user's JWT, so it only ever refreshes that user's own feeds:
//   1. On load (see onSignedIn() in app.js) — no server-side cron anymore.
//   2. From the "Refresh now" button, and silently after adding a feed or
//      importing an OPML file (see refreshNow() call sites in app.js).
//   3. From "Add Feed" with a JSON body of {discover: <url>} — feed
//      discovery: if the URL isn't already a feed, fetches it and looks for
//      a <link rel="alternate" type="application/rss+xml|atom+xml"> tag to
//      resolve a plain website URL to its actual feed URL.
//
// The service_role-authenticated path (token === SERVICE_ROLE_KEY, refreshing
// every user's feeds) is kept below for anyone who wants to re-add a cron
// job, but nothing in this project schedules one anymore.
//
// Storage-bounding: summaries are truncated before insert, articles are
// upserted (never duplicated) keyed on (feed_id, guid) — but resolved by link
// OR guid first (see fetchOneFeed below), since either can drift independently
// (guid scheme change, or the feed rewriting links) and matching on only one
// would insert a duplicate for an article that already exists under the
// other key — and after each feed's items are inserted we trim it back down
// to MAX_ARTICLES_PER_FEED. The daily 7-day retention sweep and the total
// article cap live in Postgres (cleanup_old_articles, cap_total_articles),
// not here. Retention keys off created_at (ingestion time), not
// published_at (the feed's own claimed date) — a feed that legitimately
// serves items older than a week would otherwise get them deleted and then
// silently re-inserted as a new unread row on the next refresh, which looks
// to the user like an old, already-read article duplicating itself back in.
//
// guid prefers feed-extractor's own entry id (see fetchOneFeed below), but
// only when it's provably a real <guid>/<id> tag rather than the library's
// synthesized fallback. feed-extractor's getEntryId is:
//   id ? getText(id) : hash(pureUrl(link)) + '-' + (new Date(pubDate)).getTime()
// i.e. for feeds without a real guid/id tag, it synthesizes one that embeds
// the item's pubDate — which drifts whenever a feed re-serializes an old item
// with a slightly different pubDate, causing spurious duplicate rows. That
// synthesized shape (lowercase-base36-hash + '-' + all-digit epoch-ms) is
// deterministic, so isLikelySynthesizedId() below reliably tells "definitely
// not synthesized" (real guid, safe to use — stable even when a feed's link
// itself is unstable, e.g. tracking redirects/UTM params) from "might be
// synthesized" (falls back to link, which is what this key used to always be).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { extractFromXml } from 'https://esm.sh/@extractus/feed-extractor@7.1.3';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MAX_ARTICLES_PER_FEED = 200;
const MAX_SUMMARY_LENGTH = 500;
const MAX_ERROR_COUNT_BEFORE_DISABLE = 10;
const MIN_REFETCH_INTERVAL_MS = 4 * 60 * 1000; // guards on-demand refresh spam

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function stripHtml(html: string | undefined | null): string {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

// Matches feed-extractor's synthesized-id shape exactly: base36 hash + '-' +
// all-digit epoch-ms timestamp. A real <guid>/<id> tag could in principle
// collide with this shape, but never the reverse — so a non-match is proof
// the id came from the feed itself, not the library's fallback.
function isLikelySynthesizedId(id: string): boolean {
  return /^[0-9a-z]+-[0-9]+$/.test(id);
}

interface FeedRow {
  id: string;
  url: string;
  etag: string | null;
  last_modified: string | null;
  error_count: number;
  last_fetched_at: string | null;
}

async function fetchOneFeed(feed: FeedRow) {
  const headers: Record<string, string> = { 'User-Agent': 'rss-master/1.0 (+feed reader)' };
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

  let res: Response;
  try {
    res = await fetch(feed.url, { headers, redirect: 'follow' });
  } catch (err) {
    await admin.from('feeds').update({
      error_count: feed.error_count + 1,
      last_fetched_at: new Date().toISOString(),
      active: feed.error_count + 1 >= MAX_ERROR_COUNT_BEFORE_DISABLE ? false : undefined,
    }).eq('id', feed.id);
    return { feedId: feed.id, ok: false, reason: String(err) };
  }

  if (res.status === 304) {
    await admin.from('feeds').update({
      last_fetched_at: new Date().toISOString(),
      error_count: 0,
    }).eq('id', feed.id);
    return { feedId: feed.id, ok: true, inserted: 0, skipped: 'not-modified' };
  }

  if (!res.ok) {
    const nextErrorCount = feed.error_count + 1;
    await admin.from('feeds').update({
      error_count: nextErrorCount,
      last_fetched_at: new Date().toISOString(),
      active: nextErrorCount >= MAX_ERROR_COUNT_BEFORE_DISABLE ? false : undefined,
    }).eq('id', feed.id);
    return { feedId: feed.id, ok: false, reason: `HTTP ${res.status}` };
  }

  const xml = await res.text();
  let parsed;
  try {
    parsed = await extractFromXml(xml, { useISODateFormat: true });
  } catch (err) {
    const nextErrorCount = feed.error_count + 1;
    await admin.from('feeds').update({
      error_count: nextErrorCount,
      last_fetched_at: new Date().toISOString(),
      active: nextErrorCount >= MAX_ERROR_COUNT_BEFORE_DISABLE ? false : undefined,
    }).eq('id', feed.id);
    return { feedId: feed.id, ok: false, reason: `parse error: ${err}` };
  }

  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const rows = entries
    .filter((e: any) => e && (e.link || e.id))
    .slice(0, MAX_ARTICLES_PER_FEED) // never process more than the cap in one pass
    .map((e: any) => {
      const link = String(e.link || e.id);
      const rawId = e.id != null ? String(e.id) : '';
      const guidKey = rawId && !isLikelySynthesizedId(rawId) ? rawId : link;
      const publishedRaw = e.published || e.updated;
      const publishedAt = publishedRaw && !isNaN(Date.parse(publishedRaw))
        ? new Date(publishedRaw).toISOString()
        : new Date().toISOString();
      return {
        feed_id: feed.id,
        guid: guidKey.slice(0, 500),
        link: link.slice(0, 2000),
        title: truncate(stripHtml(e.title) || '(untitled)', 300),
        summary: truncate(stripHtml(e.description), MAX_SUMMARY_LENGTH),
        published_at: publishedAt,
      };
    });

  if (rows.length) {
    // Some feeds emit the same link twice in one poll (e.g. cross-posted
    // under a second guid). Only (feed_id, guid) is unique, not (feed_id,
    // link), so without this both would look "new" below and insert as two
    // separate rows.
    const seenLinks = new Set<string>();
    const dedupedRows = rows.filter((r) => {
      if (seenLinks.has(r.link)) return false;
      seenLinks.add(r.link);
      return true;
    });

    // Resolve existing rows by link OR guid — not link alone. A stored
    // article can drift on either axis independently: its guid changes
    // when the feed's own id scheme changes (see file header), or its link
    // changes when the feed rewrites URLs (redirects, tracking params,
    // AMP/non-AMP swaps) while the real <guid>/<id> tag stays put. Matching
    // on only one silently missed the other case and inserted an unread
    // duplicate of an already-read article.
    const links = dedupedRows.map((r) => r.link);
    const guids = dedupedRows.map((r) => r.guid);
    const [{ data: byLink, error: linkLookupError }, { data: byGuid, error: guidLookupError }] = await Promise.all([
      admin.from('articles').select('id,link,guid').eq('feed_id', feed.id).in('link', links),
      admin.from('articles').select('id,link,guid').eq('feed_id', feed.id).in('guid', guids),
    ]);
    const lookupError = linkLookupError || guidLookupError;
    if (lookupError) {
      return { feedId: feed.id, ok: false, reason: `lookup error: ${lookupError.message}` };
    }
    const existingByLink = new Map((byLink || []).map((r) => [r.link, r]));
    const existingByGuid = new Map((byGuid || []).map((r) => [r.guid, r]));

    const toInsert: typeof dedupedRows = [];
    const fixups: { id: string; guid?: string; link?: string }[] = [];
    for (const r of dedupedRows) {
      const match = existingByLink.get(r.link) || existingByGuid.get(r.guid);
      if (!match) {
        toInsert.push(r);
        continue;
      }
      const patch: { id: string; guid?: string; link?: string } = { id: match.id };
      if (match.guid !== r.guid) patch.guid = r.guid;
      if (match.link !== r.link) patch.link = r.link;
      if (patch.guid || patch.link) fixups.push(patch);
    }

    if (toInsert.length) {
      const { error } = await admin.from('articles').upsert(toInsert, { onConflict: 'feed_id,guid', ignoreDuplicates: true });
      if (error) {
        return { feedId: feed.id, ok: false, reason: `upsert error: ${error.message}` };
      }
    }
    for (const { id, ...patch } of fixups) {
      await admin.from('articles').update(patch).eq('id', id);
    }

    // Read markers are keyed on (feed_id, guid), and guid can legitimately
    // drift: a feed changes its <guid> scheme, or our link-derived fallback
    // guid moves when the feed rewrites its links. The fixups above keep the
    // stored article row aligned, but any reader already marked read stays
    // keyed under the OLD guid — which orphans the marker, so the article
    // reverts to unread everywhere (and reads as "not read" on fresh devices
    // even though one device still shows it read from cache). The link is the
    // one part of the identity that usually survives this churn, so migrate
    // any markers parked on this feed+link to the current guid. Skip entirely
    // when nothing was inserted or had its guid changed — that's the common
    // unchanged poll, and it would otherwise be ~200 no-op UPDATEs per feed.
    const guidChanged = fixups.some(f => f.guid);
    if (guidChanged || toInsert.length) {
      for (const r of dedupedRows) {
        const { error: migrateErr } = await admin.from('article_reads')
          .update({ guid: r.guid })
          .eq('feed_id', feed.id)
          .eq('link', r.link)
          .neq('guid', r.guid);
        // A (user_id, feed_id, guid) PK conflict can only happen if this user
        // also has a leftover marker under the target guid from a different
        // (purged) article that once used that guid — vanishingly rare, so
        // leave both rows alone rather than spreading — or losing — state.
        if (migrateErr && migrateErr.code !== '23505') {
          console.log(`read-marker guid migration skipped for ${feed.id}/${r.guid}: ${migrateErr.message}`);
        }
      }
    }
  }

  await admin.from('feeds').update({
    title: parsed.title ? String(parsed.title).slice(0, 200) : undefined,
    site_url: parsed.link ? String(parsed.link).slice(0, 500) : undefined,
    etag: res.headers.get('etag'),
    last_modified: res.headers.get('last-modified'),
    error_count: 0,
    last_fetched_at: new Date().toISOString(),
  }).eq('id', feed.id);

  return { feedId: feed.id, ok: true, inserted: rows.length };
}

// The cron job calls this server-to-server (no CORS involved), but the
// frontend's "Refresh now" button calls it directly from the browser via
// supabase-js, which preflights with an OPTIONS request and then requires
// Access-Control-Allow-Origin on every response — including error ones.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function discoverFeed(rawUrl: string): Promise<Response> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid url' }), { status: 400, headers: corsHeaders });
  }
  if (!/^https?:$/.test(target.protocol)) {
    return new Response(JSON.stringify({ error: 'invalid url' }), { status: 400, headers: corsHeaders });
  }

  let res: Response;
  try {
    res = await fetch(target.toString(), {
      headers: { 'User-Agent': 'rss-master/1.0 (+feed reader)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: `fetch failed: ${err}` }), { status: 502, headers: corsHeaders });
  }
  if (!res.ok) {
    return new Response(JSON.stringify({ error: `HTTP ${res.status}` }), { status: 502, headers: corsHeaders });
  }

  const body = await res.text();
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  // Already a feed at this exact URL — cheap root-element sniff, no full parse.
  if (/<(rss|feed)[\s>]/i.test(body.slice(0, 2000))) {
    return new Response(JSON.stringify({ feedUrl: res.url }), { headers: jsonHeaders });
  }

  // Otherwise treat it as an HTML page and collect every standard feed
  // autodiscovery tag: <link rel="alternate" type="application/rss+xml" href="..." title="...">
  const linkRe = /<link\b[^>]*>/gi;
  const feedTypeRe = /type=["'](application\/rss\+xml|application\/atom\+xml|application\/json)["']/i;
  const relAlternateRe = /rel=["']alternate["']/i;
  const hrefRe = /href=["']([^"']+)["']/i;
  const titleRe = /title=["']([^"']*)["']/i;

  const seen = new Set<string>();
  const candidates: { url: string; title: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(body)) !== null) {
    const tag = match[0];
    if (!feedTypeRe.test(tag) || !relAlternateRe.test(tag)) continue;
    const hrefMatch = tag.match(hrefRe);
    if (!hrefMatch) continue;
    const resolved = new URL(hrefMatch[1], res.url).toString();
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const titleMatch = tag.match(titleRe);
    candidates.push({ url: resolved, title: titleMatch?.[1] || resolved });
  }

  if (!candidates.length) {
    return new Response(JSON.stringify({ error: 'no feed found at that url' }), { status: 404, headers: corsHeaders });
  }
  return new Response(JSON.stringify({ candidates }), { headers: jsonHeaders });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  // Feed discovery mode — a JSON body of {discover: <url>}. Requires a
  // signed-in user; the frontend calls this from "Add Feed".
  let discoverUrl: string | null = null;
  try {
    const body = await req.json();
    if (body && typeof body.discover === 'string') discoverUrl = body.discover;
  } catch { /* no body / not JSON — normal refresh path */ }

  if (discoverUrl !== null) {
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: corsHeaders });
    }
    return await discoverFeed(discoverUrl);
  }

  let feedsQuery = admin.from('feeds').select('id,url,etag,last_modified,error_count,last_fetched_at').eq('active', true);

  // Service-role calls (cron) refresh everyone; a signed-in user's own JWT
  // scopes the refresh to just their feeds so "Refresh now" stays cheap.
  if (token !== SERVICE_ROLE_KEY) {
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: corsHeaders });
    }
    feedsQuery = feedsQuery.eq('user_id', userData.user.id);
  }

  const { data: feeds, error } = await feedsQuery;
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }

  const now = Date.now();
  const due = (feeds || []).filter((f: FeedRow) =>
    !f.last_fetched_at || now - new Date(f.last_fetched_at).getTime() > MIN_REFETCH_INTERVAL_MS
  );

  const results = await Promise.allSettled(due.map(fetchOneFeed));

  // Re-cap only the feeds we actually touched this run, instead of scanning
  // the whole table — the nightly cron job still does a full sweep as a backstop.
  const touchedFeedIds = due.map((f: FeedRow) => f.id);
  await Promise.all(touchedFeedIds.map((feedId) => trimFeedToCap(feedId)));

  return new Response(JSON.stringify({
    processed: due.length,
    results: results.map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, reason: String(r.reason) })),
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});

async function trimFeedToCap(feedId: string) {
  const { data } = await admin
    .from('articles')
    .select('id')
    .eq('feed_id', feedId)
    .order('published_at', { ascending: false })
    .range(MAX_ARTICLES_PER_FEED, MAX_ARTICLES_PER_FEED + 500);
  if (data && data.length) {
    await admin.from('articles').delete().in('id', data.map((r) => r.id));
  }
}
