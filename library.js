let libraryEditing = null;
let libraryBusy = false;
let libraryDrag = null;
let addFeedFolder = null;
const collapsedFolders = new Set();
let folderExpansionUser = null;

function loadFolderExpansionState() {
  const userId = session?.user.id || null;
  if (folderExpansionUser === userId) return;
  folderExpansionUser = userId;
  collapsedFolders.clear();
  if (!userId) return;
  try {
    const saved = JSON.parse(localStorage.getItem('rss_collapsed_folders:' + userId) || '[]');
    if (Array.isArray(saved)) saved.filter(id => typeof id === 'string').forEach(id => collapsedFolders.add(id));
  } catch { /* Keep folder controls usable when browser storage is unavailable. */ }
}
function saveFolderExpansionState() {
  if (!session) return;
  try { localStorage.setItem('rss_collapsed_folders:' + session.user.id, JSON.stringify([...collapsedFolders])); }
  catch { /* Folder controls still work without browser storage. */ }
}
function toggleLibraryFolder(id) {
  loadFolderExpansionState();
  if (collapsedFolders.has(id)) collapsedFolders.delete(id);
  else collapsedFolders.add(id);
  saveFolderExpansionState();
  renderLibrary();
}

function libraryDescendants(id) {
  const found = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    folders.forEach(f => { if (found.has(f.parent_id) && !found.has(f.id)) { found.add(f.id); changed = true; } });
  }
  return found;
}
function libraryFeedIds(id) {
  const descendants = libraryDescendants(id);
  return feeds.filter(f => descendants.has(f.folder_id)).map(f => f.id);
}
function libraryChildren(parent) {
  return [...folders.filter(f => (f.parent_id || null) === parent).map(f => ({ ...f, kind: 'folder' })),
    ...feeds.filter(f => (f.folder_id || null) === parent).map(f => ({ ...f, kind: 'feed' }))]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}
