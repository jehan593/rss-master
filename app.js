// ─── SUPABASE SETUP ─────────────────────────────────────────────────────────
// Fill these in from your Supabase project: Project Settings → API.
// The anon key is safe to ship client-side — Row Level Security (see
// supabase/schema.sql) is what actually restricts each user to their own
// feeds/reads. Articles are readable only via a feed you own.
const SUPABASE_URL = 'https://hazclygzhggznitjzeox.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhhemNseWd6aGdnem5pdGp6ZW94Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyODc0NzksImV4cCI6MjEwMDg2MzQ3OX0.SwhbxtBPUEaoHxTzsis-g2DDJiWGRl5ejRpD9xjn_FM';

const sb = (window.supabase && SUPABASE_URL.startsWith('http') && !SUPABASE_URL.includes('YOUR-PROJECT'))
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const ALL_ARTICLES_LIMIT = 400;
const PER_FEED_ARTICLES_LIMIT = 200; // matches MAX_ARTICLES_PER_FEED server-side
const LOAD_MORE_PAGE_SIZE = 100;
const REFRESH_MIN_INTERVAL_MS = 60 * 1000; // client-side debounce for the Refresh button

// ─── STATE ──────────────────────────────────────────────────────────────────
let session = null;
let feeds = [];          // [{id, url, title, site_url, last_fetched_at, error_count, active}]
let articles = [];       // [{id, feed_id, title, link, summary, published_at}]
let readIds = new Set(); // article ids marked read
let activeFilter = 'all'; // 'all' or a feed id
let editingDeleteFeedId = null;
let lastRefreshAt = 0;
let expandedArticleId = null; // at most one article expanded inline at a time

// ─── PAGINATION ("Load more") ────────────────────────────────────────────────
let allArticlesOffset = 0;
let allArticlesHasMore = true;
let feedArticlesOffset = {}; // feedId -> next range() offset
let feedArticlesHasMore = {}; // feedId -> whether another page might exist
let loadingMoreArticles = false;

// ─── LOCAL CACHE (offline viewing only — writes always go through Supabase) ──
function loadCache() {
  try {
    const f = localStorage.getItem('rss_feeds_cache');
    const a = localStorage.getItem('rss_articles_cache');
    const r = localStorage.getItem('rss_reads_cache');
    if (f) feeds = JSON.parse(f);
    if (a) articles = JSON.parse(a);
    if (r) readIds = new Set(JSON.parse(r));
  } catch (e) {}
}

function saveCache() {
  localStorage.setItem('rss_feeds_cache', JSON.stringify(feeds));
  localStorage.setItem('rss_articles_cache', JSON.stringify(articles));
  localStorage.setItem('rss_reads_cache', JSON.stringify([...readIds]));
}

// ─── TABS ───────────────────────────────────────────────────────────────────
function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('section-' + name).classList.add('active');
  if (name === 'feeds') renderManageFeeds();
  if (name === 'articles') renderArticles();
}

// ─── DATE HELPERS ───────────────────────────────────────────────────────────
function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── ARTICLES ───────────────────────────────────────────────────────────────
// Deterministic per-feed color (no server storage, no dependency) — same
// feed always hashes to the same hue, so it's a stable visual identity
// across the sidebar, article badges, and unread dots. A continuous hash %
// 360 let unrelated feeds land a few degrees apart and read as near-duplicates
// (two different pinks, two different purples); picking from a small fixed
// set of hues spaced 30° apart guarantees every pair is either the same
// color or clearly distinct — never "almost the same".
const FEED_HUES = [195, 225, 255, 285, 315, 345, 15, 45, 75, 105, 135, 165];

function feedHsl(feedId) {
  let hash = 0;
  for (let i = 0; i < feedId.length; i++) hash = (hash * 31 + feedId.charCodeAt(i)) >>> 0;
  const idx = hash % FEED_HUES.length;
  const h = FEED_HUES[idx];
  const alt = idx % 2 === 1;
  return { h, s: alt ? 62 : 55, l: alt ? 70 : 64 };
}

function feedColor(feedId) {
  const { h, s, l } = feedHsl(feedId);
  return `hsl(${h}, ${s}%, ${l}%)`;
}

