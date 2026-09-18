const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(require.resolve('../app.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function setup({ rows = [], cap = 1000, page, write } = {}) {
  const requests = [];
  const cache = new Map();
  const client = {
    from(table) {
      assert.equal(table, 'article_reads');
      const request = { orders: [], filters: {} };
      const query = {
        select() { return this; },
        eq(column, value) { request.filters[column] = value; return this; },
        order(column) { request.orders.push(column); return this; },
        range(start, end) {
          requests.push({ ...request, start, end });
          return page ? page(start, end) : Promise.resolve({ data: rows.slice(start, Math.min(end + 1, start + cap)), error: null });
        },
        upsert() { return write ? write.promise : Promise.resolve({ error: null }); },
        delete() { return this; },
        then(resolve, reject) { return (write ? write.promise : Promise.resolve({ error: null })).then(resolve, reject); },
      };
      return query;
    },
  };
  const context = vm.createContext({
    window: { supabase: { createClient: () => client } },
    document: { addEventListener() {} },
    localStorage: { setItem: (key, value) => cache.set(key, value) },
    console: { error() {} },
  });
  vm.runInContext(source.slice(0, source.lastIndexOf('\nloadCache();')), context);
  const run = code => vm.runInContext(code, context);
  run(`
    session = { user: { id: 'user-1' } };
    renderArticles = renderFeedSidebar = showToast = () => {};
    articles = [{ id: 'article-1', feed_id: 'feed-1', guid: 'guid-1', link: 'https://example.com/1' }];
  `);
  return { run, requests, cache };
}

test('loads all markers beyond the Supabase row limit before reconciling', async () => {
  const rows = Array.from({ length: 1250 }, (_, i) => ({ feed_id: 'feed-1', guid: `guid-${String(i).padStart(4, '0')}` }));
  const { run, requests, cache } = setup({ rows });
  run(`articles = [{ id: 'last', feed_id: 'feed-1', guid: 'guid-1249' }];`);
  await run('loadReads()');
  assert.equal(run('readMarkers.size'), 1250);
  assert.equal(run("readIds.has('last')"), true);
  assert.equal(JSON.parse(cache.get('rss_read_markers_cache')).length, 1250);
  assert.deepEqual(requests.map(r => r.start), [0, 500, 1000, 1250]);
  for (const request of requests) {
    assert.deepEqual(request.orders, ['feed_id', 'guid']);
    assert.deepEqual(request.filters, { user_id: 'user-1' });
  }
});

test('continues when the server caps pages below the requested size', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ feed_id: 'feed-1', guid: `guid-${i}` }));
  const { run, requests } = setup({ rows, cap: 3 });
  await run('loadReads()');
  assert.equal(run('readMarkers.size'), 7);
  assert.deepEqual(requests.map(r => r.start), [0, 3, 6, 7]);
});

test('a failed later page leaves existing markers and cache intact', async () => {
  const { run, cache } = setup({ page: start => Promise.resolve(start === 0
    ? { data: [{ feed_id: 'feed-1', guid: 'other' }], error: null }
    : { data: null, error: { message: 'Network error' } }) });
  run("readMarkers.add('feed-1 guid-1'); recomputeReadIds(); saveCache();");
  const saved = cache.get('rss_read_markers_cache');
  await run('loadReads()');
  assert.equal(run("readIds.has('article-1')"), true);
  assert.equal(run('readMarkers.size'), 1);
  assert.equal(cache.get('rss_read_markers_cache'), saved);
});

for (const action of ['markRead', 'markAllRead', 'markUnread']) {
  test(`a stale refresh cannot undo a completed ${action}`, async () => {
    const response = deferred();
    const { run } = setup({ page: () => response.promise });
    if (action === 'markUnread') run("readMarkers.add('feed-1 guid-1'); recomputeReadIds();");
    const loading = run('loadReads()');
    await run(`${action}('article-1')`);
    response.resolve({ data: action === 'markUnread' ? [{ feed_id: 'feed-1', guid: 'guid-1' }] : [], error: null });
    await loading;
    assert.equal(run("readIds.has('article-1')"), action !== 'markUnread');
  });
}

test('protects a write that started before the refresh and completed during it', async () => {
  const response = deferred();
  const write = deferred();
  const { run } = setup({ page: () => response.promise, write });
  const saving = run("markRead('article-1')");
  const loading = run('loadReads()');
  write.resolve({ error: null });
  await saving;
  response.resolve({ data: [], error: null });
  await loading;
  assert.equal(run("readIds.has('article-1')"), true);
});

for (const action of ['markRead', 'markUnread']) {
  test(`preserves a pending ${action} while reconciling other device changes`, async () => {
    const write = deferred();
    const { run } = setup({ rows: [
      { feed_id: 'feed-1', guid: 'other-device' },
      ...(action === 'markUnread' ? [{ feed_id: 'feed-1', guid: 'guid-1' }] : []),
    ], write });
    run("readMarkers.add('feed-1 removed-on-other-device');");
    const saving = run(`${action}('article-1')`);
    await run('loadReads()');
    assert.equal(run("readIds.has('article-1')"), action === 'markRead');
    assert.equal(run("readMarkers.has('feed-1 other-device')"), true);
    assert.equal(run("readMarkers.has('feed-1 removed-on-other-device')"), false);
    write.resolve({ error: null });
    await saving;
  });
}

test('an older refresh cannot overwrite a newer refresh', async () => {
  const response = deferred();
  let calls = 0;
  const { run } = setup({ page: () => ++calls === 1 ? response.promise : Promise.resolve({ data: [], error: null }) });
  const older = run('loadReads()');
  await run('loadReads()');
  response.resolve({ data: [{ feed_id: 'feed-1', guid: 'guid-1' }], error: null });
  await older;
  assert.equal(run('readMarkers.size'), 0);
});

test('ignores read responses after the account changes', async () => {
  const response = deferred();
  const { run } = setup({ page: () => response.promise });
  run("readMarkers.add('feed-1 guid-1');");
  const loading = run('loadReads()');
  run("session = { user: { id: 'user-2' } };");
  response.resolve({ data: [], error: null });
  await loading;
  assert.equal(run("readMarkers.has('feed-1 guid-1')"), true);
});

test('a complete empty response reconciles articles marked unread on another device', async () => {
  const { run } = setup();
  run("readMarkers.add('feed-1 guid-1'); recomputeReadIds();");
  await run('loadReads()');
  assert.equal(run("readIds.has('article-1')"), false);
});