function showLibrarySection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('active', s.id === 'section-' + name));
  closeFeedSidebar();
}
function showFeedForm(parent) {
  if (!session) { openAuthModal(); return; }
  addFeedFolder = parent === undefined ? (activeFilter.startsWith('folder:') ? activeFilter.slice(7) : feeds.find(f => f.id === activeFilter)?.folder_id || null) : parent;
  const select = document.getElementById('new-feed-folder');
  select.innerHTML = '<option value="">No folder</option>' + folders.map(f => `<option value="${f.id}">${escHtml(folderPath(f.id))}</option>`).join('');
  select.value = addFeedFolder || '';
  document.getElementById('new-feed-url').value = '';
  openModal('add-feed-modal-backdrop');
}
async function loadFolders() {
  const userId = session?.user.id;
  const { data, error } = await sb.from('folders').select('*').order('position');
  if (session?.user.id !== userId) return;
  if (error) { console.error('Folders unavailable', error); return; }
  folders = data || [];
  if (activeFilter.startsWith('folder:') && !folders.some(f => 'folder:' + f.id === activeFilter)) activeFilter = 'all';
}
function renderLibrary() {
  loadFolderExpansionState();
  const tree = document.getElementById('library-tree');
  if (!tree) return;
  const query = document.getElementById('library-search').value.trim().toLowerCase();
  const count = ids => articles.filter(a => (!ids || ids.includes(a.feed_id)) && !readIds.has(a.id)).length;
  const label = activeFilter.startsWith('folder:') ? folders.find(f => 'folder:' + f.id === activeFilter)?.name : activeFilter === 'all' ? 'All feeds' : feedTitle(activeFilter);
  document.getElementById('current-feed-label').textContent = label || 'All feeds';
  const matches = item => (item.kind === 'feed' ? feedTitle(item.id) : item.name).toLowerCase().includes(query) ||
    (item.kind === 'folder' && libraryChildren(item.id).some(matches));
  const branch = (parent, depth = 0) => libraryChildren(parent).filter(item => !query || matches(item)).map(item => {
    const folder = item.kind === 'folder';
    const filter = folder ? 'folder:' + item.id : item.id;
    const title = folder ? item.name : feedTitle(item.id);
    const unread = count(folder ? libraryFeedIds(item.id) : [item.id]);
    return `<div class="library-row ${activeFilter === filter ? 'active' : ''}" data-kind="${item.kind}" data-id="${item.id}" draggable="true" style="--depth:${depth}">
      ${folder ? `<button class="folder-toggle" title="${collapsedFolders.has(item.id) ? 'Expand' : 'Collapse'} folder" aria-label="${collapsedFolders.has(item.id) ? 'Expand' : 'Collapse'} ${escAttr(title)}" aria-expanded="${!collapsedFolders.has(item.id)}" onclick="toggleLibraryFolder('${item.id}')">${collapsedFolders.has(item.id) ? '▸' : '▾'}</button>` : '<span class="library-toggle-space" aria-hidden="true"></span>'}
      <button class="library-select" title="${escAttr(title)}" aria-pressed="${activeFilter === filter}" onclick="setFilter('${filter}')"><span class="library-item-icon" aria-hidden="true">${libraryIcon(folder ? 'folder' : 'feed')}</span><span class="fs-name">${escHtml(title)}</span><span class="fs-count">${unread || ''}</span></button>
      <button class="library-drag-handle" aria-label="Drag ${escAttr(title)}" title="Drag to move">⠿</button><button class="library-more" aria-label="Options for ${escAttr(title)}" onclick="openLibraryMenu(event,'${item.kind}','${item.id}')">⋮</button></div>` +
      (folder && (!collapsedFolders.has(item.id) || query) ? `<div class="library-children" data-parent="${item.id}">${branch(item.id, depth + 1)}</div>` : '');
  }).join('');
  tree.innerHTML = `<button class="feed-sidebar-item ${activeFilter === 'all' ? 'active' : ''}" aria-pressed="${activeFilter === 'all'}" onclick="setFilter('all')">All feeds <span class="fs-count">${count(null)}</span></button><div class="library-root-drop" data-root="true">Feeds <span class="root-drop-hint">Move here for no folder</span></div>` + branch(null) + (!feeds.length && !folders.length ? '<p class="library-hint">Add a feed or create a folder above.</p>' : '');
  tree.querySelectorAll('.library-row').forEach(row => {
    row.oncontextmenu = e => openLibraryMenu(e, row.dataset.kind, row.dataset.id);
    row.ondragstart = e => { libraryDrag = { kind: row.dataset.kind, id: row.dataset.id }; e.dataTransfer.setData('text/plain', row.dataset.id); e.dataTransfer.effectAllowed = 'move'; };
    const handle = row.querySelector('.library-drag-handle');
    handle.onpointerdown = e => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault(); handle.setPointerCapture(e.pointerId);
      libraryDrag = { kind: row.dataset.kind, id: row.dataset.id };
      row.classList.add('dragging');
    };
    handle.onpointermove = e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      highlightLibraryDrop(document.elementFromPoint(e.clientX, e.clientY)?.closest('.library-row, .library-root-drop'), e.clientY);
      const bounds = tree.getBoundingClientRect();
      if (e.clientY < bounds.top + 40) tree.scrollTop -= 18;
      if (e.clientY > bounds.bottom - 40) tree.scrollTop += 18;
    };
    handle.onpointerup = e => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      handle.releasePointerCapture(e.pointerId); row.classList.remove('dragging');
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (target) { const drop = new Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(drop, 'clientY', { value: e.clientY }); target.dispatchEvent(drop); }
      libraryDrag = null;
    };
    handle.onpointercancel = () => { libraryDrag = null; row.classList.remove('dragging'); clearLibraryDrop(); };
  });
}
function libraryIcon(kind) {
  const path = kind === 'folder' ? '<path d="M3 7V5h6l2 2h10v12H3z"/>' : '<circle cx="5" cy="19" r="1"/><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/>';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
function closeLibraryMenu() { document.getElementById('library-menu').hidden = true; }
function openLibraryMenu(event, kind, id) {
  event.preventDefault(); event.stopPropagation();
  const menu = document.getElementById('library-menu');
  menu.innerHTML = (kind === 'folder' ? `<button role="menuitem" onclick="closeLibraryMenu();showFeedForm('${id}')">Add feed here</button><button role="menuitem" onclick="editLibraryItem('folder',null,'edit','${id}')">New subfolder</button>` : '') + `<button role="menuitem" onclick="editLibraryItem('${kind}','${id}')">${kind === 'feed' ? 'Edit' : 'Rename'}</button><button role="menuitem" onclick="editLibraryItem('${kind}','${id}','move')">Move to folder…</button><button role="menuitem" onclick="removeLibraryItem('${kind}','${id}')">Delete</button>`;
  menu.hidden = false;
  const rect = event.currentTarget.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(event.clientX || rect.left, window.innerWidth - 240)) + 'px';
  menu.style.top = Math.max(8, Math.min(event.clientY || rect.bottom, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.querySelector('button').focus();
}
function editLibraryItem(kind, id = null, mode = 'edit', parentId) {
  closeLibraryMenu();
  if (!session) { openAuthModal(); return; }
  const item = (kind === 'folder' ? folders : feeds).find(f => f.id === id);
  libraryEditing = { kind, id, mode };
  document.getElementById('library-modal-title').textContent = mode === 'move' ? 'Move to folder' : id ? (kind === 'folder' ? 'Rename folder' : 'Edit feed') : 'Create folder';
  document.getElementById('library-name-group').hidden = mode === 'move';
  document.getElementById('library-name').required = mode !== 'move';
  document.getElementById('library-name').value = item ? (kind === 'folder' ? item.name : feedTitle(id)) : '';
  document.getElementById('library-url-group').hidden = kind !== 'feed' || mode === 'move';
  document.getElementById('library-url').required = kind === 'feed' && mode !== 'move';
  document.getElementById('library-url').value = item?.url || '';
  const excluded = kind === 'folder' && id ? libraryDescendants(id) : new Set();
  const parent = document.getElementById('library-parent');
  parent.innerHTML = '<option value="">No folder</option>' + folders.filter(f => !excluded.has(f.id)).map(f => `<option value="${f.id}">${escHtml(folderPath(f.id))}</option>`).join('');
  parent.value = item ? (item.parent_id || item.folder_id || '') : (parentId || (activeFilter.startsWith('folder:') ? activeFilter.slice(7) : ''));
  document.getElementById('library-parent-group').hidden = !!id && mode !== 'move';
  document.getElementById('library-save').textContent = mode === 'move' ? 'Move' : id ? 'Save' : 'Create';
  document.getElementById('library-error').textContent = '';
  openModal('library-modal-backdrop');
}
function folderPath(id) {
  const names = [], seen = new Set();
  while (id && !seen.has(id)) { seen.add(id); const f = folders.find(x => x.id === id); if (!f) break; names.unshift(f.name); id = f.parent_id; }
  return names.join(' / ');
}
async function saveLibraryItem() {
  if (libraryBusy) return;
  const name = document.getElementById('library-name').value.trim();
  const url = document.getElementById('library-url').value.trim();
  if (!name) { document.getElementById('library-error').textContent = 'Enter a name.'; return; }
  if (libraryEditing.kind === 'feed' && !/^https?:\/\//i.test(url)) { document.getElementById('library-error').textContent = 'Enter a feed URL starting with https:// or http://.'; return; }
  libraryBusy = true;
  document.getElementById('library-save').disabled = true;
  try {
    const { kind, id, mode } = libraryEditing;
    const parent = document.getElementById('library-parent').value || null;
    const siblings = libraryChildren(parent);
    const next = id && mode !== 'move' ? siblings[siblings.findIndex(i => i.id === id) + 1] : null;
    await writeLibraryMove(kind, id, parent, next?.id === id ? null : next?.id || null, mode === 'move' ? null : name, kind === 'feed' && mode !== 'move' ? url : null);
    closeModal('library-modal-backdrop');
  } catch (error) { document.getElementById('library-error').textContent = error.message; }
  finally { libraryBusy = false; document.getElementById('library-save').disabled = false; }
}
async function writeLibraryMove(kind, id, parent, before = null, name = null, url = null) {
  if (kind !== 'feed') url = null;
  const { error } = await sb.rpc('save_library_item', { item_kind: kind, item_id: id, destination: parent, before_id: before, new_name: name, new_url: url });
  if (error) throw error;
  await loadFeeds(); saveCache(); renderLibrary(); renderArticles();
  if (parent && collapsedFolders.delete(parent)) saveFolderExpansionState();
  renderLibrary();
}
function removeLibraryItem(kind, id) {
  closeLibraryMenu();
  if (kind === 'feed') { deleteFeed(id); return; }
  document.getElementById('confirm-title').textContent = 'Delete folder?';
  document.getElementById('confirm-feed-name').textContent = folderPath(id);
  document.getElementById('confirm-description').textContent = 'Its feeds and subfolders will move to the parent folder.';
  document.getElementById('confirm-delete-btn').textContent = 'Delete folder';
  document.getElementById('confirm-delete-btn').onclick = async () => {
    const { error } = await sb.rpc('delete_library_folder', { target_id: id });
    if (error) { showToast('Could not delete folder'); return; }
    closeConfirmModal(); await loadFeeds(); renderArticles();
  };
  openModal('confirm-modal-backdrop');
}
async function loadFolderPage() {
  if (loadingMoreArticles || !session) return;
  const ids = libraryFeedIds(activeFilter.slice(7)).filter(id => feedArticlesHasMore[id]);
  const userId = session.user.id, version = articleLoadVersion;
  loadingMoreArticles = true; renderArticles();
  try {
    for (const id of ids) {
      const offset = feedArticlesOffset[id] || 0;
      const { data, error } = await sb.from('articles').select('id,feed_id,guid,link,title,summary,published_at').eq('feed_id', id).order('published_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + LOAD_MORE_PAGE_SIZE - 1);
      if (error) throw error;
      if (session?.user.id !== userId || version !== articleLoadVersion) return;
      mergeArticles(data || []); feedArticlesOffset[id] = offset + data.length; feedArticlesHasMore[id] = data.length === LOAD_MORE_PAGE_SIZE;
    }
    saveCache(); renderLibrary();
  } catch { showToast('Failed to load more'); }
  finally { loadingMoreArticles = false; renderArticles(); }
}
document.addEventListener('click', e => { if (!e.target.closest('#library-menu')) closeLibraryMenu(); });
function clearLibraryDrop() {
  document.querySelectorAll('.drop-target, .drop-before, .drop-after').forEach(el => el.classList.remove('drop-target', 'drop-before', 'drop-after'));
}
function libraryDropDestination(target, y) {
  if (!target || !libraryDrag || target.dataset.id === libraryDrag.id) return null;
  if (target.dataset.root) return { parent: null, before: null, style: 'drop-target' };
  const folder = target.dataset.kind === 'folder';
  const item = (folder ? folders : feeds).find(i => i.id === target.dataset.id);
  if (!item) return null;
  const rect = target.getBoundingClientRect();
  const ratio = (y - rect.top) / rect.height;
  const parent = item.parent_id || item.folder_id || null;
  if (folder && ratio > .25 && ratio < .75) return { parent: item.id, before: null, style: 'drop-target' };
  const after = ratio >= .5;
  const siblings = libraryChildren(parent).filter(i => i.id !== libraryDrag.id);
  const next = siblings[siblings.findIndex(i => i.id === item.id) + 1];
  return { parent, before: after ? next?.id || null : item.id, style: after ? 'drop-after' : 'drop-before' };
}
function highlightLibraryDrop(target, y) {
  clearLibraryDrop();
  const destination = libraryDropDestination(target, y);
  if (destination) target.classList.add(destination.style);
}
document.addEventListener('dragover', e => {
  const target = e.target.closest('.library-row, .library-root-drop');
  highlightLibraryDrop(target, e.clientY);
  if (target && libraryDrag) e.preventDefault();
});
document.addEventListener('drop', async e => {
  const target = e.target.closest('.library-row, .library-root-drop');
  clearLibraryDrop();
  if (!target || !libraryDrag || libraryBusy) return;
  e.preventDefault();
  const destination = libraryDropDestination(target, e.clientY);
  const { kind, id } = libraryDrag; libraryDrag = null;
  if (!destination) return;
  if (kind === 'folder' && libraryDescendants(id).has(destination.parent)) { showToast('Choose a folder outside this folder.'); return; }
  libraryBusy = true;
  try { await writeLibraryMove(kind, id, destination.parent, destination.before); }
  catch (error) { showToast(error.message); }
  finally { libraryBusy = false; }
});
document.addEventListener('dragend', () => { libraryDrag = null; clearLibraryDrop(); });
