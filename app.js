// The public key relies on the access rules in supabase/schema.sql.
const SUPABASE_URL = 'https://hazclygzhggznitjzeox.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhhemNseWd6aGdnem5pdGp6ZW94Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyODc0NzksImV4cCI6MjEwMDg2MzQ3OX0.SwhbxtBPUEaoHxTzsis-g2DDJiWGRl5ejRpD9xjn_FM';

const sb = (window.supabase && SUPABASE_URL.startsWith('http') && !SUPABASE_URL.includes('YOUR-PROJECT'))
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const ALL_ARTICLES_LIMIT = 400;
const PER_FEED_ARTICLES_LIMIT = 200; // matches MAX_ARTICLES_PER_FEED server-side
const LOAD_MORE_PAGE_SIZE = 100;
const READ_MARKERS_PAGE_SIZE = 500;
const REFRESH_MIN_INTERVAL_MS = 60 * 1000;

let session = null;
let feeds = [];
let articles = [];
// Stable feed/GUID keys preserve read status when article rows are replaced.
let readMarkers = new Set();
let readIds = new Set();
// Pending writes must survive refreshes that return older server data.
let pendingAddReadKeys = new Set();
let pendingRemoveReadKeys = new Set();
let readStateVersion = 0;
let readLoadVersion = 0;
let activeFilter = 'all'; // 'all' or a feed id
let editingDeleteFeedId = null;
let lastRefreshAt = 0;
let expandedArticleId = null;

let allArticlesOffset = 0;
let allArticlesHasMore = true;
let feedArticlesOffset = {};
let feedArticlesHasMore = {};
let loadingMoreArticles = false;

function readKey(a) { return a.feed_id + ' ' + a.guid; }

function recomputeReadIds() {
  readIds = new Set(articles.filter(a => readMarkers.has(readKey(a))).map(a => a.id));
}

function loadCache() {
  try {
    const f = localStorage.getItem('rss_feeds_cache');
    const a = localStorage.getItem('rss_articles_cache');
    const r = localStorage.getItem('rss_read_markers_cache');
    if (f) feeds = JSON.parse(f);
    if (a) articles = JSON.parse(a);
    if (r) readMarkers = new Set(JSON.parse(r));
  } catch (e) {}
  recomputeReadIds();
}

function saveCache() {
  localStorage.setItem('rss_feeds_cache', JSON.stringify(feeds));
  localStorage.setItem('rss_articles_cache', JSON.stringify(articles));
  localStorage.setItem('rss_read_markers_cache', JSON.stringify([...readMarkers]));
}

function switchTab(name, el) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active');
    t.removeAttribute('aria-current');
  });
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  el.setAttribute('aria-current', 'page');
  document.getElementById('section-' + name).classList.add('active');
  if (name === 'feeds') renderManageFeeds();
  if (name === 'articles') renderArticles();
}

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

function renderFeedSidebar() {
  const listEl = document.getElementById('feed-sidebar-list');
  const labelEl = document.getElementById('current-feed-label');
  if (labelEl) labelEl.textContent = activeFilter === 'all' ? 'All feeds' : feedTitle(activeFilter);
  if (!listEl) return;
  const searchInput = document.getElementById('feed-sidebar-search');
  const query = searchInput.value.trim().toLowerCase();
  document.getElementById('feed-search-clear').hidden = !searchInput.value;

  if (!feeds.length) {
    listEl.innerHTML = `<div class="empty-state"><p>No feeds yet</p></div>`;
    return;
  }

  const unreadCountFor = feedId => articles.filter(a => (feedId === 'all' || a.feed_id === feedId) && !readIds.has(a.id)).length;
  const sorted = [...feeds].sort((a, b) => a.position - b.position)
    .filter(f => !query || feedTitle(f.id).toLowerCase().includes(query));

  const allUnread = unreadCountFor('all');
  let html = `<button class="feed-sidebar-item ${activeFilter === 'all' ? 'active' : ''} ${allUnread ? 'has-unread' : ''}" aria-pressed="${activeFilter === 'all'}" onclick="setFilter('all')">
    <span class="feed-color-dot" aria-hidden="true"></span>
    <span class="fs-name">All feeds</span>
    <span class="fs-count">${allUnread}</span>
  </button>`;

  html += sorted.map(f => {
    const count = unreadCountFor(f.id);
    const isActive = activeFilter === f.id;
    return `
    <button class="feed-sidebar-item ${isActive ? 'active' : ''} ${count ? 'has-unread' : ''}" aria-pressed="${isActive}" onclick="setFilter('${f.id}')">
      <span class="feed-color-dot" aria-hidden="true"></span>
      <span class="fs-name">${escHtml(feedTitle(f.id))}</span>
      <span class="fs-count">${count}</span>
    </button>`;
  }).join('');

  listEl.innerHTML = html + (query && !sorted.length ? '<div class="empty-state"><p>No matching feeds</p></div>' : '');
}

