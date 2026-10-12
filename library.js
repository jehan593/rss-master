let libraryEditing = null;
let libraryBusy = false;
let libraryDrag = null;
const collapsedFolders = new Set();

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
  if (name === 'feeds') renderManageFeeds();
  closeFeedSidebar();
}
function showFeedForm() {
  showLibrarySection('feeds');
  document.getElementById('new-feed-url').focus();
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
      ${folder ? `<button class="folder-toggle" aria-label="${collapsedFolders.has(item.id) ? 'Expand' : 'Collapse'} ${escAttr(title)}" aria-expanded="${!collapsedFolders.has(item.id)}" onclick="collapsedFolders.has('${item.id}')?collapsedFolders.delete('${item.id}'):collapsedFolders.add('${item.id}');renderLibrary()">${collapsedFolders.has(item.id) ? '▸' : '▾'}</button>` : '<span class="feed-color-dot" style="background:' + feedColor(item.id) + '"></span>'}
      <button class="library-select" onclick="setFilter('${filter}')"><span class="fs-name">${folder ? '▱ ' : ''}${escHtml(title)}</span><span class="fs-count">${unread || ''}</span></button>
      <button class="library-drag-handle" aria-label="Drag ${escAttr(title)}" title="Drag to move">⠿</button><button class="library-more" aria-label="Options for ${escAttr(title)}" onclick="openLibraryMenu(event,'${item.kind}','${item.id}')">⋮</button></div>` +
      (folder && (!collapsedFolders.has(item.id) || query) ? branch(item.id, depth + 1) : '');
  }).join('');
  tree.innerHTML = `<button class="feed-sidebar-item ${activeFilter === 'all' ? 'active' : ''}" onclick="setFilter('all')">All feeds <span class="fs-count">${count(null)}</span></button><div class="library-root-drop" data-root="true">Library · drop here to move out of a folder</div>` + branch(null) + (!feeds.length && !folders.length ? '<p class="library-hint">Add a feed or create a folder above.</p>' : '');
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
      document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
      document.elementFromPoint(e.clientX, e.clientY)?.closest('.library-row, .library-root-drop')?.classList.add('drop-target');
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
    handle.onpointercancel = () => { libraryDrag = null; row.classList.remove('dragging'); document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target')); };
  });
}
function closeLibraryMenu() { document.getElementById('library-menu').hidden = true; }
function openLibraryMenu(event, kind, id) {
  event.preventDefault(); event.stopPropagation();
  const menu = document.getElementById('library-menu');
  menu.innerHTML = `<button role="menuitem" onclick="editLibraryItem('${kind}','${id}')">${kind === 'feed' ? 'Rename / edit link' : 'Rename'}</button><button role="menuitem" onclick="editLibraryItem('${kind}','${id}')">Move…</button><button role="menuitem" onclick="removeLibraryItem('${kind}','${id}')">Delete</button>`;
  menu.hidden = false;
  const rect = event.currentTarget.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(event.clientX || rect.left, window.innerWidth - 240)) + 'px';
  menu.style.top = Math.max(8, Math.min(event.clientY || rect.bottom, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.querySelector('button').focus();
}
function editLibraryItem(kind, id = null) {
  closeLibraryMenu();
  if (!session) { openAuthModal(); return; }
  const item = (kind === 'folder' ? folders : feeds).find(f => f.id === id);
  libraryEditing = { kind, id };
  document.getElementById('library-modal-title').textContent = id ? 'Edit ' + kind : 'Create folder';
  document.getElementById('library-name').value = item ? (kind === 'folder' ? item.name : feedTitle(id)) : '';
  document.getElementById('library-url-group').hidden = kind !== 'feed';
  document.getElementById('library-url').required = kind === 'feed';
  document.getElementById('library-url').value = item?.url || '';
  const excluded = kind === 'folder' && id ? libraryDescendants(id) : new Set();
  const parent = document.getElementById('library-parent');
  parent.innerHTML = '<option value="">Library (no folder)</option>' + folders.filter(f => !excluded.has(f.id)).map(f => `<option value="${f.id}">${escHtml(folderPath(f.id))}</option>`).join('');
  parent.value = item ? (item.parent_id || item.folder_id || '') : (activeFilter.startsWith('folder:') ? activeFilter.slice(7) : '');
  parent.onchange = updateLibraryPositions;
  updateLibraryPositions();
  document.getElementById('library-error').textContent = '';
  openModal('library-modal-backdrop');
}
function folderPath(id) {
  const names = [], seen = new Set();
  while (id && !seen.has(id)) { seen.add(id); const f = folders.find(x => x.id === id); if (!f) break; names.unshift(f.name); id = f.parent_id; }
  return names.join(' / ');
}
function updateLibraryPositions() {
  const select = document.getElementById('library-before');
  select.innerHTML = '<option value="">At the end</option>' + libraryChildren(document.getElementById('library-parent').value || null).filter(i => i.id !== libraryEditing.id).map(i => `<option value="${i.id}">Before ${escHtml(i.kind === 'folder' ? i.name : feedTitle(i.id))}</option>`).join('');
  const item = libraryChildren(document.getElementById('library-parent').value || null);
  const next = item[item.findIndex(i => i.id === libraryEditing.id) + 1];
  select.value = libraryEditing.id && next && next.id !== libraryEditing.id ? next.id : '';
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
    const { kind, id } = libraryEditing;
    await writeLibraryMove(kind, id, document.getElementById('library-parent').value || null, document.getElementById('library-before').value || null, name, url);
    closeModal('library-modal-backdrop');
  } catch (error) { document.getElementById('library-error').textContent = error.message; }
  finally { libraryBusy = false; document.getElementById('library-save').disabled = false; }
}
async function writeLibraryMove(kind, id, parent, before = null, name = null, url = null) {
  const { error } = await sb.rpc('save_library_item', { item_kind: kind, item_id: id, destination: parent, before_id: before, new_name: name, new_url: url });
  if (error) throw error;
  await loadFeeds(); saveCache(); renderLibrary(); renderArticles();
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
document.addEventListener('dragover', e => {
  const target = e.target.closest('.library-row, .library-root-drop');
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
  if (target && libraryDrag) { e.preventDefault(); target.classList.add('drop-target'); }
});
document.addEventListener('drop', async e => {
  const target = e.target.closest('.library-row, .library-root-drop');
  document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
  if (!target || !libraryDrag || libraryBusy) return;
  e.preventDefault();
  const { kind, id } = libraryDrag; libraryDrag = null;
  if (target.dataset.id === id) return;
  const item = (target.dataset.kind === 'folder' ? folders : feeds).find(i => i.id === target.dataset.id);
  const into = target.dataset.kind === 'folder' && e.clientY > target.getBoundingClientRect().top + 12;
  const parent = into ? item.id : (item?.parent_id || item?.folder_id || null);
  libraryBusy = true;
  try { await writeLibraryMove(kind, id, parent, into ? null : item?.id || null); }
  catch (error) { showToast(error.message); }
  finally { libraryBusy = false; }
});
document.addEventListener('dragend', () => { libraryDrag = null; document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target')); });