// Inline style that tints a whole pill (background/border/text) with a
// feed's own hue instead of a flat neutral fill, so the pill matches the
// color dot next to it rather than just having a colored dot inside a gray box.
function feedTintStyle(feedId, bgAlpha, borderAlpha, textBoost) {
  const { h, s, l } = feedHsl(feedId);
  return `background:hsla(${h}, ${s}%, ${l}%, ${bgAlpha}); border-color:hsla(${h}, ${s}%, ${l}%, ${borderAlpha}); color:hsl(${h}, ${Math.min(s + textBoost, 80)}%, ${Math.min(l + textBoost + 2, 85)}%);`;
}

// Selected feed row in the picker popup.
function feedActiveStyle(feedId) {
  return feedTintStyle(feedId, 0.16, 0.5, 10);
}

// Per-article feed badge, shown on every article card.
function feedBadgeStyle(feedId) {
  return feedTintStyle(feedId, 0.14, 0.4, 8);
}

function renderFeedSidebar() {
  const listEl = document.getElementById('feed-sidebar-list');
  const labelEl = document.getElementById('current-feed-label');
  if (labelEl) labelEl.textContent = activeFilter === 'all' ? 'All' : feedTitle(activeFilter);
  if (!listEl) return;

  if (!feeds.length) {
    listEl.innerHTML = `<div class="empty-state" style="padding:30px 10px;"><p style="font-size:13px;">No feeds yet</p></div>`;
    return;
  }

  const unreadCountFor = feedId => articles.filter(a => (feedId === 'all' || a.feed_id === feedId) && !readIds.has(a.id)).length;
  const query = (document.getElementById('feed-sidebar-search')?.value || '').trim().toLowerCase();
  const sorted = [...feeds].sort((a, b) => a.position - b.position)
    .filter(f => !query || feedTitle(f.id).toLowerCase().includes(query));

  const allUnread = unreadCountFor('all');
  let html = `<button class="feed-sidebar-item ${activeFilter === 'all' ? 'active' : ''} ${allUnread ? 'has-unread' : ''}" onclick="setFilter('all')">
    <span class="feed-color-dot" style="background:var(--accent2)"></span>
    <span class="fs-name">All</span>
    <span class="fs-count">${allUnread}</span>
  </button>`;

  html += sorted.map(f => {
    const count = unreadCountFor(f.id);
    const isActive = activeFilter === f.id;
    return `
    <button class="feed-sidebar-item ${isActive ? 'active feed-active-tinted' : ''} ${count ? 'has-unread' : ''}" ${isActive ? `style="${feedActiveStyle(f.id)}"` : ''} onclick="setFilter('${f.id}')">
      <span class="feed-color-dot" style="background:${feedColor(f.id)}"></span>
      <span class="fs-name">${escHtml(feedTitle(f.id))}</span>
      <span class="fs-count">${count}</span>
    </button>`;
  }).join('');

  listEl.innerHTML = html;
}

function openFeedSidebar() {
  document.getElementById('feed-sidebar-backdrop').classList.add('open');
  // The popup is anchored under the switcher button via absolute positioning,
  // not fixed to the viewport — if the page scrolls while it's open it drags
  // along and rides up over the sticky header. Lock scroll instead of adding
  // scroll-tracking JS just to reposition it.
  document.body.style.overflow = 'hidden';
}

function closeFeedSidebar() {
  document.getElementById('feed-sidebar-backdrop').classList.remove('open');
  document.body.style.overflow = '';
}

function setFilter(filter) {
  activeFilter = filter;
  renderFeedSidebar();
  renderArticles();
  closeFeedSidebar();
  if (filter !== 'all' && !articles.some(a => a.feed_id === filter && a._loadedForFeed)) {
    loadArticlesForFeed(filter);
  }
}

function feedTitle(feedId) {
  const f = feeds.find(x => x.id === feedId);
  return f ? (f.display_name || f.title || f.url) : 'Unknown feed';
}

function getVisibleArticles() {
  return articles
    .filter(a => activeFilter === 'all' || a.feed_id === activeFilter)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
}