function clearFeedSearch() {
  const input = document.getElementById('feed-sidebar-search');
  input.value = '';
  renderFeedSidebar();
  input.focus();
}

function openFeedSidebar() {
  document.getElementById('feed-sidebar-backdrop').classList.add('open');
  document.getElementById('feed-switcher-btn').setAttribute('aria-expanded', 'true');
  document.getElementById('feed-sidebar-search').focus();
  // Keep the anchored popup from scrolling over the header.
  document.body.style.overflow = 'hidden';
}

function closeFeedSidebar() {
  const backdrop = document.getElementById('feed-sidebar-backdrop');
  if (!backdrop.classList.contains('open')) return;
  backdrop.classList.remove('open');
  document.getElementById('feed-switcher-btn').setAttribute('aria-expanded', 'false');
  document.getElementById('feed-switcher-btn').focus();
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
    list.innerHTML = `<div class="empty-state"><p>Sign in to get started</p><small>Read your feeds on any device.</small></div>`;
    return;
  }
  if (!feeds.length) {
    list.innerHTML = `<div class="empty-state"><p>No feeds yet</p><small>Add your first feed in Feeds.</small></div>`;
    return;
  }
  if (!visible.length) {
    list.innerHTML = `<div class="empty-state"><p>No articles yet</p><small>Refresh or check back later.</small></div>`;
    return;
  }

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
  const meta = `
    <span class="article-meta">
      <span class="article-feed-badge">${escHtml(feedTitle(a.feed_id))}</span>
      <span>${timeAgo(a.published_at)}</span>
      <span>${isRead ? 'Read' : 'Unread'}</span>
    </span>`;

  const isExpanded = expandedArticleId === a.id;

  const title = `<span class="article-title">${escHtml(a.title)}</span>`;

  const markUnreadBtn = isRead
    ? `<button class="btn btn-sm btn-ghost" onclick="markUnread('${a.id}')">Mark unread</button>`
    : '';

  const expandedExtra = isExpanded ? `
    <div class="article-content">${formatContentHtml(a.summary || 'No summary available.')}</div>
    <div class="article-expanded-actions">
      <a class="btn btn-sm" href="${escAttr(a.link)}" target="_blank" rel="noopener noreferrer" onclick="if (!readIds.has('${a.id}')) markRead('${a.id}')">Open original ↗</a>
      ${markUnreadBtn}
      <button class="btn btn-sm btn-ghost" onclick="toggleExpand('${a.id}')">Collapse</button>
    </div>` : '';

  return `
    <article class="article-item ${isRead ? 'read' : 'unread'} ${isExpanded ? 'expanded' : ''}">
      <button class="article-toggle" id="article-toggle-${a.id}" aria-expanded="${isExpanded}" onclick="toggleExpand('${a.id}')">
        <span class="article-unread-dot" aria-hidden="true"></span>
        <span class="article-body">${title}${meta}</span>
      </button>
      ${expandedExtra}
    </article>`;
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
  document.getElementById('article-toggle-' + articleId)?.focus({ preventScroll: true });
}

