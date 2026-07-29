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
// upserted (never duplicated) keyed on (feed_id, guid), and after each feed's
// items are inserted we trim it back down to MAX_ARTICLES_PER_FEED. The daily
// 30-day retention sweep lives in Postgres (cleanup_old_articles), not here.
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
      const link = e.link || e.id;
      const guid = e.id || e.link;
      const publishedRaw = e.published || e.updated;
      const publishedAt = publishedRaw && !isNaN(Date.parse(publishedRaw))
        ? new Date(publishedRaw).toISOString()
        : new Date().toISOString();
      return {
        feed_id: feed.id,
        guid: String(guid).slice(0, 500),
        link: String(link).slice(0, 2000),
        title: truncate(stripHtml(e.title) || '(untitled)', 300),
        summary: truncate(stripHtml(e.description), MAX_SUMMARY_LENGTH),
        published_at: publishedAt,
      };
    });

  if (rows.length) {
    const { error } = await admin.from('articles').upsert(rows, { onConflict: 'feed_id,guid', ignoreDuplicates: true });
    if (error) {
      return { feedId: feed.id, ok: false, reason: `upsert error: ${error.message}` };
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