function renderArticles() {
  const list = document.getElementById('articles-list');
  const visible = getVisibleArticles();

  const unread = visible.filter(a => !readIds.has(a.id)).length;
  document.getElementById('unread-count').textContent =
    visible.length ? `${unread} unread of ${visible.length}` : '';

  if (!session) {
    list.innerHTML = `<div class="empty-state"><div class="emoji">📰</div><p>Sign in to get started</p><small>Your feeds and articles sync through your account</small></div>`;
    return;
  }
  if (!feeds.length) {
    list.innerHTML = `<div class="empty-state"><div class="emoji">📰</div><p>No feeds yet</p><small>Go to Feeds to add your first RSS feed</small></div>`;
    return;
  }
  if (!visible.length) {
    list.innerHTML = `<div class="empty-state"><div class="emoji">✓</div><p>No articles yet</p><small>Hit Refresh, or check back after the next scheduled fetch</small></div>`;
    return;
  }

  // Article link/title/summary/fetched-content come from external, untrusted
  // sources — always run through escHtml/escAttr, never interpolated raw.
  // a.id is our own DB-generated UUID, so it's safe to inline directly.
  const hasMore = activeFilter === 'all' ? allArticlesHasMore : !!feedArticlesHasMore[activeFilter];
  const loadMoreHtml = hasMore ? `
    <div class="load-more-wrap">
      <button class="btn btn-sm btn-ghost" onclick="loadMoreArticles()" ${loadingMoreArticles ? 'disabled' : ''}>
        ${loadingMoreArticles ? 'Loading…' : 'Load more'}
      </button>
    </div>` : '';

  list.innerHTML = visible.map(a => renderArticleCard(a)).join('') + loadMoreHtml;
}

function renderArticleCard(a) {
  const isRead = readIds.has(a.id);
  const color = feedColor(a.feed_id);
  const meta = `
    <div class="article-meta">
      <span class="article-feed-badge" style="${feedBadgeStyle(a.feed_id)}"><span class="feed-color-dot" style="background:${color}"></span>${escHtml(feedTitle(a.feed_id))}</span>
      <span>${timeAgo(a.published_at)}</span>
    </div>`;

  const isExpanded = expandedArticleId === a.id;

  // Same .article-title div in both states (never a link) so the title never
  // shifts position when toggling — only content appended below moves.
  // Opening the original article is only ever done via the explicit
  // "Open original" button in the expanded actions row.
  const title = `<div class="article-title">${escHtml(a.title)}</div>`;

  const markUnreadBtn = isRead
    ? `<button class="btn btn-sm btn-ghost" onclick="event.stopPropagation(); markUnread('${a.id}')">Mark unread</button>`
    : '';

  const expandedExtra = isExpanded ? `
    <div class="article-content">${formatContentHtml(a.summary || 'No summary available for this article.')}</div>
    <div class="article-expanded-actions">
      <a class="btn btn-sm" href="${escAttr(a.link)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation(); if (!readIds.has('${a.id}')) markRead('${a.id}')">Open original ↗</a>
      ${markUnreadBtn}
      <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation(); toggleExpand('${a.id}')">▲ Collapse</button>
    </div>` : '';

  return `
    <div class="article-item ${isRead ? 'read' : 'unread'} ${isExpanded ? 'expanded' : ''}" onclick="toggleExpand('${a.id}')">
      <div class="article-unread-dot" style="background:${color}"></div>
      <div class="article-body">
        ${title}
        ${meta}
        ${expandedExtra}
      </div>
    </div>`;
}

function formatContentHtml(text) {
  return text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => `<p>${escHtml(p)}</p>`).join('');
}

function toggleExpand(articleId) {
  const previouslyExpanded = expandedArticleId;
  if (expandedArticleId === articleId) {
    expandedArticleId = null;
  } else {
    expandedArticleId = articleId;
  }
  if (previouslyExpanded && !readIds.has(previouslyExpanded)) markRead(previouslyExpanded);
  renderArticles();
}

async function markRead(articleId) {
  readIds.add(articleId);
  renderArticles();
  renderFeedSidebar();
  saveCache();
  if (!sb || !session) return;
  const { error } = await sb.from('article_reads')
    .upsert({ user_id: session.user.id, article_id: articleId }, { onConflict: 'user_id,article_id', ignoreDuplicates: true });
  if (error) console.error('markRead failed', error);
}