async function markRead(articleId) {
  const a = articles.find(x => x.id === articleId);
  if (!a) return;
  readStateVersion++;
  const key = readKey(a);
  readMarkers.add(key);
  pendingAddReadKeys.add(key);
  pendingRemoveReadKeys.delete(key);
  recomputeReadIds();
  renderArticles();
  renderFeedSidebar();
  saveCache();
  if (!sb || !session) { pendingAddReadKeys.delete(key); return; }
  const { error } = await sb.from('article_reads')
    .upsert({ user_id: session.user.id, feed_id: a.feed_id, guid: a.guid, link: a.link }, { onConflict: 'user_id,feed_id,guid', ignoreDuplicates: true });
  readStateVersion++;
  pendingAddReadKeys.delete(key);
  if (error) console.error('markRead failed', error);
}

async function markUnread(articleId) {
  const a = articles.find(x => x.id === articleId);
  if (!a) return;
  readStateVersion++;
  const key = readKey(a);
  readMarkers.delete(key);
  pendingRemoveReadKeys.add(key);
  pendingAddReadKeys.delete(key);
  recomputeReadIds();
  // Leaving it open would mark it read again on the next collapse.
  if (expandedArticleId === articleId) expandedArticleId = null;
  renderArticles();
  renderFeedSidebar();
  saveCache();
  if (!sb || !session) { pendingRemoveReadKeys.delete(key); return; }
  const { error } = await sb.from('article_reads').delete().eq('user_id', session.user.id).eq('feed_id', a.feed_id).eq('guid', a.guid);
  readStateVersion++;
  pendingRemoveReadKeys.delete(key);
  if (error) console.error('markUnread failed', error);
}

async function markAllRead() {
  const newlyRead = getVisibleArticles().filter(a => !readIds.has(a.id));
  if (!newlyRead.length) return;
  readStateVersion++;
  newlyRead.forEach(a => {
    const key = readKey(a);
    readMarkers.add(key);
    pendingAddReadKeys.add(key);
    pendingRemoveReadKeys.delete(key);
  });
  recomputeReadIds();
  renderArticles();
  renderFeedSidebar();
  saveCache();
  showToast('Marked all read');
  if (!sb || !session) { newlyRead.forEach(a => pendingAddReadKeys.delete(readKey(a))); return; }
  const rows = newlyRead.map(a => ({ user_id: session.user.id, feed_id: a.feed_id, guid: a.guid, link: a.link }));
  const { error } = await sb.from('article_reads').upsert(rows, { onConflict: 'user_id,feed_id,guid', ignoreDuplicates: true });
  readStateVersion++;
  newlyRead.forEach(a => pendingAddReadKeys.delete(readKey(a)));
  if (error) console.error('markAllRead failed', error);
}

function renderManageFeeds() {
  const list = document.getElementById('manage-feeds-list');
  if (!session) {
    list.innerHTML = `<div class="empty-state"><p>Sign in to manage feeds</p></div>`;
    return;
  }
  if (!feeds.length) {
    list.innerHTML = `<div class="empty-state"><p>No feeds yet</p><small>Add a feed or website URL above.</small></div>`;
    return;
  }

  const sorted = [...feeds].sort((a, b) => a.position - b.position);

  list.innerHTML = sorted.map((f, i) => {
    const hasError = f.error_count > 0;
    let statusText = f.last_fetched_at ? 'Last checked ' + timeAgo(f.last_fetched_at) : 'Not checked yet';
    if (!f.active) statusText = 'Paused after repeated errors';
    else if (hasError) statusText += ` · ${f.error_count} failed attempt${f.error_count === 1 ? '' : 's'}`;

    const nameHtml = renamingFeedId === f.id
      ? `<div class="rename-row">
          <input type="text" id="rename-input" aria-label="Feed name" value="${escAttr(feedTitle(f.id))}"
            onkeydown="if(event.key==='Enter')saveRenameFeed('${f.id}'); if(event.key==='Escape')cancelRenameFeed();">
          <button class="btn btn-sm btn-accent" onclick="saveRenameFeed('${f.id}')">Save</button>
          <button class="btn btn-sm btn-ghost" onclick="cancelRenameFeed()">Cancel</button>
        </div>`
      : `<div class="name">${escHtml(feedTitle(f.id))}</div>`;

    return `
      <div class="manage-feed-item">
        <div class="manage-feed-reorder">
          <button ${i === 0 ? 'disabled' : ''} onclick="moveFeed('${f.id}', -1)" aria-label="Move up">▲</button>
          <button ${i === sorted.length - 1 ? 'disabled' : ''} onclick="moveFeed('${f.id}', 1)" aria-label="Move down">▼</button>
        </div>
        <div class="manage-feed-info">
          ${nameHtml}
          <div class="url">${escHtml(f.url)}</div>
          <div class="status ${!f.active || hasError ? 'error-text' : ''}">${escHtml(statusText)}</div>
        </div>
        <div class="manage-feed-actions">
          <button class="btn btn-sm" onclick="startRenameFeed('${f.id}')">Rename</button>
          <button class="btn btn-sm btn-danger" onclick="deleteFeed('${f.id}')">Remove</button>
        </div>
      </div>`;
  }).join('');

  if (renamingFeedId) {
    const input = document.getElementById('rename-input');
    if (input) { input.focus(); input.select(); }
  }
}

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

  // Skip existing feeds and return only newly added ones.
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
    // A direct feed URL may still work when discovery fails.
    await insertFeed(url);
  } finally {
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'Add feed'; }
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