async function markUnread(articleId) {
  readIds.delete(articleId);
  // Collapse it too: toggleExpand() marks the article being closed as read
  // (see git history), so leaving it expanded would just flip it straight
  // back to read the next time it's collapsed.
  if (expandedArticleId === articleId) expandedArticleId = null;
  renderArticles();
  renderFeedSidebar();
  saveCache();
  if (!sb || !session) return;
  const { error } = await sb.from('article_reads').delete().eq('article_id', articleId);
  if (error) console.error('markUnread failed', error);
}

async function markAllRead() {
  const newlyRead = getVisibleArticles().filter(a => !readIds.has(a.id));
  if (!newlyRead.length) return;
  newlyRead.forEach(a => readIds.add(a.id));
  renderArticles();
  renderFeedSidebar();
  saveCache();
  showToast('Marked all read');
  if (!sb || !session) return;
  const rows = newlyRead.map(a => ({ user_id: session.user.id, article_id: a.id }));
  const { error } = await sb.from('article_reads').upsert(rows, { onConflict: 'user_id,article_id', ignoreDuplicates: true });
  if (error) console.error('markAllRead failed', error);
}

// ─── FEEDS (MANAGE) ─────────────────────────────────────────────────────────
function renderManageFeeds() {
  const list = document.getElementById('manage-feeds-list');
  if (!session) {
    list.innerHTML = `<div class="empty-state"><div class="emoji">🔒</div><p>Sign in to manage feeds</p></div>`;
    return;
  }
  if (!feeds.length) {
    list.innerHTML = `<div class="empty-state"><div class="emoji">📋</div><p>No feeds yet</p><small>Add a feed URL above to get started</small></div>`;
    return;
  }

  const sorted = [...feeds].sort((a, b) => a.position - b.position);

  list.innerHTML = sorted.map((f, i) => {
    const hasError = f.error_count > 0;
    const stateClass = !f.active ? 'feed-inactive' : hasError ? 'feed-error' : '';
    let statusText = f.last_fetched_at ? 'Last checked ' + timeAgo(f.last_fetched_at) : 'Not fetched yet';
    if (!f.active) statusText = 'Disabled after repeated fetch failures';
    else if (hasError) statusText += ` · ${f.error_count} failed attempt${f.error_count === 1 ? '' : 's'}`;

    const nameHtml = renamingFeedId === f.id
      ? `<div class="rename-row">
          <input type="text" id="rename-input" value="${escAttr(feedTitle(f.id))}"
            onkeydown="if(event.key==='Enter')saveRenameFeed('${f.id}'); if(event.key==='Escape')cancelRenameFeed();">
          <button class="btn btn-sm btn-accent" onclick="saveRenameFeed('${f.id}')">Save</button>
          <button class="btn btn-sm" onclick="cancelRenameFeed()">Cancel</button>
        </div>`
      : `<div class="name">${escHtml(feedTitle(f.id))}</div>`;

    return `
      <div class="manage-feed-item ${stateClass}">
        <div class="manage-feed-reorder">
          <button ${i === 0 ? 'disabled' : ''} onclick="moveFeed('${f.id}', -1)" aria-label="Move up">▲</button>
          <button ${i === sorted.length - 1 ? 'disabled' : ''} onclick="moveFeed('${f.id}', 1)" aria-label="Move down">▼</button>
        </div>
        <span class="feed-color-dot" style="background:${feedColor(f.id)}"></span>
        <div class="manage-feed-info">
          ${nameHtml}
          <div class="url">${escHtml(f.url)}</div>
          <div class="status ${!f.active || hasError ? 'error-text' : ''}">${escHtml(statusText)}</div>
        </div>
        <div class="manage-feed-actions">
          <button class="btn btn-sm" onclick="startRenameFeed('${f.id}')">✎ Rename</button>
          <button class="btn btn-sm btn-danger" onclick="deleteFeed('${f.id}')">Remove</button>
        </div>
      </div>`;
  }).join('');

  if (renamingFeedId) {
    const input = document.getElementById('rename-input');
    if (input) { input.focus(); input.select(); }
  }
}

// ─── FEED RENAME (client-side display_name — never touched by fetch-feeds) ──
let renamingFeedId = null;

function startRenameFeed(feedId) {
  renamingFeedId = feedId;
  renderManageFeeds();
}

function cancelRenameFeed() {
  renamingFeedId = null;
  renderManageFeeds();
}

async function saveRenameFeed(feedId) {
  const input = document.getElementById('rename-input');
  const value = input ? input.value.trim() : '';
  const feed = feeds.find(f => f.id === feedId);
  if (!feed) { renamingFeedId = null; return; }

  // Empty input clears the override, reverting to the feed's own title.
  const displayName = value || null;
  const { error } = await sb.from('feeds').update({ display_name: displayName }).eq('id', feedId);
  if (error) { showToast('Failed to rename feed'); return; }

  feed.display_name = displayName;
  renamingFeedId = null;
  saveCache();
  renderManageFeeds();
  renderFeedSidebar();
  renderArticles();
}

async function moveFeed(feedId, direction) {
  if (!sb || !session) return;
  const sorted = [...feeds].sort((a, b) => a.position - b.position);
  const idx = sorted.findIndex(f => f.id === feedId);
  const swapIdx = idx + direction;
  if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return;

  const a = sorted[idx], b = sorted[swapIdx];
  const [posA, posB] = [a.position, b.position];

  const [{ error: e1 }, { error: e2 }] = await Promise.all([
    sb.from('feeds').update({ position: posB }).eq('id', a.id),
    sb.from('feeds').update({ position: posA }).eq('id', b.id),
  ]);
  if (e1 || e2) { showToast('Failed to reorder'); return; }

  a.position = posB;
  b.position = posA;
  saveCache();
  renderManageFeeds();
  renderFeedSidebar();
}