let pendingFeedCandidates = [];

function openFeedPicker(candidates) {
  pendingFeedCandidates = candidates;
  document.getElementById('feed-picker-list').innerHTML = candidates.map((c, i) => `
    <button class="feed-picker-option" onclick="choosePendingFeed(${i})">
      <div class="fp-title">${escHtml(c.title)}</div>
      <div class="fp-url">${escHtml(c.url)}</div>
    </button>`).join('');
  openModal('feed-picker-backdrop');
}

function closeFeedPicker(e) {
  if (!e || e.target.id === 'feed-picker-backdrop')
    closeModal('feed-picker-backdrop');
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
  openModal('confirm-modal-backdrop');
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
    closeModal('confirm-modal-backdrop');
}

async function refreshNow(opts) {
  const silent = opts && opts.silent;
  if (!sb || !session) { if (!silent) { showToast('Sign in first'); openAuthModal(); } return; }
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
    if (!silent) showToast('Please wait a minute before refreshing again');
    return;
  }
  lastRefreshAt = now;

  const btn = document.getElementById('refresh-btn');
  if (btn) { btn.disabled = true; btn.setAttribute('aria-label', 'Refreshing'); btn.setAttribute('aria-busy', 'true'); }

  try {
    const { error } = await sb.functions.invoke('fetch-feeds');
    if (error) throw error;
    if (!silent) showToast('Refreshed');
  } catch (e) {
    console.error('refreshNow failed', e);
    if (!silent) showToast('Refresh failed. Try again later.');
  } finally {
    if (btn) { btn.disabled = false; btn.setAttribute('aria-label', 'Refresh'); btn.removeAttribute('aria-busy'); }
    // Allow server writes to settle, including read markers moved to new GUIDs.
    setTimeout(() => { loadFeeds(); loadArticles(); loadReads(); }, 2000);
  }
}

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
    .select('id,feed_id,guid,link,title,summary,published_at')
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
    .select('id,feed_id,guid,link,title,summary,published_at')
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
        .select('id,feed_id,guid,link,title,summary,published_at')
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
        .select('id,feed_id,guid,link,title,summary,published_at')
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
  recomputeReadIds();
}

async function loadReads() {
  if (!sb || !session) return;
  const userId = session.user.id;
  const stateVersion = readStateVersion;
  const loadVersion = ++readLoadVersion;
  const serverKeys = new Set();
  let offset = 0;

  while (true) {
    const { data, error } = await sb.from('article_reads')
      .select('feed_id,guid')
      .eq('user_id', userId)
      .order('feed_id', { ascending: true })
      .order('guid', { ascending: true })
      .range(offset, offset + READ_MARKERS_PAGE_SIZE - 1);
    if (error) { console.error('loadReads failed', error); return; }
    if (session?.user.id !== userId || stateVersion !== readStateVersion || loadVersion !== readLoadVersion) return;
    if (!data?.length) break;
    data.forEach(r => serverKeys.add(r.feed_id + ' ' + r.guid));
    offset += data.length;
  }

  // Accept other devices' changes while preserving unfinished local writes.
  for (const key of pendingAddReadKeys) {
    if (readMarkers.has(key)) serverKeys.add(key);
  }
  for (const key of pendingRemoveReadKeys) {
    serverKeys.delete(key);
  }
  readMarkers = serverKeys;
  recomputeReadIds();
  saveCache();
  renderArticles();
  renderFeedSidebar();
}

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
  openModal('auth-modal-backdrop');
}