// ─── OPML IMPORT / EXPORT ────────────────────────────────────────────────────
function xmlEsc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function exportOpml() {
  if (!feeds.length) { showToast('No feeds to export'); return; }
  const sorted = [...feeds].sort((a, b) => a.position - b.position);
  const items = sorted.map(f => {
    const title = xmlEsc(feedTitle(f.id));
    const htmlUrl = f.site_url ? ` htmlUrl="${xmlEsc(f.site_url)}"` : '';
    return `    <outline text="${title}" title="${title}" type="rss" xmlUrl="${xmlEsc(f.url)}"${htmlUrl}/>`;
  }).join('\n');
  const opml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>RSS Reader Feeds</title></head>\n  <body>\n${items}\n  </body>\n</opml>`;

  const blob = new Blob([opml], { type: 'text/x-opml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'feeds.opml';
  a.click();
  URL.revokeObjectURL(url);
}

async function importOpml(event) {
  const file = event.target.files[0];
  event.target.value = ''; // allow re-selecting the same file later
  if (!file) return;
  if (!sb || !session) { showToast('Sign in first'); openAuthModal(); return; }

  const text = await file.text();
  let urls;
  try {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('invalid OPML');
    urls = [...doc.querySelectorAll('outline[xmlUrl]')]
      .map(el => el.getAttribute('xmlUrl').trim())
      .filter(Boolean);
  } catch (e) {
    showToast('Could not read that OPML file');
    return;
  }
  if (!urls.length) { showToast('No feeds found in that file'); return; }

  // ignoreDuplicates turns this into INSERT ... ON CONFLICT DO NOTHING, so
  // .select() only returns rows that were actually newly inserted — feeds
  // already in the list are silently skipped rather than erroring the batch.
  const rows = [...new Set(urls)].map(url => ({ url, user_id: session.user.id }));
  const { data, error } = await sb.from('feeds')
    .upsert(rows, { onConflict: 'user_id,url', ignoreDuplicates: true })
    .select();
  if (error) { console.error('importOpml failed', error); showToast('Import failed'); return; }

  const added = data || [];
  if (added.length) {
    feeds.push(...added);
    saveCache();
    renderManageFeeds();
    renderFeedSidebar();
    refreshNow({ silent: true });
  }
  const skipped = rows.length - added.length;
  showToast(`Imported ${added.length} feed${added.length === 1 ? '' : 's'}${skipped ? ` (${skipped} already added)` : ''}`);
}

async function addFeed() {
  if (!sb || !session) { showToast('Sign in first'); openAuthModal(); return; }
  const url = document.getElementById('new-feed-url').value.trim();
  if (!url) { showToast('Enter a feed or website URL'); return; }
  if (!/^https?:\/\//i.test(url)) { showToast('URL must start with http:// or https://'); return; }

  // Feed discovery: if the URL isn't already a feed (e.g. a site homepage was
  // pasted instead of its /feed.xml), fetch-feeds looks for the page's
  // <link rel="alternate"> feed tags server-side. One match inserts directly;
  // several show a picker. Best-effort — if discovery itself fails to run,
  // just add the URL as typed and let normal per-feed error handling surface
  // any real problem.
  const addBtn = document.getElementById('add-feed-btn');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Finding feed…'; }
  try {
    const { data: discovered, error: discoverErr } = await sb.functions.invoke('fetch-feeds', { body: { discover: url } });
    if (discoverErr) throw discoverErr;

    if (discovered?.feedUrl) {
      await insertFeed(discovered.feedUrl);
    } else if (discovered?.candidates?.length) {
      openFeedPicker(discovered.candidates);
    } else {
      showToast("Couldn't find a feed at that URL");
    }
  } catch (e) {
    console.error('feed discovery failed', e);
    await insertFeed(url);
  } finally {
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = '+ Add Feed'; }
  }
}

async function insertFeed(feedUrl) {
  const { data, error } = await sb.from('feeds')
    .insert({ url: feedUrl, user_id: session.user.id })
    .select()
    .single();

  if (error) {
    showToast(error.code === '23505' ? 'That feed is already added' : 'Failed to add feed');
    return;
  }

  feeds.push(data);
  document.getElementById('new-feed-url').value = '';
  saveCache();
  renderManageFeeds();
  renderFeedSidebar();
  showToast('Feed added — fetching articles…');
  refreshNow({ silent: true });
}

// ─── FEED PICKER (when discovery finds multiple feeds on one page) ─────────
let pendingFeedCandidates = [];

function openFeedPicker(candidates) {
  pendingFeedCandidates = candidates;
  document.getElementById('feed-picker-list').innerHTML = candidates.map((c, i) => `
    <button class="feed-picker-option" onclick="choosePendingFeed(${i})">
      <div class="fp-title">${escHtml(c.title)}</div>
      <div class="fp-url">${escHtml(c.url)}</div>
    </button>`).join('');
  document.getElementById('feed-picker-backdrop').classList.add('open');
}

function closeFeedPicker(e) {
  if (!e || e.target.id === 'feed-picker-backdrop')
    document.getElementById('feed-picker-backdrop').classList.remove('open');
}

async function choosePendingFeed(i) {
  const chosen = pendingFeedCandidates[i];
  closeFeedPicker();
  if (chosen) await insertFeed(chosen.url);
}

function deleteFeed(id) {
  const feed = feeds.find(f => f.id === id);
  if (!feed) return;
  editingDeleteFeedId = id;
  document.getElementById('confirm-feed-name').textContent = feedTitle(feed.id);
  document.getElementById('confirm-modal-backdrop').classList.add('open');
  document.getElementById('confirm-delete-btn').onclick = doDeleteFeed;
}

async function doDeleteFeed() {
  const id = editingDeleteFeedId;
  if (!id || !sb) return;
  const { error } = await sb.from('feeds').delete().eq('id', id);
  if (error) { showToast('Failed to remove feed'); return; }
  feeds = feeds.filter(f => f.id !== id);
  articles = articles.filter(a => a.feed_id !== id);
  delete feedArticlesOffset[id];
  delete feedArticlesHasMore[id];
  if (activeFilter === id) activeFilter = 'all';
  saveCache();
  renderManageFeeds();
  renderFeedSidebar();
  renderArticles();
  closeConfirmModal();
  showToast('Feed removed');
}

function closeConfirmModal(e) {
  if (!e || e.target.id === 'confirm-modal-backdrop')
    document.getElementById('confirm-modal-backdrop').classList.remove('open');
}

// ─── REFRESH (invoke the fetch-feeds edge function on demand) ───────────────
async function refreshNow(opts) {
  const silent = opts && opts.silent;
  if (!sb || !session) { if (!silent) { showToast('Sign in first'); openAuthModal(); } return; }
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
    if (!silent) showToast('Already refreshed recently — try again in a bit');
    return;
  }
  lastRefreshAt = now;

  const btn = document.getElementById('refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ Refreshing…'; }

  try {
    const { error } = await sb.functions.invoke('fetch-feeds');
    if (error) throw error;
    if (!silent) showToast('Refreshed');
  } catch (e) {
    console.error('refreshNow failed', e);
    if (!silent) showToast('Refresh failed — will retry automatically later');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⟳ Refresh'; }
    // The edge function's writes land shortly after it responds — give it a
    // moment, then pull the new rows down.
    setTimeout(() => { loadFeeds(); loadArticles(); }, 2000);
  }
}

// ─── DATA LOADING ───────────────────────────────────────────────────────────
async function loadFeeds() {
  if (!sb || !session) return;
  const { data, error } = await sb.from('feeds').select('*').order('position', { ascending: true });
  if (error) { console.error('loadFeeds failed', error); return; }
  feeds = data || [];
  saveCache();
  renderFeedSidebar();
  renderManageFeeds();
}

async function loadArticles() {
  if (!sb || !session) return;
  const { data, error } = await sb.from('articles')
    .select('id,feed_id,link,title,summary,published_at')
    .order('published_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, ALL_ARTICLES_LIMIT - 1);
  if (error) { console.error('loadArticles failed', error); return; }
  mergeArticles(data || []);
  allArticlesOffset = (data || []).length;
  allArticlesHasMore = (data || []).length === ALL_ARTICLES_LIMIT;
  saveCache();
  renderFeedSidebar();
  renderArticles();
}

async function loadArticlesForFeed(feedId) {
  if (!sb || !session) return;
  const { data, error } = await sb.from('articles')
    .select('id,feed_id,link,title,summary,published_at')
    .eq('feed_id', feedId)
    .order('published_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, PER_FEED_ARTICLES_LIMIT - 1);
  if (error) { console.error('loadArticlesForFeed failed', error); return; }
  mergeArticles((data || []).map(a => ({ ...a, _loadedForFeed: true })));
  feedArticlesOffset[feedId] = (data || []).length;
  feedArticlesHasMore[feedId] = (data || []).length === PER_FEED_ARTICLES_LIMIT;
  saveCache();
  renderArticles();
}

async function loadMoreArticles() {
  if (!sb || !session || loadingMoreArticles) return;
  loadingMoreArticles = true;
  renderArticles();

  try {
    if (activeFilter === 'all') {
      const { data, error } = await sb.from('articles')
        .select('id,feed_id,link,title,summary,published_at')
        .order('published_at', { ascending: false })
        .order('id', { ascending: false })
        .range(allArticlesOffset, allArticlesOffset + LOAD_MORE_PAGE_SIZE - 1);
      if (error) { console.error('loadMoreArticles failed', error); showToast('Failed to load more'); return; }
      mergeArticles(data || []);
      allArticlesOffset += (data || []).length;
      allArticlesHasMore = (data || []).length === LOAD_MORE_PAGE_SIZE;
    } else {
      const feedId = activeFilter;
      const offset = feedArticlesOffset[feedId] || 0;
      const { data, error } = await sb.from('articles')
        .select('id,feed_id,link,title,summary,published_at')
        .eq('feed_id', feedId)
        .order('published_at', { ascending: false })
        .order('id', { ascending: false })
        .range(offset, offset + LOAD_MORE_PAGE_SIZE - 1);
      if (error) { console.error('loadMoreArticles failed', error); showToast('Failed to load more'); return; }
      mergeArticles((data || []).map(a => ({ ...a, _loadedForFeed: true })));
      feedArticlesOffset[feedId] = offset + (data || []).length;
      feedArticlesHasMore[feedId] = (data || []).length === LOAD_MORE_PAGE_SIZE;
    }
    saveCache();
  } finally {
    loadingMoreArticles = false;
    renderArticles();
  }
}

function mergeArticles(rows) {
  const byId = new Map(articles.map(a => [a.id, a]));
  rows.forEach(r => byId.set(r.id, { ...byId.get(r.id), ...r }));
  articles = [...byId.values()];
}

async function loadReads() {
  if (!sb || !session) return;
  const { data, error } = await sb.from('article_reads').select('article_id');
  if (error) { console.error('loadReads failed', error); return; }
  // Merge rather than replace: a plain replace here can race an in-flight
  // markRead write (or a still-propagating write from another tab/device)
  // and stomp an already-persisted local read back to unread. This only
  // ever adds ids present in the server response, never removes one for
  // being absent, so it can't undo a local markUnread() either — the same
  // small race window just applies symmetrically to that action too.
  (data || []).forEach(r => readIds.add(r.article_id));
  saveCache();
  renderArticles();
  renderFeedSidebar();
}

// ─── AUTH ───────────────────────────────────────────────────────────────────
function isSignedIn() { return !!session; }

function updateAccountUI() {
  const connected = isSignedIn();
  [['header-account-dot', 'account-btn-label'], ['settings-account-dot', 'settings-account-label']].forEach(([dotId, labelId]) => {
    const dot = document.getElementById(dotId);
    const label = document.getElementById(labelId);
    if (dot) dot.className = 'sync-status-dot ' + (connected ? 'connected' : 'disconnected');
    if (label) label.textContent = connected ? (session.user.email || 'Signed in') : 'Sign in';
  });
}

function openAuthModal() {
  document.getElementById('auth-error').textContent = '';
  updateAuthModalState();
  document.getElementById('auth-modal-backdrop').classList.add('open');
}

function closeAuthModal(e) {
  if (!e || e.target.id === 'auth-modal-backdrop')
    document.getElementById('auth-modal-backdrop').classList.remove('open');
}

function onAuthEmailInput() {
  document.getElementById('auth-error').textContent = '';
}

function updateAuthModalState() {
  const connected = isSignedIn();
  document.getElementById('auth-signed-out').style.display = connected ? 'none' : 'block';
  document.getElementById('auth-signed-in').style.display = connected ? 'block' : 'none';
  const saveBtn = document.getElementById('auth-save-btn');
  saveBtn.textContent = connected ? 'Sign out' : 'Send magic link';
  saveBtn.onclick = connected ? doSignOut : sendMagicLink;
  if (connected) {
    document.getElementById('auth-status-text').textContent = 'Signed in as ' + session.user.email;
  }
}

async function sendMagicLink() {
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';
  if (!sb) { errEl.textContent = 'Sign-in isn’t configured — missing Supabase project URL/key.'; return; }
  const email = document.getElementById('auth-email').value.trim();
  if (!email) { errEl.textContent = 'Enter your email address.'; return; }

  const btn = document.getElementById('auth-save-btn');
  btn.disabled = true;
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
  btn.disabled = false;
  if (error) { errEl.textContent = error.message; return; }
  showToast('Magic link sent — check your email');
}

async function doSignOut() {
  if (sb) await sb.auth.signOut();
  session = null;
  feeds = [];
  articles = [];
  readIds = new Set();
  allArticlesOffset = 0;
  allArticlesHasMore = true;
  feedArticlesOffset = {};
  feedArticlesHasMore = {};
  saveCache();
  updateAccountUI();
  updateAuthModalState();
  renderFeedSidebar();
  renderArticles();
  renderManageFeeds();
  showToast('Signed out');
}

async function initAuth() {
  updateAccountUI();
  if (!sb) return;
  const { data: { session: s } } = await sb.auth.getSession();
  session = s;
  updateAccountUI();
  if (session) onSignedIn();

  sb.auth.onAuthStateChange((event, s2) => {
    const wasSignedIn = isSignedIn();
    session = s2;
    updateAccountUI();
    if (document.getElementById('auth-modal-backdrop').classList.contains('open')) updateAuthModalState();
    if (session && !wasSignedIn) {
      showToast('Signed in ✓');
      onSignedIn();
    }
  });
}

async function onSignedIn() {
  await loadFeeds();
  await loadArticles();
  await loadReads();
  renderArticles();
  renderManageFeeds();
  renderFeedSidebar();
  // No more server-side cron — pull fresh articles ourselves whenever the app loads.
  refreshNow({ silent: true });
}

// Pick up changes from other tabs/devices when this tab regains focus —
// a plain DB read, not a feed fetch (that only happens on load, manual
// refresh, and feed adding — see onSignedIn/refreshNow/addFeed/importOpml).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isSignedIn()) { loadFeeds(); loadArticles(); loadReads(); }
});

// ─── UTILS ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) { return escHtml(s); }

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

// ─── INIT ────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeConfirmModal(); closeFeedPicker(); closeFeedSidebar(); }
});

loadCache();
renderFeedSidebar();
renderArticles();
renderManageFeeds();
initAuth();