function closeAuthModal(e) {
  if (!e || e.target.id === 'auth-modal-backdrop')
    closeModal('auth-modal-backdrop');
}

function onAuthEmailInput() {
  document.getElementById('auth-error').textContent = '';
}

function updateAuthModalState() {
  const connected = isSignedIn();
  document.getElementById('auth-signed-out').style.display = connected ? 'none' : 'block';
  document.getElementById('auth-signed-in').style.display = connected ? 'block' : 'none';
  const saveBtn = document.getElementById('auth-save-btn');
  saveBtn.textContent = connected ? 'Sign out' : 'Send sign-in link';
  saveBtn.onclick = connected ? doSignOut : sendMagicLink;
  if (connected) {
    document.getElementById('auth-status-text').textContent = 'Signed in as ' + session.user.email;
  }
}

async function sendMagicLink() {
  const errEl = document.getElementById('auth-error');
  errEl.textContent = '';
  if (!sb) { errEl.textContent = 'Sign-in is unavailable. Please try again later.'; return; }
  const email = document.getElementById('auth-email').value.trim();
  if (!email) { errEl.textContent = 'Enter your email address.'; return; }

  const btn = document.getElementById('auth-save-btn');
  btn.disabled = true;
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
  btn.disabled = false;
  if (error) { errEl.textContent = error.message; return; }
  showToast('Check your email for the sign-in link');
}

async function doSignOut() {
  if (sb) await sb.auth.signOut();
  session = null;
  feeds = [];
  articles = [];
  readMarkers = new Set();
  readIds = new Set();
  pendingAddReadKeys = new Set();
  pendingRemoveReadKeys = new Set();
  readStateVersion++;
  readLoadVersion++;
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
  refreshNow({ silent: true });
}

// Sync other devices' changes without fetching the feeds again.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isSignedIn()) { loadFeeds(); loadArticles(); loadReads(); }
});

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

function openModal(id) {
  closeFeedSidebar();
  const backdrop = document.getElementById(id);
  backdrop.returnFocus = document.activeElement;
  backdrop.classList.add('open');
  document.querySelector('header').inert = true;
  document.querySelector('main').inert = true;
  document.body.style.overflow = 'hidden';
  const target = [...backdrop.querySelectorAll('input, button')].find(el => !el.disabled && el.getClientRects().length);
  (target || backdrop.querySelector('[role="dialog"]')).focus();
}

function closeModal(id) {
  const backdrop = document.getElementById(id);
  if (!backdrop.classList.contains('open')) return;
  backdrop.classList.remove('open');
  const anotherModal = document.querySelector('.open > [role="dialog"]');
  document.querySelector('header').inert = !!anotherModal;
  document.querySelector('main').inert = !!anotherModal;
  document.body.style.overflow = anotherModal ? 'hidden' : '';
  const target = backdrop.returnFocus;
  if (target?.isConnected && !target.disabled) target.focus();
  else (anotherModal || document.querySelector('.tab.active')).focus();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeConfirmModal(); closeFeedPicker(); closeAuthModal(); closeFeedSidebar(); }
  if (e.key !== 'Tab') return;
  const popup = document.querySelector('.open > [role="dialog"], #feed-sidebar-backdrop.open .feed-sidebar-popup');
  if (!popup) return;
  const controls = [...popup.querySelectorAll('button, input, a[href], [tabindex="0"]')]
    .filter(el => !el.disabled && el.getClientRects().length);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first) { e.preventDefault(); return; }
  if (e.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
    e.preventDefault(); first.focus();
  }
});

loadCache();
renderFeedSidebar();
renderArticles();
renderManageFeeds();
initAuth();
